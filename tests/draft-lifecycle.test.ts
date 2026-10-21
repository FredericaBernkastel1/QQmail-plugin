import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DraftError, DraftStore, type DraftPreview, type DraftSnapshot } from "../src/drafts.js";
import { DraftJournal, type DraftJournalStorage } from "../src/draft-journal.js";

type Payload = { body: string; messageId?: string; attachmentIds?: string[] };
type Binding = { profileId: string; revision: number; scope: string };
const binding: Binding = { profileId: "profile-synthetic", revision: 3, scope: "scope-synthetic-v3" };
const preview: DraftPreview = { to: ["synthetic@example.test"], subject: "Synthetic draft", text: "body" };
const stores: DraftStore<Payload, DraftPreview, Binding>[] = [];
function store(options: ConstructorParameters<typeof DraftStore>[0] = {}) {
  const value = new DraftStore<Payload, DraftPreview, Binding>(options);
  stores.push(value);
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { stores.splice(0).forEach(value => value.dispose()); vi.useRealTimers(); });

describe("bounded draft lifecycle", () => {
  it("bounds record count without evicting a sending draft, even after its expiry", async () => {
    let now = Date.now();
    const value = store({ now: () => now, ttlMs: 100, maxDrafts: 1 });
    const draft = value.prepare({ body: "body" }, preview, [], undefined, binding);
    const gate = deferred<{ messageId: string }>();
    const adapter = { send: vi.fn(() => gate.promise), saveSentCopy: vi.fn(async () => undefined) };
    const sending = value.send(draft.draftId, adapter);
    now += 101;
    expect(value.purgeExpired()).toBe(0);
    expect(value.status(draft.draftId).status).toBe("sending");
    expect(() => value.prepare({ body: "next" }, preview)).toThrow(expect.objectContaining({ code: "DRAFT_CAPACITY_EXCEEDED" }));
    expect(() => value.cancel(draft.draftId)).toThrow(expect.objectContaining({ code: "DRAFT_NOT_EDITABLE" }));
    expect(() => value.update(draft.draftId, { body: "edited" }, preview)).toThrow(expect.objectContaining({ code: "DRAFT_NOT_EDITABLE" }));
    gate.resolve({ messageId: "<synthetic@example.test>" });
    await sending;
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it("budgets both copies of content and binding; a rejected edit leaves the prior draft intact", () => {
    const value = store({ maxBytes: 4_000 });
    const draft = value.prepare({ body: "original" }, preview, [], undefined, binding);
    expect(() => value.prepare({ body: "x".repeat(2_500) }, { ...preview, text: "y".repeat(2_500) })).toThrow(expect.objectContaining({ code: "DRAFT_CAPACITY_EXCEEDED" }));
    expect(() => value.update(draft.draftId, { body: "x".repeat(4_000) }, preview)).toThrow(expect.objectContaining({ code: "DRAFT_CAPACITY_EXCEEDED" }));
    expect(value.getPayload(draft.draftId).body).toBe("original");
    expect(value.usage.count).toBe(1);
    expect(value.usage.bytes).toBeLessThanOrEqual(4_000);
  });

  it("edits atomically under the same ID, retaining expiry and isolated bindings", () => {
    let now = Date.now();
    const value = store({ now: () => now });
    const originalBinding = { ...binding };
    const first = value.prepare({ body: "before" }, preview, [], undefined, originalBinding);
    originalBinding.scope = "mutated-by-caller";
    now += 10_000;
    const edited = value.update(first.draftId, { body: "after" }, { ...preview, text: "after" });
    expect(edited.draftId).toBe(first.draftId);
    expect(edited.expiresAt).toBe(first.expiresAt);
    expect(value.getPayload(first.draftId).body).toBe("after");
    expect(value.getBinding(first.draftId)).toEqual(binding);
    value.getBinding(first.draftId)!.scope = "mutated-return";
    expect(value.getBinding(first.draftId)).toEqual(binding);
    expect(value.list(entry => entry?.scope === binding.scope)).toHaveLength(1);
    expect(value.list(entry => entry?.scope === "another-account")).toEqual([]);
  });

  it("releases content on cancellation and retains a minimal idempotent status", async () => {
    const value = store();
    const draft = value.prepare({ body: "sensitive".repeat(4_000) }, { ...preview, text: "sensitive".repeat(4_000) }, [], undefined, binding);
    const before = value.usage.bytes;
    const cancelled = value.cancel(draft.draftId);
    expect(value.cancel(draft.draftId)).toEqual(cancelled);
    expect(value.usage.bytes).toBeLessThan(before / 10);
    expect(JSON.stringify(value.status(draft.draftId))).not.toContain("sensitive");
    expect(value.getBinding(draft.draftId)).toEqual(binding);
    expect(() => value.get(draft.draftId)).toThrow(expect.objectContaining({ code: "DRAFT_NOT_EDITABLE" }));
    const adapter = { send: vi.fn(), saveSentCopy: vi.fn() };
    await expect(value.send(draft.draftId, adapter)).rejects.toMatchObject({ code: "DRAFT_CANCELLED" });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("actively expires drafts and their bindings and clears its timer on dispose", () => {
    vi.useFakeTimers();
    const value = store({ ttlMs: 100, cleanupIntervalMs: 10 });
    value.prepare({ body: "sensitive" }, preview, [], undefined, binding);
    vi.advanceTimersByTime(110);
    expect(value.usage).toMatchObject({ count: 0, bytes: 0 });
    expect(value.list()).toEqual([]);
    value.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => value.prepare({ body: "later" }, preview)).toThrow(expect.objectContaining({ code: "DRAFT_DISPOSED" }));
  });

  it("preserves a sent result while freeing the message and eventually the binding", async () => {
    let now = Date.now();
    const value = store({ now: () => now, ttlMs: 100, resultRetentionMs: 200 });
    const draft = value.prepare({ body: "private-body".repeat(4_000) }, preview, [], undefined, binding);
    const adapter = { send: vi.fn(async () => ({ messageId: "<fixed@example.test>" })), saveSentCopy: vi.fn(async () => { throw new Error("synthetic append failure"); }) };
    const result = await value.send(draft.draftId, adapter);
    expect(await value.send(draft.draftId, adapter)).toBe(result);
    expect(result).toMatchObject({ sent: true, status: "sent_copy_failed" });
    expect(JSON.stringify(value.exportSnapshot())).not.toContain("private-body");
    expect(value.usage.bytes).toBeLessThan(3_000);
    now += 201;
    expect(value.purgeExpired()).toBe(1);
    expect(value.usage).toMatchObject({ count: 0, bytes: 0 });
  });

  it("returns a fixed Message-ID and an unknown outcome without another delivery attempt", async () => {
    const value = store();
    const draft = value.prepare({ body: "private-body", messageId: "<fixed@example.test>" }, preview);
    const adapter = { send: vi.fn(async () => { throw new DraftError("DRAFT_DELIVERY_UNKNOWN", "synthetic final response loss"); }), saveSentCopy: vi.fn() };
    const first = await value.send(draft.draftId, adapter);
    expect(first).toMatchObject({ status: "delivery_unknown", sent: null, messageId: "<fixed@example.test>" });
    expect(await value.send(draft.draftId, adapter)).toBe(first);
    expect(first).not.toHaveProperty("sentAt");
    expect(value.status(draft.draftId).attempt).toMatchObject({ status: "delivery_unknown", messageId: "<fixed@example.test>" });
    expect(JSON.stringify(value.exportSnapshot())).not.toContain("private-body");
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.saveSentCopy).not.toHaveBeenCalled();
  });

  it("distinguishes a definite pre-delivery failure and invalidates selected attachment drafts", async () => {
    const value = store();
    const first = value.prepare({ body: "body" }, preview);
    const adapter = { send: vi.fn(async () => { throw new DraftError("DRAFT_APPROVAL_DECLINED", "The user declined."); }), saveSentCopy: vi.fn() };
    await expect(value.send(first.draftId, adapter)).rejects.toMatchObject({ code: "DRAFT_APPROVAL_DECLINED" });
    expect(value.status(first.draftId)).toMatchObject({ status: "not_sent", attempt: { status: "not_sent" } });
    const second = value.prepare({ body: "body", attachmentIds: ["attachment-synthetic"] }, preview, [], undefined, binding);
    expect(value.invalidateWhere((payload, account) => account?.scope === binding.scope && Boolean(payload.attachmentIds?.length))).toBe(1);
    expect(value.status(second.draftId)).toMatchObject({ status: "not_sent", failure: { code: "DRAFT_ATTACHMENTS_INVALID" } });
  });

  it("exports started attempts only as terminal unknown records and never restores them as sendable", async () => {
    const value = store();
    const draft = value.prepare({ body: "private-body", messageId: "<fixed@example.test>" }, preview, [], undefined, binding);
    const gate = deferred<{ messageId: string }>();
    const original = value.send(draft.draftId, { send: () => gate.promise, saveSentCopy: async () => undefined });
    const snapshot = value.exportSnapshot();
    expect(snapshot.records[0]).toMatchObject({ state: "delivery_unknown", outcome: { sent: null } });
    expect(snapshot.records[0]).not.toHaveProperty("content");
    const restored = store();
    expect(restored.restoreSnapshot(snapshot, entry => entry.binding?.scope === binding.scope)).toBe(1);
    const adapter = { send: vi.fn(), saveSentCopy: vi.fn() };
    await expect(restored.send(draft.draftId, adapter)).resolves.toMatchObject({ status: "delivery_unknown", sent: null });
    expect(adapter.send).not.toHaveBeenCalled();
    gate.resolve({ messageId: "<fixed@example.test>" });
    await original;
  });

  it("rejects snapshots containing a sending state or a caller-rejected account atomically", () => {
    const source = store();
    source.prepare({ body: "body" }, preview, [], undefined, binding);
    const snapshot = source.exportSnapshot();
    const restored = store();
    expect(() => restored.restoreSnapshot(snapshot, () => false)).toThrow(expect.objectContaining({ code: "DRAFT_SNAPSHOT_INVALID" }));
    const corrupted = { ...snapshot, records: snapshot.records.map(record => ({ ...record, state: "sending" })) };
    expect(() => restored.restoreSnapshot(corrupted as DraftSnapshot<Payload, DraftPreview, Binding>, () => true)).toThrow(expect.objectContaining({ code: "DRAFT_SNAPSHOT_INVALID" }));
    expect(restored.size).toBe(0);
  });

  it("awaits durable persistence before delivery and fails closed on persistence errors", async () => {
    const value = store();
    const draft = value.prepare({ body: "body" }, preview);
    const gate = deferred<void>();
    value.attachPersistence({ changed: () => undefined, beforeSend: () => gate.promise });
    const adapter = { send: vi.fn(async () => ({ messageId: "<fixed@example.test>" })), saveSentCopy: vi.fn(async () => undefined) };
    const pending = value.send(draft.draftId, adapter);
    expect(adapter.send).not.toHaveBeenCalled();
    gate.resolve();
    await pending;
    expect(adapter.send).toHaveBeenCalledTimes(1);
    const unavailable = store();
    const other = unavailable.prepare({ body: "body" }, preview);
    unavailable.attachPersistence({ changed: () => undefined, beforeSend: async () => { throw new Error("synthetic disk failure"); } });
    await expect(unavailable.send(other.draftId, adapter)).rejects.toMatchObject({ code: "DRAFT_PERSISTENCE_FAILED" });
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });
});

function journalFixture(initial: Buffer | null = null) {
  let data = initial === null ? null : Buffer.from(initial);
  let locked = false;
  const storage: DraftJournalStorage = {
    acquire: vi.fn(async () => { if (locked) throw new Error("locked"); locked = true; }),
    read: vi.fn(async () => data === null ? null : Buffer.from(data)),
    write: vi.fn(async bytes => { data = Buffer.from(bytes); }),
    release: vi.fn(async () => { locked = false; }),
  };
  const protection = { protect: vi.fn(async (plain: string) => Buffer.from(plain, "utf8")), unprotect: vi.fn(async (cipher: Buffer) => cipher.toString("utf8")) };
  return { storage, protection, bytes: () => data === null ? null : Buffer.from(data) };
}
const journalValidation = {
  validateRecord: (record: { binding?: Binding }) => record.binding?.profileId === binding.profileId && record.binding.revision === binding.revision,
  hasAttachments: (payload: Payload) => Boolean(payload.attachmentIds?.length),
};

describe("encrypted draft journal", () => {
  const windowsIt = process.platform === "win32" ? it : it.skip;

  windowsIt("round-trips an actual CurrentUser DPAPI journal with the fixed ACL storage adapter", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "qq-mail-draft-journal-"));
    const source = store();
    const journal = new DraftJournal<Payload, DraftPreview, Binding>({ directory });
    let reopened: DraftJournal<Payload, DraftPreview, Binding> | undefined;
    try {
      await journal.attach(source, journalValidation);
      const draft = source.prepare({ body: "SYNTHETIC_DPAPI_DRAFT_BODY" }, preview, [], undefined, binding);
      await source.flush();
      const encrypted = await readFile(path.join(directory, "drafts.enc.json"), "utf8");
      expect(encrypted).not.toContain("SYNTHETIC_DPAPI_DRAFT_BODY");
      expect(encrypted).not.toContain(binding.profileId);
      await journal.close();
      reopened = new DraftJournal<Payload, DraftPreview, Binding>({ directory });
      const restored = store();
      await reopened.attach(restored, journalValidation);
      expect(restored.getPayload(draft.draftId).body).toBe("SYNTHETIC_DPAPI_DRAFT_BODY");
    } finally {
      await journal.close().catch(() => undefined);
      await reopened?.close().catch(() => undefined);
      expect(path.relative(tmpdir(), directory)).not.toMatch(/^\.\./u);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("round-trips ordinary drafts and invalidates restored attachment drafts without dropping them silently", async () => {
    const fixture = journalFixture();
    const source = store();
    const journal = new DraftJournal<Payload, DraftPreview, Binding>(fixture);
    await journal.attach(source, journalValidation);
    const ordinary = source.prepare({ body: "private synthetic body" }, preview, [], undefined, binding);
    const attachment = source.prepare({ body: "attachment body", attachmentIds: ["synthetic-attachment"] }, preview, [], undefined, binding);
    await source.flush();
    const encrypted = fixture.bytes()!;
    expect(encrypted.toString("utf8")).not.toContain("private synthetic body");
    expect(encrypted.toString("utf8")).not.toContain(binding.profileId);
    await journal.close();
    const restored = store();
    const reopened = new DraftJournal<Payload, DraftPreview, Binding>(fixture);
    expect(await reopened.attach(restored, journalValidation)).toEqual({ restored: 2, invalidatedAttachments: 1 });
    expect(restored.getPayload(ordinary.draftId).body).toBe("private synthetic body");
    expect(restored.status(attachment.draftId)).toMatchObject({ status: "not_sent", failure: { code: "DRAFT_ATTACHMENTS_INVALID" } });
    await reopened.close();
  });

  it("saves the unknown crash marker before invoking the external send callback", async () => {
    const fixture = journalFixture();
    const source = store();
    const journal = new DraftJournal<Payload, DraftPreview, Binding>(fixture);
    await journal.attach(source, journalValidation);
    const draft = source.prepare({ body: "body", messageId: "<fixed@example.test>" }, preview, [], undefined, binding);
    let recovery: DraftJournal<Payload, DraftPreview, Binding> | undefined;
    const adapter = {
      send: vi.fn(async () => {
        const recoveredStore = store();
        recovery = new DraftJournal<Payload, DraftPreview, Binding>(journalFixture(fixture.bytes()));
        await recovery.attach(recoveredStore, journalValidation);
        expect(recoveredStore.status(draft.draftId)).toMatchObject({ status: "delivery_unknown", result: { messageId: "<fixed@example.test>" } });
        const shouldNotRun = { send: vi.fn(), saveSentCopy: vi.fn() };
        await expect(recoveredStore.send(draft.draftId, shouldNotRun)).resolves.toMatchObject({ status: "delivery_unknown" });
        expect(shouldNotRun.send).not.toHaveBeenCalled();
        return { messageId: "<fixed@example.test>" };
      }),
      saveSentCopy: vi.fn(async () => undefined),
    };
    await source.send(draft.draftId, adapter);
    await recovery?.close();
    await journal.close();
  });

  it("blocks delivery when the journal cannot persist the attempt marker", async () => {
    const fixture = journalFixture();
    const source = store();
    const journal = new DraftJournal<Payload, DraftPreview, Binding>(fixture);
    await journal.attach(source, journalValidation);
    const draft = source.prepare({ body: "body" }, preview, [], undefined, binding);
    await source.flush();
    vi.mocked(fixture.storage.write).mockRejectedValue(new Error("synthetic disk failure"));
    const adapter = { send: vi.fn(), saveSentCopy: vi.fn() };
    await expect(source.send(draft.draftId, adapter)).rejects.toMatchObject({ code: "DRAFT_PERSISTENCE_FAILED" });
    expect(adapter.send).not.toHaveBeenCalled();
    await expect(journal.close()).rejects.toMatchObject({ code: "DRAFT_PERSISTENCE_FAILED" });
  });

  it("rejects authenticated ciphertext tampering and rejects another live journal lock", async () => {
    const fixture = journalFixture();
    const source = store();
    const journal = new DraftJournal<Payload, DraftPreview, Binding>(fixture);
    await journal.attach(source, journalValidation);
    const competing = new DraftJournal<Payload, DraftPreview, Binding>(fixture);
    await expect(competing.attach(store(), journalValidation)).rejects.toMatchObject({ code: "DRAFT_PERSISTENCE_FAILED" });
    source.prepare({ body: "body" }, preview, [], undefined, binding);
    await source.flush();
    const envelope = JSON.parse(fixture.bytes()!.toString("utf8"));
    const tag = Buffer.from(envelope.tag, "base64");
    tag[0] = (tag[0] ?? 0) ^ 1;
    envelope.tag = tag.toString("base64");
    const tampered = new DraftJournal<Payload, DraftPreview, Binding>(journalFixture(Buffer.from(JSON.stringify(envelope))));
    await expect(tampered.attach(store(), journalValidation)).rejects.toMatchObject({ code: "DRAFT_PERSISTENCE_FAILED" });
    await journal.close();
  });
});
