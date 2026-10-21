import { mkdtemp, writeFile, rm, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { simpleParser } from "mailparser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutgoingAttachmentStore, readSelectedLocalFile, type OutgoingAttachmentMetadata } from "../src/outgoing-attachments.js";
import { ATTACHMENT_TTL_MS, MAX_OUTGOING_FILE_BYTES } from "../src/attachment-limits.js";
import { DraftStore } from "../src/drafts.js";
import type { SendApprovalRequest } from "../src/approval.js";
import { QqMailService, compileOutgoingMessage, coreMessageReferenceCodec } from "../src/mail/index.js";
import { NodemailerSmtpGateway } from "../src/mail/gateways.js";
import type { MailAccountConfig, OutgoingMessage, ImapSession } from "../src/mail/types.js";
import { testContext } from "./account-fixtures.js";

const scope = "a".repeat(64);
const stores: OutgoingAttachmentStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  stores.splice(0).forEach(store => store.dispose());
  for (const dir of dirs.splice(0)) {
    // Only delete freshly created test directories under the test temp root.
    expect(path.relative(tmpdir(), dir)).not.toMatch(/^\.\./u);
    await rm(dir, { recursive: true, force: true });
  }
});
function store(options: ConstructorParameters<typeof OutgoingAttachmentStore>[0] = {}) {
  const value = new OutgoingAttachmentStore(options); stores.push(value); return value;
}
const baseMessage: OutgoingMessage = {
  from: { address: "sender@example.test", name: "Synthetic" },
  to: [{ address: "receiver@example.test", name: "" }], cc: [], bcc: [],
  subject: "Synthetic attachments", text: "Synthetic body",
};
function harness(options: {
  picker?: () => Promise<readonly string[]>;
  read?: (name: string) => Promise<Buffer>;
  approve?: () => Promise<boolean>;
  send?: () => Promise<void>;
} = {}) {
  let now = 100_000, revision = "one";
  const account: MailAccountConfig = {
    email: "sender@qq.com", username: "sender@qq.com", displayName: "Synthetic",
    smtp: { host: "smtp.qq.com", port: 465, security: "tls" },
    imap: { host: "imap.qq.com", port: 993, security: "tls" },
    folders: { inbox: "INBOX", sent: "Sent", trash: "Trash" },
    downloadDirectory: "C:\\Synthetic\\Downloads", downloadLimitBytes: 1024,
  };
  const attachments = store({ now: () => now, read: options.read ?? (async () => Buffer.from("synthetic bytes")) });
  const approve = vi.fn(async (_request: SendApprovalRequest) => options.approve ? options.approve() : true);
  const picker = vi.fn(options.picker ?? (async () => ["C:\\Synthetic\\报告.pdf"]));
  const append = vi.fn(async () => {});
  let delivered: Buffer = Buffer.alloc(0);
  const send = vi.fn(async (_config, _user, _secret, message, content) => {
    await options.send?.();
    const rawMessage = (await compileOutgoingMessage(message, content)).message;
    delivered = Buffer.from(rawMessage); // Test-only capture of bytes observed by the transport.
    return { rawMessage, messageId: "<synthetic@example.test>", accepted: ["receiver@example.test"], rejected: [] };
  });
  const service = new QqMailService({
    accountProvider: { getContext: async () => testContext(account, "synthetic-secret", revision) },
    referenceCodec: coreMessageReferenceCodec,
    draftStore: new DraftStore<OutgoingMessage, Record<string, unknown>>({ now: () => now }),
    attachmentStorage: { save: vi.fn() },
    imapGateway: { connect: async () => ({ appendMessage: append, close: async () => {} } as unknown as ImapSession) },
    smtpGateway: { send, verify: async () => {} },
    sendApproval: { confirm: approve }, attachmentPicker: { select: picker }, outgoingAttachments: attachments,
    now: () => now,
  });
  async function prepare(ids?: string[]) {
    return await service.prepareEmail({
      to: ["receiver@example.test"], text: "Synthetic body",
      ...(ids ? { attachmentIds: ids } : {}),
    }) as { draftId: string; expiresAt: string; preview: { attachments: OutgoingAttachmentMetadata[] } };
  }
  async function select() {
    const result = await service.selectAttachments() as { attachments: OutgoingAttachmentMetadata[] };
    return result.attachments;
  }
  return { service, attachments, approve, picker, send, append, prepare, select,
    tick: (ms: number) => { now += ms; }, switchAccount: () => { revision = "two"; }, raw: () => delivered };
}

