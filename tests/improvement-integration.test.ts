import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftStore, DraftError } from "../src/drafts.js";
import { DeliveryFailure } from "../src/errors.js";
import { OutgoingAttachmentStore, type OutgoingAttachmentMetadata } from "../src/outgoing-attachments.js";
import type { SendApproval } from "../src/approval.js";
import { QqMailService, type QqMailServiceOptions } from "../src/mail/service.js";
import { classifySmtpFailure, compileOutgoingMessage } from "../src/mail/gateways.js";
import { coreMessageReferenceCodec } from "../src/mail/adapters.js";
import type { ImapSession, MailAccountConfig, OutgoingMessage, PrepareEmailInput, SmtpGateway } from "../src/mail/types.js";
import { testContext } from "./account-fixtures.js";

const services: QqMailService[] = [];
afterEach(() => { services.splice(0).forEach(service => service.dispose()); });

function harness(options: {
  sendApproval?: SendApproval;
  mutationApproval?: QqMailServiceOptions["mutationApproval"];
  delivery?: () => Promise<void>;
  sentCopyFails?: boolean;
  initializeDrafts?: () => Promise<void>;
} = {}) {
  let revision = "revision-one";
  const now = Date.now();
  const account: MailAccountConfig = {
    email: "sender@qq.com", username: "sender@qq.com", displayName: "Synthetic sender",
    imap: { host: "imap.qq.com", port: 993, security: "tls" }, smtp: { host: "smtp.qq.com", port: 465, security: "tls" },
    folders: { inbox: "INBOX", sent: "Sent", trash: "Trash", archive: "Archive" },
    downloadDirectory: "C:\\Synthetic\\Downloads", downloadLimitBytes: 1024,
  };
  const drafts = new DraftStore<OutgoingMessage, Record<string, unknown>>({ now: () => now });
  const attachments = new OutgoingAttachmentStore({ now: () => now, read: async () => Buffer.from("synthetic selected attachment") });
  let raw: Buffer | undefined;
  let appended: Buffer | undefined;
  const move = vi.fn(async (_uids: number[], _destination: string) => undefined);
  const append = vi.fn(async (_mailbox: string, bytes: Buffer) => {
    appended = Buffer.from(bytes);
    if (options.sentCopyFails) throw new Error("synthetic Sent mailbox failure");
  });
  const session = {
    listMailboxes: vi.fn(async () => ["INBOX", "Sent", "Trash", "Archive"].map(mailbox => ({ path: mailbox, delimiter: "/", subscribed: true, flags: [] }))),
    selectMailbox: vi.fn(async (mailbox: string) => ({ path: mailbox, uidValidity: "42", exists: 1, readOnly: false })),
    moveMessages: move,
    appendMessage: append,
    close: vi.fn(async () => undefined),
  } as unknown as ImapSession;
  const connect = vi.fn(async () => session);
  const send = vi.fn<SmtpGateway["send"]>(async (_config, _username, _secret, message, content = []) => {
    await options.delivery?.();
    raw = (await compileOutgoingMessage(message, content)).message;
    return { messageId: message.messageId!, accepted: message.to.map(recipient => recipient.address), rejected: [], rawMessage: raw };
  });
  const confirm = vi.fn(async () => true);
  const service = new QqMailService({
    accountProvider: { getContext: async () => testContext(account, "synthetic-secret", revision) },
    referenceCodec: coreMessageReferenceCodec, draftStore: drafts,
    attachmentStorage: { save: vi.fn() }, outgoingAttachments: attachments,
    attachmentPicker: { select: async () => ["C:\\Synthetic\\selected.txt"] },
    imapGateway: { connect }, smtpGateway: { send, verify: async () => undefined },
    sendApproval: options.sendApproval ?? { confirm },
    ...(options.initializeDrafts ? { initializeDrafts: options.initializeDrafts } : {}),
    ...(options.mutationApproval ? { mutationApproval: options.mutationApproval } : {}),
    now: () => now,
  });
  services.push(service);
  const messageRef = () => coreMessageReferenceCodec.encode({ mailbox: "INBOX", uidValidity: "42", uid: 7, accountScope: testContext(account, "synthetic-secret", revision).scope });
  const prepare = (input: PrepareEmailInput = {}) => service.prepareEmail({ to: ["recipient@example.test"], subject: "Synthetic", text: "Synthetic body", ...input }) as Promise<{ draftId: string; expiresAt: string; preview: Record<string, unknown> }>;
  return { service, drafts, attachments, prepare, send, confirm, connect, move, append, messageRef,
    raw: () => raw, appended: () => appended, switchAccount: () => { revision = "revision-two"; } };
}

