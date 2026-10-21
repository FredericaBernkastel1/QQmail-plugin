import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountStore, FileAccountStateStorage, accountIdentity } from "../src/account-store.js";
import { acquireOwnedFileLock } from "../src/local-lock.js";
import { createAccountProfileServices } from "../src/profile-service.js";
import { memoryStore, syntheticConfig } from "./account-fixtures.js";

const directories: string[] = [];
async function directory() { const value = await mkdtemp(path.join(tmpdir(), "qqmail-profiles-")); directories.push(value); return value; }
afterEach(async () => { await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true }))); });
const protection = { protect: async (plain: string) => Buffer.from(plain), unprotect: async (cipher: Buffer) => cipher.toString() };
const acl = { runner: async () => ({ exitCode: 0 }) };

describe("saved account profiles", () => {
  it("migrates a bound version 1 account without modifying its original file or losing its credential", async () => {
    const root = await directory();
    const config = syntheticConfig();
    const original = JSON.stringify({ version: 1, revision: randomUUID(), config,
      ciphertext: Buffer.from(JSON.stringify({ accountId: accountIdentity(config), secret: "SYNTHETIC_A" })).toString("base64") });
    await writeFile(path.join(root, "account.json"), original);
    const store = new AccountStore({ directory: root, protection, acl });
    const before = await store.snapshot();
    expect(await before.unlock()).toBe("SYNTHETIC_A");
    await store.saveConfig(config, before.revision);
    expect(await readFile(path.join(root, "account.json"), "utf8")).toBe(original);
    expect(JSON.parse(await readFile(path.join(root, "account-profiles.json"), "utf8")).version).toBe(2);
    const after = await new AccountStore({ directory: root, protection, acl }).snapshot();
    expect(after.profileId).toBe(before.profileId);
    expect(after.scope).not.toBe(before.scope);
    expect(await after.unlock()).toBe("SYNTHETIC_A");
  });

  it("keeps each credential paired and never reuses scope after A to B to A", async () => {
    const { store, restart } = memoryStore(syntheticConfig());
    await store.setCredential("SYNTHETIC_A", (await store.snapshot()).revision);
    const a = await store.snapshot();
    const created = await store.createProfile("Work", syntheticConfig("work@qq.com"), a.revision);
    expect(await (await store.snapshot()).unlock()).toBeUndefined();
    await store.setCredential("SYNTHETIC_B", created.revision);
    await store.switchProfile(a.profileId!, (await store.snapshot()).revision);
    const returned = await restart().snapshot();
    expect(returned.config?.email).toBe(a.config?.email);
    expect(await returned.unlock()).toBe("SYNTHETIC_A");
    expect(returned.scope).not.toBe(a.scope);
    expect(await a.unlock()).toBe("SYNTHETIC_A");
    await store.switchProfile(created.profileId, returned.revision);
    expect(await (await store.snapshot()).unlock()).toBe("SYNTHETIC_B");
    const publicProfiles = await store.listProfiles();
    expect(JSON.stringify(publicProfiles)).not.toMatch(/SYNTHETIC|ciphertext|smtp|imap/);
  });

  it("requires an explicit replacement for deleting the active profile and does not resurrect legacy data", async () => {
    const { store } = memoryStore(syntheticConfig());
    const a = await store.snapshot();
    const b = await store.createProfile("Work", syntheticConfig("work@qq.com"), a.revision);
    await expect(store.deleteProfile(b.profileId, b.revision)).rejects.toMatchObject({ code: "PROFILE_REPLACEMENT_REQUIRED" });
    await store.deleteProfile(b.profileId, b.revision, a.profileId!);
    expect((await store.snapshot()).profileId).toBe(a.profileId);
    await store.deleteProfile(a.profileId!, (await store.snapshot()).revision);
    expect((await store.snapshot()).config).toBeNull();
    expect((await store.listProfiles()).profiles).toEqual([]);
  });

  it("rejects a stale profile operation after another writer changes the active account", async () => {
    const { store } = memoryStore(syntheticConfig());
    const a = await store.snapshot();
    await store.createProfile("Work", syntheticConfig("work@qq.com"), a.revision);
    await expect(store.deleteProfile(a.profileId!, a.revision)).rejects.toMatchObject({ code: "ACCOUNT_STATE_CHANGED" });
    expect((await store.listProfiles()).profiles).toHaveLength(2);
  });

  it("requires trusted MCP switching approval and rejects a revision changed during that approval", async () => {
    const { store } = memoryStore(syntheticConfig());
    const a = await store.snapshot();
    const b = await store.createProfile("Work", syntheticConfig("work@qq.com"), a.revision);
    const denied = createAccountProfileServices({ accounts: store, approval: { confirm: async () => false } });
    await expect(denied.switchAccount({ profileId: a.profileId! })).rejects.toMatchObject({ code: "ACCOUNT_APPROVAL_REQUIRED" });
    expect((await store.snapshot()).profileId).toBe(b.profileId);
    const approve = vi.fn(async () => {
      await store.setCredential("SYNTHETIC_B", (await store.snapshot()).revision);
      return true;
    });
    const changed = createAccountProfileServices({ accounts: store, approval: { confirm: approve } });
    await expect(changed.switchAccount({ profileId: a.profileId! })).rejects.toMatchObject({ code: "ACCOUNT_STATE_CHANGED" });
    expect(approve).toHaveBeenCalledOnce();
    expect((await store.snapshot()).profileId).toBe(b.profileId);
  });
});

