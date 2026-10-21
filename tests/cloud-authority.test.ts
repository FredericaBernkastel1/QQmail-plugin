import { describe, expect, it, vi } from "vitest";
import { CloudAuthority } from "../src/cloud/authority.js";
import { cloudConfigSchema, cloudMailAccount } from "../src/cloud/config.js";

const now = Date.parse("2026-10-21T00:00:00Z");
const policy = { consentId: "synthetic-consent-id", expiresAt: new Date(now + 3600_000).toISOString(), actions: ["edit_draft", "send", "trash", "flags"] as const, recipients: ["allowed@example.test"], maxOperations: 5 };
const principal = { subject: "owner", clientId: "dot", scopes: ["mail.read", "mail.drafts.read", "mail.authorize", "mail.send", "mail.drafts.write", "mail.trash", "mail.flags.write"], expiresAt: now + 600_000 };
const request = { accountEmail: "synthetic@example.test", actions: ["send"] as const, recipients: ["allowed@example.test"], messageRefs: [], maxOperations: 2, expiresInSeconds: 60, createdAt: now, expiresAt: now + 60_000, purpose: "Synthetic owner-authorized task" };
const makePolicy = () => ({ ...policy, actions: [...policy.actions] });
describe("cloud OAuth authority", () => {
  it("exposes only mail and permitted draft reads without standing owner consent", async () => {
    const reserve = vi.fn(); const auth = new CloudAuthority(undefined, reserve, () => now);
    await auth.run(principal, async () => { expect([...auth.tools()]).toHaveLength(8); await expect(auth.approve(request)).rejects.toMatchObject({ code: "OWNER_DELEGATION_REQUIRED" }); });
    expect(reserve).not.toHaveBeenCalled();
  });
  it("requires current OAuth scope and owner rule, not a caller approval flag", async () => {
    const reserve = vi.fn(async () => undefined); const auth = new CloudAuthority(makePolicy(), reserve, () => now);
    await auth.run({ ...principal, scopes: ["mail.read"] }, async () => { expect(auth.tools().has("send_email")).toBe(false); await expect(auth.approve(request)).rejects.toMatchObject({ code: "OAUTH_SCOPE_REQUIRED" }); });
    expect(reserve).not.toHaveBeenCalled();
  });
  it("durably reserves the entire requested budget before approving", async () => {
    const reserve = vi.fn(async () => undefined); const auth = new CloudAuthority(makePolicy(), reserve, () => now);
    await auth.run(principal, async () => expect(await auth.approve(request)).toEqual({ status: "approved" }));
    expect(reserve).toHaveBeenCalledExactlyOnceWith(2);
  });
  it("rejects extra recipients and authorization beyond token lifetime", async () => {
    const reserve = vi.fn(); const auth = new CloudAuthority(makePolicy(), reserve, () => now);
    await auth.run(principal, async () => { await expect(auth.approve({ ...request, recipients: ["outside@example.test"] })).rejects.toThrow(); await expect(auth.approve({ ...request, expiresAt: principal.expiresAt + 1 })).rejects.toThrow(); });
    expect(reserve).not.toHaveBeenCalled();
  });
  it("fails closed when the persistent budget cannot commit", async () => {
    const auth = new CloudAuthority(makePolicy(), async () => { throw new Error("storage failure"); }, () => now);
    await auth.run(principal, async () => expect(auth.approve(request)).rejects.toThrow("storage failure"));
  });
  it("rechecks expiration after budget persistence and before later writes", async () => {
    let time = now; const auth = new CloudAuthority(makePolicy(), async () => { time = principal.expiresAt; }, () => time);
    await auth.run(principal, async () => { await expect(auth.approve(request)).rejects.toMatchObject({ code: "OAUTH_SCOPE_REQUIRED" }); expect(() => auth.assertWrite("send")).toThrow(); });
  });
  it("isolates simultaneous request scopes and rejects calls outside a request", async () => {
    const auth = new CloudAuthority(makePolicy(), vi.fn(), () => now);
    await Promise.all([auth.run(principal, async () => { await Promise.resolve(); expect(auth.tools().has("send_email")).toBe(true); }), auth.run({ ...principal, scopes: ["mail.read"] }, async () => { await Promise.resolve(); expect(auth.tools().has("send_email")).toBe(false); })]);
    expect(() => auth.assertWrite("send")).toThrow();
  });
  it("rejects writes after client cancellation even while OAuth and the grant remain valid", async () => {
    const controller = new AbortController();
    const auth = new CloudAuthority(makePolicy(), async () => { controller.abort(); }, () => now);
    await auth.run(principal, async () => {
      await expect(auth.approve(request)).rejects.toMatchObject({ code: "OAUTH_SCOPE_REQUIRED" });
      expect(() => auth.assertWrite("send")).toThrow();
      expect(() => auth.tools()).toThrow();
    }, controller.signal);
  });
});

describe("cloud configuration", () => {
  const config = { schemaVersion: 1, publicUrl: "https://mail.example.test/mcp", oauth: { issuer: "https://login.example.test", jwksUrl: "https://login.example.test/jwks", ownerSubject: "owner", clientId: "dot" }, mailbox: { email: "synthetic@example.test", authorizationCode: "synthetic-test-only", imap: { host: "imap.example.test", port: 993, security: "tls" }, smtp: { host: "smtp.example.test", port: 465, security: "tls" }, folders: { inbox: "INBOX", sent: "Sent", trash: "Trash" } }, stateDirectory: process.cwd(), masterKeyBase64: Buffer.alloc(32, 42).toString("base64") };
  it("has no Windows attachment path or filesystem upload capability", () => {
    const parsed = cloudConfigSchema.parse(config);
    expect(cloudMailAccount(parsed)).toMatchObject({ attachmentsDisabled: true, downloadDirectory: "" });
    expect(parsed.delegation).toBeUndefined();
  });
  it("rejects unknown options, non-TLS issuer and malformed encryption key", () => {
    for (const value of [{ ...config, approved: true }, { ...config, publicUrl: "http://mail.example.test/mcp" }, { ...config, masterKeyBase64: "short" }]) expect(cloudConfigSchema.safeParse(value).success).toBe(false);
  });
  it("normalizes recipient domains while preserving the local part's exact scope", () => {
    const parsed = cloudConfigSchema.parse({ ...config, delegation: { ...makePolicy(), recipients: ["Allowed@EXAMPLE.TEST"] } });
    expect(parsed.delegation!.recipients).toEqual(["Allowed@example.test"]);
  });
});