describe("integrated draft and attachment management", () => {
  it("keeps read-only startup independent of the journal and waits for one shared recovery barrier before draft operations", async () => {
    let release!: () => void;
    const initializeDrafts = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const h = harness({ initializeDrafts });
    await h.service.getAccountStatus();
    expect(initializeDrafts).not.toHaveBeenCalled();
    const prepared = h.prepare();
    const listed = h.service.listDrafts();
    await vi.waitFor(() => expect(initializeDrafts).toHaveBeenCalledOnce());
    expect(h.drafts.size).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    release();
    await Promise.all([prepared, listed]);
    await h.service.listDrafts();
    expect(initializeDrafts).toHaveBeenCalledOnce();
  });

  it("fails closed on journal recovery failure while leaving account status usable", async () => {
    const h = harness({ initializeDrafts: async () => { throw new DraftError("DRAFT_PERSISTENCE_FAILED", "Synthetic storage failure"); } });
    await expect(h.prepare()).rejects.toMatchObject({ code: "DRAFT_PERSISTENCE_FAILED" });
    expect(h.drafts.size).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    await expect(h.service.getAccountStatus()).resolves.toMatchObject({ configured: true });
  });
  it("lists selected attachment metadata and invalidates a draft when its attachment is removed", async () => {
    const h = harness();
    const selected = await h.service.selectAttachments() as { attachments: OutgoingAttachmentMetadata[] };
    const id = selected.attachments[0]!.attachmentId;
    expect(await h.service.listAttachments()).toEqual({ attachments: selected.attachments });
    expect(JSON.stringify(selected)).not.toContain("C:\\Synthetic");
    const draft = await h.prepare({ attachmentIds: [id] });
    expect(await h.service.removeAttachments({ attachmentIds: [id] })).toEqual({ removed: 1, invalidatedDrafts: 1 });
    expect(await h.service.listAttachments()).toEqual({ attachments: [] });
    await expect(h.service.getDraft(draft)).resolves.toMatchObject({ status: "not_sent", failure: { code: "DRAFT_ATTACHMENTS_INVALID" } });
    await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_ATTACHMENTS_INVALID" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("edits the full draft under the same ID and cancels it with no body retained", async () => {
    const h = harness();
    const draft = await h.prepare();
    const edited = await h.service.updateDraft({ draftId: draft.draftId, to: ["changed@example.test"], subject: "Revised", text: "Revised synthetic body" }) as { draftId: string; expiresAt: string };
    expect(edited.draftId).toBe(draft.draftId);
    expect(edited.expiresAt).toBe(draft.expiresAt);
    await expect(h.service.getDraft(draft)).resolves.toMatchObject({ status: "prepared", preview: { subject: "Revised", text: "Revised synthetic body" } });
    const listed = await h.service.listDrafts();
    expect(listed.drafts.map(entry => entry.draftId)).toEqual([draft.draftId]);
    await expect(h.service.cancelDraft(draft)).resolves.toMatchObject({ status: "cancelled" });
    expect(await h.service.getDraft(draft)).not.toHaveProperty("preview");
    await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_CANCELLED" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("isolates list, get, edit and cancel by the current account revision", async () => {
    const h = harness();
    const draft = await h.prepare();
    h.switchAccount();
    expect(await h.service.listDrafts()).toEqual({ drafts: [] });
    await expect(h.service.getDraft(draft)).rejects.toMatchObject({ code: "DRAFT_ACCOUNT_CHANGED" });
    await expect(h.service.updateDraft({ draftId: draft.draftId, to: ["other@example.test"], text: "other" })).rejects.toMatchObject({ code: "DRAFT_ACCOUNT_CHANGED" });
    await expect(h.service.cancelDraft(draft)).rejects.toMatchObject({ code: "DRAFT_ACCOUNT_CHANGED" });
    await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_ACCOUNT_CHANGED" });
    expect(h.drafts.status(draft.draftId).status).toBe("prepared");
  });

  it("rejects oversized UTF-8 approval content during prepare without opening a window or retaining a draft", async () => {
    const h = harness();
    await expect(h.prepare({ text: "中".repeat(200_000) })).rejects.toMatchObject({ code: "DRAFT_APPROVAL_TOO_LARGE" });
    expect(h.drafts.size).toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  for (const status of ["declined", "timeout", "unavailable", "too_large"] as const) {
    it(`preserves the detailed approval ${status} reason and never reaches SMTP`, async () => {
      const confirm = vi.fn(async () => true);
      const detailed = vi.fn(async () => ({ status }));
      const h = harness({ sendApproval: { confirm, confirmDetailed: detailed } });
      const draft = await h.prepare();
      await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: `DRAFT_APPROVAL_${status.toUpperCase()}` });
      expect(h.drafts.status(draft.draftId).status).toBe("not_sent");
      expect(detailed).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    });
  }
});

