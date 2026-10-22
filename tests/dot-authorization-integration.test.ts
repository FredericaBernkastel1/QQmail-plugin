import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftStore } from "../src/drafts.js";
import { DeliveryFailure } from "../src/errors.js";
import { MailAuthorizationStore, type MailAuthorizationRequestInput } from "../src/mail-authorization.js";
import { OutgoingAttachmentStore, type OutgoingAttachmentRepository } from "../src/outgoing-attachments.js";
import { QqMailService } from "../src/mail/service.js";
import { coreMessageReferenceCodec } from "../src/mail/adapters.js";
import type { ImapSession, MailAccountConfig, OutgoingMessage, SmtpGateway } from "../src/mail/types.js";
import { testContext } from "./account-fixtures.js";

const services: QqMailService[] = [];
afterEach(() => { services.splice(0).forEach(service => service.dispose()); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(options: {
  approved?: boolean;
  requireAuthorization?: boolean;
  nativeApproved?: boolean;
  selectedFiles?: boolean;
  acquireGate?: () => Promise<void>;
  selectGate?: () => Promise<void>;
  deliveryUnknown?: boolean;
} = {}) {
  let now = Date.parse("2026-10-21T00:00:00.000Z");
  const account: MailAccountConfig = {
    email: "synthetic@qq.com", username: "synthetic@qq.com", displayName: "Synthetic",
    imap: { host: "imap.qq.com", port: 993, security: "tls" },
    smtp: { host: "smtp.qq.com", port: 465, security: "tls" },
    folders: { inbox: "INBOX", sent: "Sent", trash: "Trash" },
    downloadDirectory: "C:\\Synthetic\\Downloads", downloadLimitBytes: 1024,
  };
  const context = testContext(account, "synthetic-secret", "revision-one");
  const addFlags = vi.fn(async () => undefined);
  const removeFlags = vi.fn(async () => undefined);
  const moveMessages = vi.fn(async () => undefined);
  const selectMailbox = vi.fn(async (mailbox: string) => {
    await options.selectGate?.();
    return { path: mailbox, uidValidity: "42", exists: 2, readOnly: false };
  });
  const session = {
    listMailboxes: vi.fn(async () => ["INBOX", "Sent", "Trash"].map(mailbox => ({ path: mailbox, delimiter: "/", subscribed: true, flags: [] }))),
    selectMailbox, addFlags, removeFlags, moveMessages,
    appendMessage: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  } as unknown as ImapSession;
  const connect = vi.fn(async () => session);
  const deliveredAttachments: Array<{ filename: string; content: string }> = [];
  const send = vi.fn<SmtpGateway["send"]>(async (_config, _username, _secret, message, attachments = []) => {
    if (options.deliveryUnknown) throw new DeliveryFailure("delivery_unknown");
    deliveredAttachments.push(...attachments.map(entry => ({ filename: entry.filename, content: entry.content.toString("utf8") })));
    return { messageId: message.messageId!, accepted: message.to.map(recipient => recipient.address), rejected: [], rawMessage: Buffer.from("Synthetic sent MIME") };
  });
  const sendApproval = vi.fn(async () => options.nativeApproved !== false);
  const mutationApproval = vi.fn(async () => ({ status: options.nativeApproved === false ? "declined" as const : "approved" as const }));
  const authorizationApprover = vi.fn(async () => ({ status: options.approved === false ? "declined" as const : "approved" as const }));
  const store = new MailAuthorizationStore({ now: () => now });
  const drafts = new DraftStore<OutgoingMessage, Record<string, unknown>>({ now: () => now });
  const selectFiles = vi.fn(async () => options.selectedFiles ? ["C:\\Synthetic\\attachment.txt"] : []);
  const attachments = new OutgoingAttachmentStore({ now: () => now, read: async () => Buffer.from("Synthetic attachment snapshot") });
  const acquire = vi.fn(async (ids: readonly string[], scope: string) => {
    await options.acquireGate?.();
    return attachments.acquire(ids, scope);
  });
  const repository: OutgoingAttachmentRepository = {
    importSelected: (paths, scope) => attachments.importSelected(paths, scope),
    metadata: (ids, scope) => attachments.metadata(ids, scope), list: scope => attachments.list(scope),
    acquire, release: entries => attachments.release(entries), remove: ids => attachments.remove(ids),
    dispose: () => attachments.dispose(),
  };
  const service = new QqMailService({
    accountProvider: { getContext: async () => context }, referenceCodec: coreMessageReferenceCodec,
    draftStore: drafts, attachmentStorage: { save: vi.fn() }, outgoingAttachments: repository,
    attachmentPicker: { select: selectFiles },
    imapGateway: { connect }, smtpGateway: { send, verify: vi.fn(async () => undefined) },
    sendApproval: { confirm: sendApproval }, mutationApproval: { confirm: mutationApproval },
    authorizationStore: store, authorizationApprover, requireAuthorization: options.requireAuthorization ?? true, now: () => now,
  });
  services.push(service);
  const messageRef = (uid = 7) => coreMessageReferenceCodec.encode({ mailbox: "INBOX", uidValidity: "42", uid, accountScope: context.scope });
  const grant = (input: Partial<MailAuthorizationRequestInput> = {}) => service.requestMailAuthorization({
    actions: ["edit_draft", "send"], recipients: ["recipient@example.test"],
    maxOperations: 10, expiresInSeconds: 60, purpose: "Synthetic bounded mail task", ...input,
  });
  return { service, drafts, store, grant, messageRef, connect, send, sendApproval, mutationApproval,
    authorizationApprover, addFlags, removeFlags, moveMessages, selectMailbox, acquire, selectFiles, deliveredAttachments,
    advance: (milliseconds: number) => { now += milliseconds; } };
}

describe("interactive profile optional task authorization", () => {
  it.each([false, true])("preserves attachment selection, draft editing and sending with grant=%s", async (useGrant) => {
    const h = harness({ requireAuthorization: false, selectedFiles: true });
    await expect(h.service.selectAttachments()).resolves.toMatchObject({ status: "selected" });
    const selected = (await h.service.listAttachments()).attachments;
    expect(selected).toHaveLength(1);
    const attachmentIds = selected.map(entry => entry.attachmentId);
    const authorizationId = useGrant ? (await h.grant({ maxOperations: 3 })).authorizationId : undefined;
    const draft = await h.service.prepareEmail({ authorizationId, to: ["recipient@example.test"], text: "Original", attachmentIds });
    expect(draft).toMatchObject({ confirmationRequired: !useGrant, authorizationRequired: false });
    expect(draft.preview.attachments).toEqual(selected);
    const edited = await h.service.updateDraft({
      draftId: draft.draftId, authorizationId, to: ["recipient@example.test"], subject: "Edited", text: "Replacement body", attachmentIds,
    });
    expect(edited).toMatchObject({ confirmationRequired: !useGrant, authorizationRequired: false });
    await expect(h.service.sendEmail({ draftId: draft.draftId, authorizationId })).resolves.toMatchObject({ sent: true });
    expect(h.selectFiles).toHaveBeenCalledExactlyOnceWith("synthetic@qq.com");
    expect(h.authorizationApprover).toHaveBeenCalledTimes(useGrant ? 1 : 0);
    expect(h.sendApproval).toHaveBeenCalledTimes(useGrant ? 0 : 1);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![3]).toMatchObject({ subject: "Edited", text: "Replacement body", attachmentIds });
    expect(h.deliveredAttachments).toEqual([{ filename: "attachment.txt", content: "Synthetic attachment snapshot" }]);
    if (useGrant) expect((await h.service.listMailAuthorizations()).authorizations[0]?.remainingOperations).toBe(0);
    await h.service.removeAttachments({ attachmentIds });
    expect((await h.service.listAttachments()).attachments).toEqual([]);
  });

  it("retains independent confirmation denial for ordinary interactive sending and Trash", async () => {
    const h = harness({ requireAuthorization: false, nativeApproved: false });
    const draft = await h.service.prepareEmail({ to: ["recipient@example.test"], text: "Synthetic" });
    await expect(h.service.sendEmail({ draftId: draft.draftId })).rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
    await expect(h.service.trashEmails({ messageRefs: [h.messageRef()] })).rejects.toMatchObject({ code: "MAIL_CHANGE_APPROVAL_REQUIRED" });
    expect(h.sendApproval).toHaveBeenCalledOnce();
    expect(h.mutationApproval).toHaveBeenCalledOnce();
    expect(h.authorizationApprover).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.moveMessages).not.toHaveBeenCalled();
  });

  it("applies the Windows preview size limit only when this preparation has no task authorization", async () => {
    const h = harness({ requireAuthorization: false });
    const input = { to: ["recipient@example.test"], text: "x".repeat(300_000), html: "y".repeat(300_000) };
    await expect(h.service.prepareEmail(input)).rejects.toMatchObject({ code: "DRAFT_APPROVAL_TOO_LARGE" });
    const grant = await h.grant({ actions: ["edit_draft"], maxOperations: 2 });
    const draft = await h.service.prepareEmail({ ...input, authorizationId: grant.authorizationId });
    expect(draft.confirmationRequired).toBe(false);
    await expect(h.service.updateDraft({ ...input, draftId: draft.draftId, subject: "Large update" }))
      .rejects.toMatchObject({ code: "DRAFT_APPROVAL_TOO_LARGE" });
    const edited = await h.service.updateDraft({ ...input, draftId: draft.draftId, subject: "Large update", authorizationId: grant.authorizationId });
    expect(edited.confirmationRequired).toBe(false);
    // An edit grant never carries send authority, even when its preview exceeds a window limit.
    await expect(h.service.sendEmail({ draftId: draft.draftId, authorizationId: grant.authorizationId }))
      .rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
    expect(h.sendApproval).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("never ignores an unknown grant on any interactive write or falls back to native approval", async () => {
    const h = harness({ requireAuthorization: false });
    const draft = await h.service.prepareEmail({ to: ["recipient@example.test"], text: "Original" });
    const authorizationId = "unknown-authorization";
    await expect(h.service.prepareEmail({ authorizationId, to: ["recipient@example.test"], text: "Denied" }))
      .rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_INVALID" });
    await expect(h.service.updateDraft({ draftId: draft.draftId, authorizationId, to: ["recipient@example.test"], subject: "Denied", text: "Denied" }))
      .rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_INVALID" });
    await expect(h.service.cancelDraft({ draftId: draft.draftId, authorizationId })).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_INVALID" });
    expect(h.drafts.getPayload(draft.draftId).text).toBe("Original");
    await expect(h.service.setEmailFlags({ authorizationId, messageRefs: [h.messageRef()], read: true }))
      .rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_INVALID" });
    await expect(h.service.trashEmails({ authorizationId, messageRefs: [h.messageRef()] }))
      .rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_INVALID" });
    await expect(h.service.sendEmail({ draftId: draft.draftId, authorizationId })).rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
    expect(h.drafts.status(draft.draftId).status).toBe("not_sent");
    expect(h.sendApproval).not.toHaveBeenCalled();
    expect(h.mutationApproval).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.addFlags).not.toHaveBeenCalled();
    expect(h.removeFlags).not.toHaveBeenCalled();
    expect(h.moveMessages).not.toHaveBeenCalled();
  });

  it.each(["expired", "revoked", "exhausted"] as const)("never falls back to native approval for a %s interactive grant", async (cause) => {
    const h = harness({ requireAuthorization: false });
    const grant = await h.grant({ actions: ["send", "trash"], messageRefs: [h.messageRef()], maxOperations: 1 });
    const draft = await h.service.prepareEmail({ to: ["recipient@example.test"], text: "Synthetic" });
    const input = { authorizationId: grant.authorizationId, messageRefs: [h.messageRef()] };
    if (cause === "revoked") await h.service.revokeMailAuthorization({ authorizationId: grant.authorizationId });
    else if (cause === "expired") h.advance(60_001);
    else await h.service.trashEmails(input);
    const expectedCode = { expired: "MAIL_AUTHORIZATION_EXPIRED", revoked: "MAIL_AUTHORIZATION_INVALID", exhausted: "MAIL_AUTHORIZATION_EXHAUSTED" }[cause];
    await expect(h.service.trashEmails(input)).rejects.toMatchObject({ code: expectedCode });
    await expect(h.service.sendEmail({ draftId: draft.draftId, authorizationId: grant.authorizationId }))
      .rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
    expect(h.sendApproval).not.toHaveBeenCalled();
    expect(h.mutationApproval).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.moveMessages).toHaveBeenCalledTimes(cause === "exhausted" ? 1 : 0);
  });
});

