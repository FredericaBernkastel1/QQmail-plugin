import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftStore } from "../src/drafts.js";
import { QqMailService, validateRestoredDraftRecord } from "../src/mail/service.js";
import { coreMessageReferenceCodec } from "../src/mail/adapters.js";
import type { ImapMessageData, ImapSession, MailAccountConfig, OutgoingMessage } from "../src/mail/types.js";
import { testContext } from "./account-fixtures.js";

const resources: Array<{ dispose(): void }> = [];
afterEach(() => { resources.splice(0).forEach(resource => resource.dispose()); });

function harness() {
  const now = () => Date.parse("2026-10-21T00:00:00.000Z");
  const account: MailAccountConfig = {
    email: "synthetic@qq.com", username: "synthetic@qq.com", displayName: "Synthetic",
    imap: { host: "imap.qq.com", port: 993, security: "tls" },
    smtp: { host: "smtp.qq.com", port: 465, security: "tls" },
    folders: { inbox: "INBOX", sent: "Sent", trash: "Trash" },
    downloadDirectory: "C:\\Synthetic\\Downloads", downloadLimitBytes: 1024,
  };
  const context = testContext(account, "synthetic-secret", "revision-one");
  const source = Buffer.from([
    "From: Alice <alice@example.test>",
    "To: Synthetic <synthetic@qq.com>",
    "Cc: Bob <bob@example.test>",
    "Subject: Synthetic reply thread",
    "Date: Wed, 21 Oct 2026 00:00:00 +0000",
    "Message-ID: <parent@example.test>",
    "References: <root@example.test>",
    "Content-Type: text/plain; charset=utf-8",
    "", "Synthetic original body",
  ].join("\r\n"));
  const record: ImapMessageData = { uid: 7, flags: new Set(), size: source.length, source };
  const session = {
    selectMailbox: vi.fn(async (mailbox: string) => ({ path: mailbox, uidValidity: "42", exists: 1, readOnly: false })),
    fetchMessages: vi.fn(async () => [record]),
    close: vi.fn(async () => undefined),
  } as unknown as ImapSession;
  const connect = vi.fn(async () => session);
  const drafts = new DraftStore<OutgoingMessage, Record<string, unknown>>({ now });
  const service = new QqMailService({
    accountProvider: { getContext: async () => context }, referenceCodec: coreMessageReferenceCodec,
    draftStore: drafts, attachmentStorage: { save: vi.fn() }, imapGateway: { connect }, now,
  });
  resources.push(service);
  const sourceRef = coreMessageReferenceCodec.encode({ mailbox: "INBOX", uidValidity: "42", uid: 7, accountScope: context.scope });
  return { service, drafts, connect, sourceRef, now };
}

describe("Dot draft editing and recovery regressions", () => {
  for (const mode of ["reply", "reply_all"] as const) {
    it(`preserves ${mode} threading and Message-ID when editable fields are replaced`, async () => {
      const h = harness();
      const prepared = await h.service.prepareEmail({ mode, sourceRef: h.sourceRef, text: "Initial response" });
      const before = h.drafts.getPayload(prepared.draftId);
      expect(before.inReplyTo).toBe("<parent@example.test>");
      expect(before.references).toEqual(["<root@example.test>", "<parent@example.test>"]);
      expect(before.messageId).toMatch(/^<[a-f0-9]{48}@qq-mail\.local>$/u);

      const edited = await h.service.updateDraft({
        draftId: prepared.draftId, to: ["alice@example.test"], cc: ["bob@example.test"],
        subject: "Revised synthetic reply", text: "Complete replacement body",
      });
      const after = h.drafts.getPayload(prepared.draftId);
      expect(edited.draftId).toBe(prepared.draftId);
      expect(edited.expiresAt).toBe(prepared.expiresAt);
      expect(after.messageId).toBe(before.messageId);
      expect(after.inReplyTo).toBe(before.inReplyTo);
      expect(after.references).toEqual(before.references);
      expect(after.text).toBe("Complete replacement body");
      expect(after.subject).toBe("Revised synthetic reply");
      expect(h.connect).toHaveBeenCalledTimes(1);
    });
  }

  it("restores snapshots produced by the mail service with its real account binding", async () => {
    const h = harness();
    const prepared = await h.service.prepareEmail({ to: ["alice@example.test"], subject: "Recover", text: "Synthetic recoverable body" });
    const snapshot = h.drafts.exportSnapshot();
    expect(snapshot.records).toHaveLength(1);
    expect(validateRestoredDraftRecord(snapshot.records[0]!)).toBe(true);
    const restored = new DraftStore<OutgoingMessage, Record<string, unknown>>({ now: h.now });
    resources.push(restored);
    expect(restored.restoreSnapshot(snapshot, validateRestoredDraftRecord)).toBe(1);
    expect(restored.getPayload(prepared.draftId)).toEqual(h.drafts.getPayload(prepared.draftId));
    expect(restored.getBinding(prepared.draftId)).toEqual(h.drafts.getBinding(prepared.draftId));
  });

  it("rejects a syntactically valid but incorrect restored account fingerprint", async () => {
    const h = harness();
    await h.service.prepareEmail({ to: ["alice@example.test"], subject: "Tamper", text: "Synthetic body" });
    const snapshot = h.drafts.exportSnapshot();
    const binding = snapshot.records[0]!.binding as { fingerprint: string };
    expect(binding.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    binding.fingerprint = `${binding.fingerprint[0] === "A" ? "B" : "A"}${binding.fingerprint.slice(1)}`;
    expect(validateRestoredDraftRecord(snapshot.records[0]!)).toBe(false);
    const restored = new DraftStore<OutgoingMessage, Record<string, unknown>>({ now: h.now });
    resources.push(restored);
    expect(() => restored.restoreSnapshot(snapshot, validateRestoredDraftRecord)).toThrow(
      expect.objectContaining({ code: "DRAFT_SNAPSHOT_INVALID" }),
    );
    expect(restored.size).toBe(0);
  });
});