describe("verified owner lock recovery", () => {
  const stale = () => JSON.stringify({ version: 1, pid: 1234567, token: randomUUID(), createdAt: "2020-01-01T00:00:00.000Z" });
  it("recognizes an actually exited process through the production liveness probe", async () => {
    const pid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
      child.once("error", reject); child.once("exit", () => resolve(child.pid!));
    });
    const root = await directory(), file = path.join(root, "account.lock");
    await writeFile(file, JSON.stringify({ version: 1, pid, token: randomUUID(), createdAt: new Date().toISOString() }));
    const lock = await acquireOwnedFileLock(file);
    expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });
  it("reclaims a verified dead owner and writes through the account compare-and-swap", async () => {
    const root = await directory();
    await writeFile(path.join(root, "account.lock"), stale());
    const store = new FileAccountStateStorage({ directory: root, acl }, () => "dead");
    await store.compareAndSwap(null, "next");
    expect(await store.read()).toBe("next");
    await expect(readFile(path.join(root, "account.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["alive", "unknown"] as const)("refuses a %s owner without changing the lock", async state => {
    const root = await directory(), file = path.join(root, "account.lock"), original = stale();
    await writeFile(file, original);
    await expect(acquireOwnedFileLock(file, { ownerState: () => state })).rejects.toMatchObject({ code: "LOCK_BUSY" });
    expect(await readFile(file, "utf8")).toBe(original);
  });
  it("does not infer death from age or remove an ownerless legacy lock", async () => {
    const root = await directory(), file = path.join(root, "account.lock");
    await writeFile(file, "legacy lock");
    const probe = vi.fn(() => "dead" as const);
    await expect(acquireOwnedFileLock(file, { ownerState: probe })).rejects.toMatchObject({ code: "LOCK_UNVERIFIABLE" });
    expect(probe).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("legacy lock");
  });
  it("refuses recovery when the owner record changes during verification", async () => {
    const root = await directory(), file = path.join(root, "account.lock");
    await writeFile(file, stale());
    const replacement = stale();
    await expect(acquireOwnedFileLock(file, { ownerState: () => {
      writeFileSync(file, replacement); return "dead";
    } })).rejects.toMatchObject({ code: "LOCK_CHANGED" });
    expect(await readFile(file, "utf8")).toBe(replacement);
  });
  it("does not release a different owner's replacement lock", async () => {
    const root = await directory(), file = path.join(root, "account.lock");
    const lock = await acquireOwnedFileLock(file);
    const replacement = stale(); await writeFile(file, replacement);
    await expect(lock.release()).rejects.toMatchObject({ code: "LOCK_CHANGED" });
    expect(await readFile(file, "utf8")).toBe(replacement);
  });
});