describe("authorized profile mail service boundary", () => {
  it("rejects absent authorization before draft editing, SMTP or IMAP mutation", async () => {
    const h = harness();
    await expect(h.service.prepareEmail({ to: ["recipient@example.test"], text: "Synthetic" })).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    await expect(h.service.setEmailFlags({ messageRefs: [h.messageRef()], read: true })).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    await expect(h.service.trashEmails({ messageRefs: [h.messageRef()] })).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    const grant = await h.grant({ actions: ["edit_draft"] });
    const draft = await h.service.prepareEmail({ authorizationId: grant.authorizationId, to: ["recipient@example.test"], text: "Synthetic" });
    await expect(h.service.updateDraft({ draftId: draft.draftId, to: ["recipient@example.test"], subject: "Edit", text: "Synthetic edit" })).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    await expect(h.service.cancelDraft(draft)).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
    expect(h.drafts.status(draft.draftId).status).toBe("not_sent");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.addFlags).not.toHaveBeenCalled();
    expect(h.removeFlags).not.toHaveBeenCalled();
    expect(h.moveMessages).not.toHaveBeenCalled();
    expect(h.sendApproval).not.toHaveBeenCalled();
    expect(h.mutationApproval).not.toHaveBeenCalled();
  });

  it("creates no authority when the trusted user declines", async () => {
    const h = harness({ approved: false });
    await expect(h.grant()).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_DECLINED" });
    expect(await h.service.listMailAuthorizations()).toMatchObject({ authorizations: [], survivesRestart: false });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.moveMessages).not.toHaveBeenCalled();
  });

  it("uses one bounded grant for prepare, edit and send including its final unit", async () => {
    const h = harness();
    const grant = await h.grant({ maxOperations: 3 });
    const draft = await h.service.prepareEmail({ authorizationId: grant.authorizationId, to: ["recipient@example.test"], text: "Original" });
    await h.service.updateDraft({ draftId: draft.draftId, authorizationId: grant.authorizationId, to: ["recipient@example.test"], subject: "Edited", text: "Replacement body" });
    await expect(h.service.sendEmail({ draftId: draft.draftId, authorizationId: grant.authorizationId })).resolves.toMatchObject({ sent: true });
    expect(h.authorizationApprover).toHaveBeenCalledTimes(1);
    expect(h.sendApproval).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![3]).toMatchObject({ subject: "Edited", text: "Replacement body" });
    expect((await h.service.listMailAuthorizations()).authorizations[0]?.remainingOperations).toBe(0);
    await expect(h.service.prepareEmail({ authorizationId: grant.authorizationId, to: ["recipient@example.test"], text: "Exhausted" })).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_EXHAUSTED" });
  });

  it("permits an authorized draft within mail limits without imposing a Windows window payload limit", async () => {
    const h = harness();
    const grant = await h.grant({ actions: ["edit_draft"] });
    const draft = await h.service.prepareEmail({ authorizationId: grant.authorizationId, to: ["recipient@example.test"], text: "Synthetic", html: "x".repeat(300_000) });
    expect(draft.confirmationRequired).toBe(false);
    expect(draft.authorizationRequired).toBe(true);
    expect(h.sendApproval).not.toHaveBeenCalled();
  });

  it("does not treat a valid edit-only grant as permission to send", async () => {
    const h = harness();
    const grant = await h.grant({ actions: ["edit_draft"] });
    const draft = await h.service.prepareEmail({ authorizationId: grant.authorizationId, to: ["recipient@example.test"], text: "Synthetic" });
    await expect(h.service.sendEmail({ draftId: draft.draftId, authorizationId: grant.authorizationId }))
      .rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
    expect(h.drafts.status(draft.draftId).status).toBe("not_sent");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.sendApproval).not.toHaveBeenCalled();
  });

  for (const field of ["to", "cc", "bcc"] as const) {
    it(`blocks an unlisted ${field} recipient before SMTP`, async () => {
      const h = harness();
      const grant = await h.grant();
      const draft = await h.service.prepareEmail({
        authorizationId: grant.authorizationId, to: ["recipient@example.test"], text: "Synthetic",
        [field]: ["outside@example.test"],
      });
      await expect(h.service.sendEmail({ draftId: draft.draftId, authorizationId: grant.authorizationId }))
        .rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
      expect(h.drafts.status(draft.draftId).status).toBe("not_sent");
      expect(h.send).not.toHaveBeenCalled();
      expect(h.sendApproval).not.toHaveBeenCalled();
    });
  }

  it("limits Trash and flag changes to approved references and charges each message", async () => {
    const h = harness();
    const grant = await h.grant({ actions: ["trash", "flags"], recipients: [], messageRefs: [h.messageRef(7), h.messageRef(8)], maxOperations: 3 });
    await expect(h.service.trashEmails({ authorizationId: grant.authorizationId, messageRefs: [h.messageRef(9)] }))
      .rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_MESSAGE_DENIED" });
    await expect(h.service.setEmailFlags({ authorizationId: grant.authorizationId, messageRefs: [h.messageRef(9)], read: true }))
      .rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_MESSAGE_DENIED" });
    expect(h.moveMessages).not.toHaveBeenCalled();
    expect(h.addFlags).not.toHaveBeenCalled();
    await h.service.setEmailFlags({ authorizationId: grant.authorizationId, messageRefs: [h.messageRef(7)], starred: true });
    await h.service.trashEmails({ authorizationId: grant.authorizationId, messageRefs: [h.messageRef(7), h.messageRef(8)] });
    expect(h.addFlags).toHaveBeenCalledWith([7], ["\\Flagged"]);
    expect(h.moveMessages).toHaveBeenCalledWith([7, 8], "Trash");
    expect(h.mutationApproval).not.toHaveBeenCalled();
    expect((await h.service.listMailAuthorizations()).authorizations[0]?.remainingOperations).toBe(0);
    await expect(h.service.trashEmails({ authorizationId: grant.authorizationId, messageRefs: [h.messageRef(7)] }))
      .rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_EXHAUSTED" });
    expect(h.moveMessages).toHaveBeenCalledTimes(1);
  });

  for (const cause of ["revoked", "expired"] as const) {
    it(`blocks an unused send grant after it is ${cause}`, async () => {
      const h = harness();
      const grant = await h.grant();
      const draft = await h.service.prepareEmail({ authorizationId: grant.authorizationId, to: ["recipient@example.test"], text: "Synthetic" });
      if (cause === "revoked") await h.service.revokeMailAuthorization({ authorizationId: grant.authorizationId });
      else h.advance(60_001);
      await expect(h.service.sendEmail({ draftId: draft.draftId, authorizationId: grant.authorizationId }))
        .rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
      expect(h.drafts.status(draft.draftId).status).toBe("not_sent");
      expect(h.send).not.toHaveBeenCalled();
    });
  }

  it("rechecks a consumed send grant after waiting for attachment acquisition", async () => {
    const gate = deferred();
    const h = harness({ acquireGate: () => gate.promise });
    const grant = await h.grant();
    const draft = await h.service.prepareEmail({ authorizationId: grant.authorizationId, to: ["recipient@example.test"], text: "Synthetic" });
    const outcome = h.service.sendEmail({ draftId: draft.draftId, authorizationId: grant.authorizationId })
      .then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(h.acquire).toHaveBeenCalledTimes(1));
    await h.service.revokeMailAuthorization({ authorizationId: grant.authorizationId });
    gate.resolve();
    expect(await outcome).toMatchObject({ error: { code: "DRAFT_APPROVAL_REQUIRED" } });
    expect(h.drafts.status(draft.draftId).status).toBe("not_sent");
    expect(h.send).not.toHaveBeenCalled();
  });

  for (const action of ["flags", "trash"] as const) {
    it(`rechecks a consumed ${action} grant after mailbox selection`, async () => {
      const gate = deferred();
      const h = harness({ selectGate: () => gate.promise });
      const grant = await h.grant({ actions: [action], recipients: [], messageRefs: [h.messageRef()] });
      const input = { authorizationId: grant.authorizationId, messageRefs: [h.messageRef()] };
      const pending = (action === "flags" ? h.service.setEmailFlags({ ...input, read: true }) : h.service.trashEmails(input))
        .then(value => ({ value }), error => ({ error }));
      await vi.waitFor(() => expect(h.selectMailbox).toHaveBeenCalledTimes(1));
      await h.service.revokeMailAuthorization({ authorizationId: grant.authorizationId });
      gate.resolve();
      expect(await pending).toMatchObject({ error: { code: "MAIL_AUTHORIZATION_INVALID" } });
      expect(h.addFlags).not.toHaveBeenCalled();
      expect(h.removeFlags).not.toHaveBeenCalled();
      expect(h.moveMessages).not.toHaveBeenCalled();
    });
  }

  it("returns an unknown SMTP outcome on repetition without another delivery", async () => {
    const h = harness({ deliveryUnknown: true });
    const grant = await h.grant({ maxOperations: 2 });
    const draft = await h.service.prepareEmail({ authorizationId: grant.authorizationId, to: ["recipient@example.test"], text: "Synthetic" });
    const input = { draftId: draft.draftId, authorizationId: grant.authorizationId };
    const first = await h.service.sendEmail(input);
    expect(first).toMatchObject({ status: "delivery_unknown", sent: null });
    expect(await h.service.sendEmail(input)).toEqual(first);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect((await h.service.listMailAuthorizations()).authorizations[0]?.remainingOperations).toBe(0);
  });
});