describe("outgoing attachment snapshots", () => {
  it("returns metadata only and isolates acquired copies", async () => {
    const value = store({ read: async () => Buffer.from("private synthetic bytes") });
    const metadata = await value.importSelected(["C:\\Synthetic\\报告.pdf"], scope);
    expect(metadata[0]).toMatchObject({ filename: "报告.pdf", bytes: 23, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(JSON.stringify(metadata)).not.toMatch(/C:|content"|private synthetic/u);
    const id = metadata[0]!.attachmentId;
    const copy = value.acquire([id], scope)[0]!;
    copy.content.fill(0);
    metadata[0]!.filename = "changed";
    expect(value.acquire([id], scope)[0]!.content.toString()).toBe("private synthetic bytes");
    expect(value.metadata([id], scope)[0]!.filename).toBe("报告.pdf");
  });
  it("rejects forged, duplicated and wrong-account references", async () => {
    const value = store({ read: async () => Buffer.alloc(1) });
    const [entry] = await value.importSelected(["C:\\Synthetic\\file"], scope);
    for (const ids of [["C:\\secret"], [entry!.attachmentId, entry!.attachmentId]]) {
      expect(() => value.metadata(ids, scope)).toThrow();
    }
    expect(() => value.metadata([entry!.attachmentId], "b".repeat(64))).toThrow(/account/u);
    expect(() => value.metadata(["att_00000000-0000-4000-8000-000000000000"], scope)).toThrow();
  });
  it("purges expired snapshots and wipes buffers on disposal", async () => {
    let now = 0;
    const bytes = Buffer.from("secret");
    const value = store({ now: () => now, read: async () => bytes });
    const [entry] = await value.importSelected(["C:\\Synthetic\\file"], scope);
    now = ATTACHMENT_TTL_MS;
    expect(() => value.acquire([entry!.attachmentId], scope)).toThrow();
    expect(bytes.equals(Buffer.alloc(bytes.length))).toBe(true);
    const other = Buffer.from("other");
    const disposed = store({ read: async () => other });
    await disposed.importSelected(["C:\\Synthetic\\file"], scope);
    disposed.dispose();
    expect(other.equals(Buffer.alloc(other.length))).toBe(true);
  });
  it("rolls back and wipes the entire selection when a later read fails", async () => {
    const first = Buffer.from("first");
    const value = store({ read: async name => {
      if (name.endsWith("2")) throw Error("C:\\secret-path must not leak");
      return first;
    } });
    await expect(value.importSelected(["C:\\1", "C:\\2"], scope)).rejects.toMatchObject({ code: "ATTACHMENT_IMPORT_FAILED" });
    expect(first.equals(Buffer.alloc(first.length))).toBe(true);
  });
  it("enforces file/count/batch limits before committing", async () => {
    const read = vi.fn(async () => Buffer.alloc(MAX_OUTGOING_FILE_BYTES, 1));
    const value = store({ read });
    await expect(value.importSelected(Array.from({ length: 11 }, (_, n) => `C:\\${n}`), scope)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    await expect(value.importSelected(["C:\\same", "c:\\SAME"], scope)).rejects.toThrow();
    await expect(value.importSelected(["C:\\1", "C:\\2", "C:\\3"], scope)).rejects.toMatchObject({ code: "ATTACHMENT_LIMIT" });
    const large = store({ read: async () => Buffer.alloc(MAX_OUTGOING_FILE_BYTES + 1) });
    await expect(large.importSelected(["C:\\1"], scope)).rejects.toMatchObject({ code: "ATTACHMENT_LIMIT" });
  });
  it("enforces memory quota and aggregate limits across selections", async () => {
    const value = store({ read: async () => Buffer.alloc(MAX_OUTGOING_FILE_BYTES) });
    const entries: OutgoingAttachmentMetadata[] = [];
    for (let i = 0; i < 6; i++) entries.push(...await value.importSelected([`C:\\${i}`], scope));
    await expect(value.importSelected(["C:\\7"], scope)).rejects.toMatchObject({ code: "ATTACHMENT_LIMIT" });
    expect(() => value.acquire(entries.slice(0, 3).map(e => e.attachmentId), scope)).toThrow(/combined/u);
  });
  it("rejects parallel imports and disposal during an import", async () => {
    let release!: (buffer: Buffer) => void;
    const value = store({ read: async () => new Promise(resolve => { release = resolve; }) });
    const pending = value.importSelected(["C:\\1"], scope);
    await expect(value.importSelected(["C:\\2"], scope)).rejects.toMatchObject({ code: "ATTACHMENTS_BUSY" });
    value.dispose();
    const buffer = Buffer.from("secret");
    release(buffer);
    await expect(pending).rejects.toThrow();
    expect(buffer.equals(Buffer.alloc(buffer.length))).toBe(true);
  });
  it("bounds the number of pending zero-length attachments", async () => {
    const value = store({ read: async () => Buffer.alloc(0) });
    for (let i = 0; i < 64; i++) await value.importSelected([`C:\\file${i}`], scope);
    await expect(value.importSelected(["C:\\file65"], scope)).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FULL" });
  });
  it("rejects network/device/ADS/URL/relative paths before opening", async () => {
    for (const unsafe of ["\\\\server\\share\\file", "\\\\?\\C:\\file", "C:\\file:stream", "https://example.test/file", "..\\file", "C:\\trailing.\\file"]) {
      await expect(readSelectedLocalFile(unsafe, 1024)).rejects.toMatchObject({ code: "UNSAFE_ATTACHMENT_PATH" });
    }
  });
  it("reads a bounded real file, then remains unchanged after source replacement", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qqmail-attachment-")); dirs.push(dir);
    const filename = path.join(dir, "报告.bin");
    await writeFile(filename, Buffer.from([0, 1, 255, 13]));
    const value = store();
    const [entry] = await value.importSelected([filename], scope);
    await writeFile(filename, "changed");
    expect(value.acquire([entry!.attachmentId], scope)[0]!.content).toEqual(Buffer.from([0, 1, 255, 13]));
    await expect(readSelectedLocalFile(filename, 1)).rejects.toThrow();
  });
  it("rejects a real directory junction", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qqmail-attachment-")); dirs.push(dir);
    const link = path.join(dir, "redirect");
    await symlink(await realpath(dir), link, "junction");
    await writeFile(path.join(dir, "file"), "Existing synthetic target");
    await expect(readSelectedLocalFile(path.join(link, "file"), 1024)).rejects.toMatchObject({ code: "UNSAFE_ATTACHMENT_PATH" });
  });
  it("encodes Unicode filenames and binary/empty files without Bcc disclosure", async () => {
    const value = store({ read: async name => name.endsWith("empty") ? Buffer.alloc(0) : Buffer.from([0, 255, 1, 13, 10]) });
    const entries = await value.importSelected(["C:\\报告.pdf", "C:\\empty"], scope);
    const ids = entries.map(e => e.attachmentId);
    const compiled = await compileOutgoingMessage({ ...baseMessage, bcc: [{ name: "", address: "hidden@example.test" }], attachmentIds: ids }, value.acquire(ids, scope));
    const parsed = await simpleParser(compiled.message);
    expect(parsed.attachments.map(a => a.filename)).toEqual(["报告.pdf", "empty"]);
    expect(parsed.attachments[0]!.content).toEqual(Buffer.from([0, 255, 1, 13, 10]));
    expect(parsed.attachments[1]!.content.length).toBe(0);
    expect(compiled.message.toString()).not.toMatch(/^Bcc:/mi);
  });
  it("rejects path, URL, raw MIME and mismatched descriptors before compilation", async () => {
    const value = store({ read: async () => Buffer.from("test") });
    const [entry] = await value.importSelected(["C:\\file"], scope);
    const ids = [entry!.attachmentId], [item] = value.acquire(ids, scope);
    for (const extra of [{ path: "C:\\secret" }, { href: "https://example.test" }, { raw: "unsafe" }, { bytes: 99 }]) {
      await expect(compileOutgoingMessage({ ...baseMessage, attachmentIds: ids }, [{ ...item!, ...extra }])).rejects.toThrow();
    }
    await expect(compileOutgoingMessage(baseMessage, [item!])).rejects.toThrow();
  });
  it("rejects oversized encoded MIME before opening an SMTP connection", async () => {
    const value = store({ read: async () => Buffer.alloc(MAX_OUTGOING_FILE_BYTES, 255) });
    const entries = await value.importSelected(["C:\\one", "C:\\two"], scope);
    const ids = entries.map(entry => entry.attachmentId);
    await expect(new NodemailerSmtpGateway().send(
      { host: "127.0.0.1", port: 1, security: "tls" }, "synthetic", "synthetic",
      { ...baseMessage, text: "X".repeat(8 * 1024 * 1024), attachmentIds: ids }, value.acquire(ids, scope),
    )).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
  });
});

describe("attachment authorization and draft delivery", () => {
  it("does not read files on picker cancellation", async () => {
    const read = vi.fn(async () => Buffer.from("never"));
    const h = harness({ picker: async () => [], read });
    expect(await h.service.selectAttachments()).toMatchObject({ status: "cancelled", attachments: [] });
    expect(read).not.toHaveBeenCalled();
  });
  it("binds metadata and expiry to a draft, confirms and sends matching bytes once", async () => {
    const h = harness();
    const entries = await h.select();
    h.tick(60_000);
    const draft = await h.prepare(entries.map(e => e.attachmentId));
    expect(draft.expiresAt).toBe(entries[0]!.expiresAt);
    expect(draft.preview.attachments).toEqual(entries);
    const outcomes = await Promise.all([h.service.sendEmail(draft), h.service.sendEmail(draft)]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.append).toHaveBeenCalledOnce();
    expect(h.approve.mock.calls[0]?.[0]).toMatchObject({ preview: { attachments: entries } });
    expect((await simpleParser(h.raw())).attachments[0]!.content.toString()).toBe("synthetic bytes");
    expect(h.send.mock.calls[0]?.[4][0].content.every((b: number) => b === 0)).toBe(true);
  });
  it("cancellation prevents SMTP and sent-copy operations", async () => {
    const h = harness({ approve: async () => false });
    const entries = await h.select();
    const draft = await h.prepare(entries.map(e => e.attachmentId));
    await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
  it("allows an attachment-only email with an empty body", async () => {
    const h = harness();
    const draft = await h.service.prepareEmail({
      to: ["receiver@example.test"], attachmentIds: (await h.select()).map(entry => entry.attachmentId),
    }) as { draftId: string };
    expect(await h.service.sendEmail(draft)).toMatchObject({ sent: true });
    expect((await simpleParser(h.raw())).attachments).toHaveLength(1);
  });
  it("blocks account changes while the picker is open before file reads", async () => {
    const read = vi.fn(async () => Buffer.from("never"));
    const h = harness({ read, picker: async () => { h.switchAccount(); return ["C:\\file"]; } });
    await expect(h.service.selectAttachments()).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("discards selection when the account changes during file import", async () => {
    const bytes = Buffer.from("secret");
    const h = harness({ read: async () => { h.switchAccount(); return bytes; } });
    await expect(h.service.selectAttachments()).rejects.toThrow();
    expect(bytes.equals(Buffer.alloc(bytes.length))).toBe(true);
  });
  it("blocks old attachment references after account revision", async () => {
    const h = harness(), entries = await h.select();
    h.switchAccount();
    await expect(h.prepare(entries.map(e => e.attachmentId))).rejects.toMatchObject({ code: "STALE_ATTACHMENT" });
  });
  it("rejects expiry while the confirmation is open", async () => {
    const h = harness({ approve: async () => { h.tick(ATTACHMENT_TTL_MS); return true; } });
    const draft = await h.prepare((await h.select()).map(e => e.attachmentId));
    await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_EXPIRED" });
    expect(h.send).not.toHaveBeenCalled();
  });
  it("bounds concurrent sends and leaves a rejected queued draft retryable", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ send: async () => gate });
    const drafts = await Promise.all(Array.from({ length: 5 }, () => h.prepare()));
    const active = drafts.slice(0, 4).map(draft => h.service.sendEmail(draft));
    await expect(h.service.sendEmail(drafts[4]!)).rejects.toMatchObject({ code: "SEND_BUSY" });
    release();
    await Promise.all(active);
    await expect(h.service.sendEmail(drafts[4]!)).resolves.toMatchObject({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(5);
  });
});
