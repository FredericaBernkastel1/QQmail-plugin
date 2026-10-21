import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftJournal } from "../src/draft-journal.js";
import { DraftStore, type DraftPreview } from "../src/drafts.js";
import { KeyFileDraftProtection, MAX_CLOUD_DRAFT_BYTES, PortableDraftStorage } from "../src/cloud/storage.js";

// Fault injection belongs only in this test. Production storage has no bypass or mock options.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

type Payload = { body: string; messageId?: string };
type Binding = { profileId: string; revision: number };
const preview: DraftPreview = { to: ["synthetic@example.test"], subject: "Synthetic cloud draft", text: "Synthetic body" };
const binding: Binding = { profileId: "synthetic-cloud-account", revision: 1 };
const validate = {
  validateRecord: (record: { binding?: Binding }) => record.binding?.profileId === binding.profileId && record.binding.revision === binding.revision,
  hasAttachments: (_payload: Payload) => false,
};
const directories: string[] = [];
const storages: PortableDraftStorage[] = [];
const protections: KeyFileDraftProtection[] = [];
const journals: DraftJournal<Payload, DraftPreview, Binding>[] = [];
const stores: DraftStore<Payload, DraftPreview, Binding>[] = [];
const posixIt = process.platform === "win32" ? it.skip : it;

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "qq-mail-cloud-storage-"));
  directories.push(value);
  return value;
}
function storage(directory: string): PortableDraftStorage {
  const value = new PortableDraftStorage(directory);
  storages.push(value);
  return value;
}
function protection(key: Buffer = randomBytes(32)): KeyFileDraftProtection {
  const value = new KeyFileDraftProtection(key);
  protections.push(value);
  return value;
}
function journal(directory: string, key: Buffer) {
  const value = new DraftJournal<Payload, DraftPreview, Binding>({ storage: storage(directory), protection: protection(key) });
  journals.push(value);
  return value;
}
function store() {
  const value = new DraftStore<Payload, DraftPreview, Binding>();
  stores.push(value);
  return value;
}
afterEach(async () => {
  vi.mocked(rename).mockClear();
  for (const value of journals.splice(0)) await value.close().catch(() => undefined);
  for (const value of storages.splice(0)) await value.release().catch(() => undefined);
  protections.splice(0).forEach(value => value.dispose());
  stores.splice(0).forEach(value => value.dispose());
  for (const value of directories.splice(0)) {
    const relative = path.relative(tmpdir(), value);
    expect(relative).not.toMatch(/^\.\./u);
    expect(path.isAbsolute(relative)).toBe(false);
    // Only newly created test directories under the isolated test temporary root are removed.
    await rm(value, { recursive: true, force: true });
  }
});

describe("portable draft data-key protection", () => {
  it("wraps and unwraps a data key without exposing plaintext and uses a fresh nonce", async () => {
    const value = protection();
    const dataKey = randomBytes(32).toString("hex");
    const first = await value.protect(dataKey);
    const second = await value.protect(dataKey);
    expect(first.byteLength).toBe(68);
    expect(first.equals(second)).toBe(false);
    expect(first.includes(Buffer.from(dataKey, "hex"))).toBe(false);
    expect(first.toString("utf8")).not.toContain(dataKey);
    await expect(value.unprotect(first)).resolves.toBe(dataKey);
    await expect(value.unprotect(second)).resolves.toBe(dataKey);
  });

  it("copies the master key on construction and wipes only its own copy on disposal", async () => {
    const original = randomBytes(32);
    const retained = Buffer.from(original);
    const first = protection(original);
    original.fill(0);
    const dataKey = "ab".repeat(32);
    const ciphertext = await first.protect(dataKey);
    await expect(protection(retained).unprotect(ciphertext)).resolves.toBe(dataKey);
    first.dispose();
    first.dispose();
    await expect(first.protect(dataKey)).rejects.toMatchObject({ code: "CLOUD_DRAFT_KEY_INVALID" });
    await expect(first.unprotect(ciphertext)).rejects.toMatchObject({ code: "CLOUD_DRAFT_KEY_INVALID" });
    expect(retained.equals(Buffer.alloc(32))).toBe(false);
    retained.fill(0);
  });

  it.each([0, 1, 31, 33, 64])("rejects a %s-byte master key", length => {
    expect(() => protection(Buffer.alloc(length))).toThrow(expect.objectContaining({ code: "CLOUD_DRAFT_KEY_INVALID" }));
  });

  it("rejects non-buffer keys and non-data-key plaintext", async () => {
    expect(() => protection("a".repeat(32) as never)).toThrow(expect.objectContaining({ code: "CLOUD_DRAFT_KEY_INVALID" }));
    const value = protection();
    for (const plaintext of ["", "a".repeat(63), "A".repeat(64), "z".repeat(64), "private draft body"]) {
      await expect(value.protect(plaintext)).rejects.toMatchObject({ code: "CLOUD_DRAFT_KEY_INVALID" });
    }
  });

  it("authenticates the version, nonce, tag and ciphertext and rejects the wrong master key", async () => {
    const value = protection();
    const ciphertext = await value.protect("cd".repeat(32));
    for (const index of [0, 8, 20, 36, 67]) {
      const changed = Buffer.from(ciphertext);
      changed[index] = changed[index]! ^ 1;
      await expect(value.unprotect(changed)).rejects.toMatchObject({ code: "CLOUD_DRAFT_KEY_INVALID" });
    }
    await expect(protection().unprotect(ciphertext)).rejects.toMatchObject({ code: "CLOUD_DRAFT_KEY_INVALID" });
    await expect(value.unprotect(ciphertext.subarray(0, 67))).rejects.toMatchObject({ code: "CLOUD_DRAFT_KEY_INVALID" });
    await expect(value.unprotect(Buffer.concat([ciphertext, Buffer.alloc(1)]))).rejects.toMatchObject({ code: "CLOUD_DRAFT_KEY_INVALID" });
  });
});

