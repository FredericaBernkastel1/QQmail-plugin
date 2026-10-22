import { webcrypto, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsServer } from "../src/settings/server.js";
import type { SettingsCallbacks } from "../src/settings/types.js";
import { AccountStore } from "../src/account-store.js";
import { createConfig } from "../src/config.js";
import { createSettingsCallbacks } from "../src/settings/callbacks.js";

const servers: SettingsServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const template = '{"token":__QQ_MAIL_SESSION_TOKEN__,"key":__QQ_MAIL_BRIDGE_KEY__}';
const revision = "a".repeat(36);
const callbacks = (): SettingsCallbacks => ({
  getConfig: vi.fn(), getStatus: vi.fn(), test: vi.fn(), save: vi.fn(), clear: vi.fn(),
  setCredential: vi.fn(async () => ({ ok: true, message: "saved" })),
});
async function setup(overrides: Partial<SettingsCallbacks> = {}, options: { now?: () => number; sessionTtlMs?: number } = {}) {
  const cb = { ...callbacks(), ...overrides };
  const server = await new SettingsServer({ callbacks: cb, html: template, ...options }).start();
  servers.push(server);
  return { server, cb, bootstrap: JSON.parse(await server.renderAppHtml()) };
}
async function seal(bootstrap: { key: string; token: string }, changes: Record<string, unknown> = {}) {
  const publicKey = await webcrypto.subtle.importKey("spki", Buffer.from(bootstrap.key, "base64"),
    { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = webcrypto.getRandomValues(new Uint8Array(32)), iv = webcrypto.getRandomValues(new Uint8Array(12));
  const aes = await webcrypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const plain = { token: bootstrap.token, requestId: randomUUID(), method: "POST", path: "/api/credential",
    body: "SYNTHETIC_AUTH_CODE", headers: { "content-type": "application/octet-stream", "x-qq-mail-account-revision": revision }, ...changes };
  return {
    key: Buffer.from(await webcrypto.subtle.encrypt("RSA-OAEP", publicKey, key)).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv,
      additionalData: Buffer.from("qq-mail-settings-v1") }, aes, Buffer.from(JSON.stringify(plain)))).toString("base64"),
  };
}
const signal = () => new AbortController().signal;
describe("embedded encrypted settings", () => {
  it("decrypts only at the local server and does not return credentials", async () => {
    const { server, cb, bootstrap } = await setup();
    const envelope = await seal(bootstrap);
    expect(JSON.stringify(envelope)).not.toContain("SYNTHETIC_AUTH_CODE");
    expect(JSON.stringify(envelope)).not.toContain(bootstrap.token);
    const result = await server.requestFromApp(envelope, signal());
    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(cb.setCredential).toHaveBeenCalledWith("SYNTHETIC_AUTH_CODE", expect.objectContaining({ signal: expect.any(AbortSignal) }), revision);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_AUTH_CODE");
  });
  it("rejects replay before a second callback", async () => {
    const { server, cb, bootstrap } = await setup();
    const envelope = await seal(bootstrap);
    expect((await server.requestFromApp(envelope, signal())).status).toBe(200);
    expect((await server.requestFromApp(envelope, signal())).status).toBe(409);
    expect(cb.setCredential).toHaveBeenCalledOnce();
  });
  it("rejects expired and browser-only sessions", async () => {
    let now = 0;
    const { server, cb, bootstrap } = await setup({}, { now: () => now, sessionTtlMs: 100 });
    expect((await server.requestFromApp(await seal(bootstrap, { token: server.createSession().token }), signal())).status).toBe(401);
    now = 101;
    expect((await server.requestFromApp(await seal(bootstrap), signal())).status).toBe(401);
    expect(cb.setCredential).not.toHaveBeenCalled();
  });
  it("rejects ciphertext tampering and another process key without leaking errors", async () => {
    const one = await setup(), two = await setup();
    const envelope = await seal(one.bootstrap);
    const bytes = Buffer.from(envelope.ciphertext, "base64"); bytes[0] = bytes[0]! ^ 1;
    expect((await one.server.requestFromApp({ ...envelope, ciphertext: bytes.toString("base64") }, signal())).status).toBe(400);
    expect((await two.server.requestFromApp(envelope, signal())).status).toBe(400);
    expect(one.cb.setCredential).not.toHaveBeenCalled(); expect(two.cb.setCredential).not.toHaveBeenCalled();
  });
  it.each([
    { path: "https://outside.example.test/api/credential" }, { path: "C:\\secret" },
    { approved: true }, { method: "DELETE" }, { headers: { command: "SYNTHETIC_NO_EXEC" } },
  ])("rejects non-settings operations and undeclared inner fields: %j", async changes => {
    const { server, cb, bootstrap } = await setup();
    expect((await server.requestFromApp(await seal(bootstrap, changes), signal())).status).toBe(400);
    expect(cb.setCredential).not.toHaveBeenCalled();
  });
  it("reuses HTTP credential validation and sanitizes callback failures", async () => {
    const { server, cb, bootstrap } = await setup({ setCredential: vi.fn(async () => { throw Error("SYNTHETIC_AUTH_CODE"); }) });
    expect((await server.requestFromApp(await seal(bootstrap, { body: "bad\nvalue" }), signal())).status).toBe(400);
    expect(cb.setCredential).not.toHaveBeenCalled();
    const result = await server.requestFromApp(await seal(bootstrap), signal());
    expect(result.status).toBe(500); expect(JSON.stringify(result)).not.toContain("SYNTHETIC_AUTH_CODE");
  });
  it("does not dispatch cancelled requests and aborts pending work on shutdown", async () => {
    const { server, cb, bootstrap } = await setup({ setCredential: vi.fn(async (_code, context) => {
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, message: "cancelled" };
    }) });
    const controller = new AbortController(); controller.abort();
    expect((await server.requestFromApp(await seal(bootstrap), controller.signal)).status).toBe(409);
    expect(cb.setCredential).not.toHaveBeenCalled();
    const pending = server.requestFromApp(await seal(bootstrap), signal());
    await vi.waitFor(() => expect(cb.setCredential).toHaveBeenCalledOnce());
    await server.close(); expect((await pending).body).toMatchObject({ ok: false });
  });
  it("still requires native approval and rejects a revision changed during that approval", async () => {
    let raw: string | null = null;
    const store = new AccountStore({ storage: { read: async () => raw, compareAndSwap: async (expected, next) => {
      if (raw !== expected) throw Error("conflict"); raw = next;
    } }, protection: { protect: async plain => Buffer.from(plain), unprotect: async cipher => cipher.toString() }, legacyConfig: async () => null });
    const config = createConfig({ preset: "personal", email: "synthetic@qq.com" });
    await store.saveConfig(config, (await store.snapshot()).revision);
    const confirm = vi.fn(async () => false);
    const cb = createSettingsCallbacks({ accountStore: store, settingsApproval: { confirm },
      imapGateway: { connect: vi.fn() }, smtpGateway: { verify: vi.fn(), send: vi.fn() } });
    const { server, bootstrap } = await setup(cb);
    const headers = { "content-type": "application/octet-stream", "x-qq-mail-account-revision": (await store.snapshot()).revision };
    expect((await server.requestFromApp(await seal(bootstrap, { headers }), signal())).body).toMatchObject({ ok: false });
    expect(await (await store.snapshot()).unlock()).toBeUndefined();
    confirm.mockImplementation(async () => { await store.saveConfig(config, (await store.snapshot()).revision); return true; });
    expect((await server.requestFromApp(await seal(bootstrap, { headers }), signal())).body).toMatchObject({ ok: false });
    expect(await (await store.snapshot()).unlock()).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