describe("trusted mailbox mutation", () => {
  for (const action of ["move", "trash"] as const) {
    it(`denies ${action} without a trusted approval provider`, async () => {
      const h = harness();
      const input = { messageRefs: [h.messageRef()] };
      const result = action === "move" ? h.service.moveEmails({ ...input, destination: "Archive" }) : h.service.trashEmails(input);
      await expect(result).rejects.toMatchObject({ code: "MAIL_CHANGE_APPROVAL_REQUIRED" });
      expect(h.move).not.toHaveBeenCalled();
      expect(h.connect).not.toHaveBeenCalled();
    });

    it(`binds approved ${action} to its account, destination and selected references`, async () => {
      const confirm = vi.fn(async () => ({ status: "approved" as const }));
      const h = harness({ mutationApproval: { confirm } });
      const input = { messageRefs: [h.messageRef()] };
      const result = action === "move" ? h.service.moveEmails({ ...input, destination: "Archive" }) : h.service.trashEmails(input);
      await result;
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ action, account: "sender@qq.com", destination: action === "move" ? "Archive" : "Trash", messages: [expect.objectContaining({ mailbox: "INBOX", uidValidity: "42", uid: 7 })] }));
      expect(h.move).toHaveBeenCalledWith([7], action === "move" ? "Archive" : "Trash");
    });

    it(`blocks ${action} if the account changes while confirmation is open`, async () => {
      let changeAccount: () => void = () => undefined;
      const h = harness({ mutationApproval: { confirm: async () => { changeAccount(); return { status: "approved" }; } } });
      changeAccount = h.switchAccount;
      const input = { messageRefs: [h.messageRef()] };
      const result = action === "move" ? h.service.moveEmails({ ...input, destination: "Archive" }) : h.service.trashEmails(input);
      await expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
      expect(h.move).not.toHaveBeenCalled();
      expect(h.connect).not.toHaveBeenCalled();
    });
  }
});

describe("SMTP outcome and MIME ownership", () => {
  for (const [error, outcome] of [
    [{ code: "ECONNECTION", command: "CONN" }, "delivery_unknown"],
    [{ code: "ESOCKET", command: "CONN", originalCode: "ECONNREFUSED" }, "not_sent"],
    [{ code: "EAUTH", command: "AUTH PLAIN" }, "not_sent"],
    [{ responseCode: 550, command: "RCPT TO" }, "not_sent"],
    [{ responseCode: 554, command: "DATA" }, "not_sent"],
    [{ code: "ETIMEDOUT", command: "DATA" }, "delivery_unknown"],
    [{ code: "ESOCKET", command: "DATA" }, "delivery_unknown"],
    [{ code: "ESOCKET" }, "delivery_unknown"],
  ] as const) {
    it(`classifies ${JSON.stringify(error)} as ${outcome}`, () => {
      expect(classifySmtpFailure(error)).toMatchObject({ outcome });
    });
  }

  it("retains an ambiguous send result and the prepared Message-ID across repeated requests", async () => {
    const h = harness({ delivery: async () => { throw new DeliveryFailure("delivery_unknown"); } });
    const draft = await h.prepare();
    const preparedMessageId = h.drafts.getPayload(draft.draftId).messageId;
    expect(preparedMessageId).toMatch(/^<[a-f0-9]{48}@qq-mail\.local>$/u);
    const first = await h.service.sendEmail(draft);
    expect(first).toMatchObject({ status: "delivery_unknown", sent: null, messageId: preparedMessageId });
    expect(await h.service.sendEmail(draft)).toEqual(first);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![3].messageId).toBe(preparedMessageId);
    expect(h.append).not.toHaveBeenCalled();
    expect(await h.service.getDraft(draft)).toMatchObject({ status: "delivery_unknown", attempt: { messageId: preparedMessageId } });
  });

  it("reports a definite SMTP rejection without another automatic attempt", async () => {
    const h = harness({ delivery: async () => { throw new DeliveryFailure("not_sent"); } });
    const draft = await h.prepare();
    await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_SEND_FAILED" });
    await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_SEND_FAILED" });
    expect(h.drafts.status(draft.draftId).status).toBe("not_sent");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  for (const sentCopyFails of [false, true]) {
    it(`wipes the owned complete MIME after the Sent copy ${sentCopyFails ? "fails" : "succeeds"}`, async () => {
      const h = harness({ sentCopyFails });
      const draft = await h.prepare();
      const result = await h.service.sendEmail(draft);
      expect(result).toMatchObject({ sent: true, status: sentCopyFails ? "sent_copy_failed" : "sent" });
      expect(h.appended()!.toString("utf8")).toContain("Synthetic body");
      expect(h.appended()!.toString("utf8")).toContain(h.send.mock.calls[0]![3].messageId);
      expect(h.raw()!.every(byte => byte === 0)).toBe(true);
      expect(await h.service.sendEmail(draft)).toEqual(result);
      expect(h.send).toHaveBeenCalledTimes(1);
    });
  }
});