describe("portable encrypted draft storage", () => {
  it("requires an operator-configured absolute directory and refuses a filesystem root", () => {
    for (const candidate of ["", "relative/state", path.parse(path.resolve(tmpdir())).root, path.join(tmpdir(), "bad\u0000state")]) {
      expect(() => new PortableDraftStorage(candidate)).toThrow(expect.objectContaining({ code: "CLOUD_DRAFT_DIRECTORY_INVALID" }));
    }
  });

  it("refuses unlocked reads and writes, creates a private state directory and supports reopening", async () => {
    const root = await directory();
    const state = path.join(root, "state");
    const value = storage(state);
    await expect(value.read()).rejects.toMatchObject({ code: "CLOUD_DRAFT_NOT_LOCKED" });
    await expect(value.write(Buffer.from("ciphertext"))).rejects.toMatchObject({ code: "CLOUD_DRAFT_NOT_LOCKED" });
    await value.acquire();
    await value.acquire();
    await expect(value.read()).resolves.toBeNull();
    await value.write(Buffer.from("synthetic encrypted envelope"));
    expect((await value.read())?.toString()).toBe("synthetic encrypted envelope");
    expect((await readdir(state)).sort()).toEqual(["drafts.enc.json", "drafts.lock"]);
    await value.release();
    await value.release();
    await expect(value.read()).rejects.toMatchObject({ code: "CLOUD_DRAFT_NOT_LOCKED" });
    const reopened = storage(state);
    await reopened.acquire();
    expect((await reopened.read())?.toString()).toBe("synthetic encrypted envelope");
  });

  it("serializes writes and keeps only complete envelopes", async () => {
    const state = await directory();
    const value = storage(state);
    await value.acquire();
    const first = Buffer.alloc(1_024 * 1_024, 0x41);
    const second = Buffer.alloc(1_024 * 1_024, 0x42);
    await Promise.all([value.write(first), value.write(second)]);
    expect((await value.read())?.equals(second)).toBe(true);
    expect((await readdir(state)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects oversized writes before replacement and oversized files before allocation", async () => {
    const state = await directory();
    const value = storage(state);
    await value.acquire();
    await value.write(Buffer.from("preserved old encrypted envelope"));
    const tooLarge = Buffer.alloc(MAX_CLOUD_DRAFT_BYTES + 1);
    await expect(value.write(tooLarge)).rejects.toMatchObject({ code: "CLOUD_DRAFT_TOO_LARGE" });
    expect((await value.read())?.toString()).toBe("preserved old encrypted envelope");
    tooLarge.fill(0);
    const file = await open(path.join(state, "drafts.enc.json"), "r+");
    try { await file.truncate(MAX_CLOUD_DRAFT_BYTES + 1); } finally { await file.close(); }
    await expect(value.read()).rejects.toMatchObject({ code: "CLOUD_DRAFT_FILE_INVALID" });
  });

  it("preserves the old ciphertext and removes its temporary file when rename fails", async () => {
    const state = await directory();
    const value = storage(state);
    await value.acquire();
    const old = Buffer.from("old complete encrypted envelope");
    await value.write(old);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("synthetic rename failure"), { code: "EACCES" }));
    await expect(value.write(Buffer.from("new envelope"))).rejects.toMatchObject({ code: "CLOUD_DRAFT_STORAGE_UNAVAILABLE" });
    expect((await value.read())?.equals(old)).toBe(true);
    expect((await readdir(state)).sort()).toEqual(["drafts.enc.json", "drafts.lock"]);
    await value.write(Buffer.from("new complete encrypted envelope"));
    expect((await value.read())?.toString()).toBe("new complete encrypted envelope");
  });

  it("excludes another live storage owner and allows it after the owner releases", async () => {
    const state = await directory();
    const first = storage(state), second = storage(state);
    await first.acquire();
    await expect(second.acquire()).rejects.toMatchObject({ code: "CLOUD_DRAFT_LOCK_UNAVAILABLE" });
    await first.write(Buffer.from("owned ciphertext"));
    await first.release();
    await second.acquire();
    expect((await second.read())?.toString()).toBe("owned ciphertext");
  });

  it("retains an unverifiable lock without deleting or replacing it", async () => {
    const state = await directory();
    const lockFile = path.join(state, "drafts.lock");
    await writeFile(lockFile, "unknown operator-owned lock", { mode: 0o600 });
    await expect(storage(state).acquire()).rejects.toMatchObject({ code: "CLOUD_DRAFT_LOCK_UNAVAILABLE" });
    expect(await readFile(lockFile, "utf8")).toBe("unknown operator-owned lock");
    expect((await readdir(state)).sort()).toEqual(["drafts.lock"]);
  });

  it("fails closed if its lock metadata is changed and does not remove the replacement", async () => {
    const state = await directory();
    const value = storage(state);
    await value.acquire();
    const lockFile = path.join(state, "drafts.lock");
    await writeFile(lockFile, "different lock owner metadata", { mode: 0o600 });
    await expect(value.read()).rejects.toMatchObject({ code: "CLOUD_DRAFT_LOCK_CHANGED" });
    await expect(value.write(Buffer.from("must not be saved"))).rejects.toMatchObject({ code: "CLOUD_DRAFT_LOCK_CHANGED" });
    await expect(value.release()).rejects.toMatchObject({ code: "CLOUD_DRAFT_LOCK_CHANGED" });
    expect(await readFile(lockFile, "utf8")).toBe("different lock owner metadata");
  });

  it("rejects a directory symlink or junction before creating files in its target", async () => {
    const root = await directory();
    const target = path.join(root, "target");
    const redirect = path.join(root, "redirect");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, redirect, process.platform === "win32" ? "junction" : "dir");
    try {
      await expect(storage(redirect).acquire()).rejects.toMatchObject({ code: "CLOUD_DRAFT_DIRECTORY_INVALID" });
      expect(await readdir(target)).toEqual([]);
      await expect(storage(path.join(redirect, "nested")).acquire()).rejects.toMatchObject({ code: "CLOUD_DRAFT_DIRECTORY_INVALID" });
      expect(await readdir(target)).toEqual([]);
    } finally {
      // Remove the exact link created by this test before recursive cleanup can remove
      // its target. A dangling Windows junction can otherwise leave the parent nonempty.
      if (process.platform === "win32") await rmdir(redirect);
      else await unlink(redirect);
    }
  });

  posixIt("rejects symlink journal and lock files without modifying their targets", async () => {
    const root = await directory();
    const state = path.join(root, "state");
    const target = path.join(root, "outside-ciphertext");
    await writeFile(target, "preserved outside synthetic ciphertext", { mode: 0o600 });
    const value = storage(state);
    await value.acquire();
    await symlink(target, path.join(state, "drafts.enc.json"));
    await expect(value.read()).rejects.toMatchObject({ code: "CLOUD_DRAFT_FILE_INVALID" });
    await expect(value.write(Buffer.from("replacement"))).rejects.toMatchObject({ code: "CLOUD_DRAFT_FILE_INVALID" });
    await value.release();
    await symlink(target, path.join(state, "drafts.lock"));
    await expect(value.acquire()).rejects.toMatchObject({ code: "CLOUD_DRAFT_FILE_INVALID" });
    expect(await readFile(target, "utf8")).toBe("preserved outside synthetic ciphertext");
  });

  posixIt("enforces 0700 on only the configured state directory and 0600 on its files", async () => {
    const root = await directory();
    await chmod(root, 0o755);
    const state = path.join(root, "mounted-state");
    await mkdir(state, { mode: 0o755 });
    const value = storage(state);
    await value.acquire();
    await value.write(Buffer.from("private envelope"));
    expect((await lstat(root)).mode & 0o7777).toBe(0o755);
    expect((await lstat(state)).mode & 0o7777).toBe(0o700);
    expect((await lstat(path.join(state, "drafts.enc.json"))).mode & 0o7777).toBe(0o600);
    expect((await lstat(path.join(state, "drafts.lock"))).mode & 0o7777).toBe(0o600);
    await chmod(path.join(state, "drafts.enc.json"), 0o644);
    await expect(value.read()).rejects.toMatchObject({ code: "CLOUD_DRAFT_PERMISSIONS_INVALID" });
  });
});

describe("cloud protection composed with the existing draft journal", () => {
  it("reopens encrypted ordinary drafts with the same operator key", async () => {
    const state = await directory();
    const key = randomBytes(32);
    const source = store();
    const first = journal(state, key);
    await first.attach(source, validate);
    const draft = source.prepare({ body: "SYNTHETIC_PRIVATE_CLOUD_DRAFT_BODY" }, preview, [], undefined, binding);
    await source.flush();
    const encrypted = await readFile(path.join(state, "drafts.enc.json"), "utf8");
    expect(encrypted).not.toContain("SYNTHETIC_PRIVATE_CLOUD_DRAFT_BODY");
    expect(encrypted).not.toContain(binding.profileId);
    expect(encrypted).not.toContain(key.toString("hex"));
    await first.close();
    const restored = store();
    const reopened = journal(state, key);
    expect(await reopened.attach(restored, validate)).toEqual({ restored: 1, invalidatedAttachments: 0 });
    expect(restored.getPayload(draft.draftId).body).toBe("SYNTHETIC_PRIVATE_CLOUD_DRAFT_BODY");
    key.fill(0);
  });

  it("rejects a wrong operator key without overwriting the old encrypted journal", async () => {
    const state = await directory();
    const source = store();
    const first = journal(state, randomBytes(32));
    await first.attach(source, validate);
    source.prepare({ body: "preserved synthetic plaintext" }, preview, [], undefined, binding);
    await source.flush();
    await first.close();
    const previous = await readFile(path.join(state, "drafts.enc.json"));
    await expect(journal(state, randomBytes(32)).attach(store(), validate)).rejects.toMatchObject({ code: "DRAFT_PERSISTENCE_FAILED" });
    expect((await readFile(path.join(state, "drafts.enc.json"))).equals(previous)).toBe(true);
  });

  it("rejects a modified journal authentication tag", async () => {
    const state = await directory();
    const key = randomBytes(32);
    const first = journal(state, key);
    await first.attach(store(), validate);
    await first.close();
    const file = path.join(state, "drafts.enc.json");
    const envelope = JSON.parse(await readFile(file, "utf8"));
    const tag = Buffer.from(envelope.tag, "base64");
    tag[0] = tag[0]! ^ 1;
    envelope.tag = tag.toString("base64");
    await writeFile(file, JSON.stringify(envelope), { mode: 0o600 });
    await expect(journal(state, key).attach(store(), validate)).rejects.toMatchObject({ code: "DRAFT_PERSISTENCE_FAILED" });
    key.fill(0);
  });

  it("recovers the persisted pre-send crash marker as unknown and never dispatches it again", async () => {
    const state = await directory(), recoveredState = await directory();
    const key = randomBytes(32);
    const source = store();
    const first = journal(state, key);
    await first.attach(source, validate);
    const draft = source.prepare({ body: "synthetic body", messageId: "<fixed-cloud@example.test>" }, preview, [], undefined, binding);
    const send = vi.fn(async () => {
      // Copy only the synthetic ciphertext durably recorded before this callback. This models
      // a restarted server reading the crash boundary without killing the test process.
      const crashEnvelope = await readFile(path.join(state, "drafts.enc.json"));
      await writeFile(path.join(recoveredState, "drafts.enc.json"), crashEnvelope, { mode: 0o600 });
      const restored = store();
      const recovered = journal(recoveredState, key);
      await recovered.attach(restored, validate);
      expect(restored.status(draft.draftId)).toMatchObject({ status: "delivery_unknown", result: { messageId: "<fixed-cloud@example.test>" } });
      const blocked = { send: vi.fn(), saveSentCopy: vi.fn() };
      await expect(restored.send(draft.draftId, blocked)).resolves.toMatchObject({ status: "delivery_unknown", sent: null });
      expect(blocked.send).not.toHaveBeenCalled();
      expect(blocked.saveSentCopy).not.toHaveBeenCalled();
      return { messageId: "<fixed-cloud@example.test>" };
    });
    await source.send(draft.draftId, { send, saveSentCopy: vi.fn(async () => undefined) });
    expect(send).toHaveBeenCalledOnce();
    key.fill(0);
  });
});
