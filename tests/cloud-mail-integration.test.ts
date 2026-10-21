import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAuthority } from "../src/cloud/authority.js";
import type { CloudPrincipal } from "../src/cloud/auth.js";
import { DraftStore } from "../src/drafts.js";
import { MailAuthorizationStore, type MailAuthorizationAction, type MailAuthorizationRequestInput } from "../src/mail-authorization.js";
import { OutgoingAttachmentStore, type OutgoingAttachmentRepository } from "../src/outgoing-attachments.js";
import { QqMailService } from "../src/mail/service.js";
import { coreMessageReferenceCodec } from "../src/mail/adapters.js";
import type { ImapSession, MailAccountConfig, OutgoingMessage, SmtpGateway } from "../src/mail/types.js";
import { testContext } from "./account-fixtures.js";

// Native helpers must never run in this cloud composition, even on the Windows test host.
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(() => { throw new Error("A cloud operation attempted to launch a native helper"); }),
}));

const services: QqMailService[] = [];
afterEach(() => {
  try { expect(spawn).not.toHaveBeenCalled(); }
  finally { services.splice(0).forEach(service => service.dispose()); vi.mocked(spawn).mockClear(); }
});
const actionScopes: Record<MailAuthorizationAction, string> = {
  edit_draft: "mail.drafts.write", send: "mail.send", trash: "mail.trash", flags: "mail.flags.write",
};

function harness(options: {
  beforeSmtpGuard?: (guard: () => Promise<void>) => Promise<void>;
  beforeSelect?: () => Promise<void>;
  afterAddFlags?: () => Promise<void>;
  beforeReserve?: () => Promise<void>;
} = {}) {
  let now = Date.parse("2026-10-21T00:00:00.000Z");
  const account: MailAccountConfig = {
    email: "cloud-synthetic@qq.com", username: "cloud-synthetic@qq.com", displayName: "Cloud synthetic",
    imap: { host: "imap.qq.com", port: 993, security: "tls" },
    smtp: { host: "smtp.qq.com", port: 465, security: "tls" },
    folders: { inbox: "INBOX", sent: "Sent", trash: "Trash" },
    attachmentsDisabled: true, downloadDirectory: "", downloadLimitBytes: 1_024,
  };
  const accountContext = testContext(account, "synthetic-cloud-credential", "cloud-one");
  const principal: CloudPrincipal = Object.freeze({
    subject: "synthetic-owner", clientId: "synthetic-dot",
    scopes: Object.freeze(["mail.read", "mail.drafts.read", "mail.authorize", ...Object.values(actionScopes)]),
    expiresAt: now + 600_000,
  });
  let remaining = 100;
  const reserve = vi.fn(async (units: number) => {
    if (units > remaining) throw new Error("Synthetic standing delegation exhausted");
    remaining -= units;
    await options.beforeReserve?.();
  });
  const authority = new CloudAuthority({
    consentId: "synthetic-cloud-owner-consent", actions: ["edit_draft", "send", "trash", "flags"],
    recipients: ["recipient@example.test"], maxOperations: 100, expiresAt: new Date(now + 3_600_000).toISOString(),
  }, reserve, () => now);
  const authorizationStore = new MailAuthorizationStore({ now: () => now });
  const drafts = new DraftStore<OutgoingMessage, Record<string, unknown>>({ now: () => now });
  const attachments = new OutgoingAttachmentStore({ now: () => now });
  const nativeApproval = vi.fn(async (): Promise<never> => { throw new Error("Native send approval is forbidden in cloud"); });
  const nativeMutation = vi.fn(async (): Promise<never> => { throw new Error("Native mutation approval is forbidden in cloud"); });
  const nativePicker = vi.fn(async (): Promise<never> => { throw new Error("Native picker is forbidden in cloud"); });
  const saveAttachment = vi.fn(async (): Promise<never> => { throw new Error("Local attachment storage is forbidden in cloud"); });
  const addFlags = vi.fn(async () => { await options.afterAddFlags?.(); });
  const removeFlags = vi.fn(async () => undefined);
  const moveMessages = vi.fn(async () => undefined);
  const appendMessage = vi.fn(async () => undefined);
  const selectMailbox = vi.fn(async (mailbox: string) => {
    await options.beforeSelect?.();
    return { path: mailbox, uidValidity: "42", exists: 2, readOnly: false };
  });
  const session = {
    listMailboxes: vi.fn(async () => ["INBOX", "Sent", "Trash"].map(mailbox => ({ path: mailbox, delimiter: "/", subscribed: true, flags: [] }))),
    selectMailbox, addFlags, removeFlags, moveMessages, appendMessage, close: vi.fn(async () => undefined),
  } as unknown as ImapSession;
  const connect = vi.fn(async () => session);
  const smtpDispatched = vi.fn<(message: OutgoingMessage) => void>();
  const send = vi.fn<SmtpGateway["send"]>(async (_config, _username, _credential, message, _attachments, beforeDispatch) => {
    // Mirrors the production gateway's final callback after asynchronous MIME preparation.
    if (!beforeDispatch) throw new Error("The cloud service did not supply a final dispatch guard");
    await Promise.resolve();
    if (options.beforeSmtpGuard) await options.beforeSmtpGuard(beforeDispatch);
    else await beforeDispatch();
    smtpDispatched(message);
    return { messageId: message.messageId!, accepted: message.to.map(recipient => recipient.address), rejected: [], rawMessage: Buffer.from("Synthetic cloud MIME") };
  });
  const repository: OutgoingAttachmentRepository = {
    importSelected: (paths, scope) => attachments.importSelected(paths, scope),
    metadata: (ids, scope) => attachments.metadata(ids, scope), list: scope => attachments.list(scope),
    acquire: (ids, scope) => attachments.acquire(ids, scope), release: entries => attachments.release(entries),
    remove: ids => attachments.remove(ids), dispose: () => attachments.dispose(),
  };
  const service = new QqMailService({
    accountProvider: { getContext: async () => accountContext }, referenceCodec: coreMessageReferenceCodec,
    draftStore: drafts, outgoingAttachments: repository, attachmentStorage: { save: saveAttachment },
    smtpGateway: { send, verify: vi.fn(async () => undefined) }, imapGateway: { connect },
    sendApproval: { confirm: nativeApproval }, mutationApproval: { confirm: nativeMutation }, attachmentPicker: { select: nativePicker },
    requireAuthorization: true, authorizationStore, authorizationApprover: authority.approve,
    assertWriteAuthority: authority.assertWrite, now: () => now,
  });
  services.push(service);
  const messageRef = (uid = 7) => coreMessageReferenceCodec.encode({ mailbox: "INBOX", uidValidity: "42", uid, accountScope: accountContext.scope });
  const grant = (overrides: Partial<MailAuthorizationRequestInput> = {}) => authority.run(principal, () => service.requestMailAuthorization({
    actions: ["edit_draft", "send", "trash", "flags"], recipients: ["recipient@example.test"], messageRefs: [messageRef()],
    maxOperations: 20, expiresInSeconds: 300, purpose: "Synthetic bounded cloud task", ...overrides,
  }));
  const prepare = (authorizationId: string) => authority.run(principal, () => service.prepareEmail({
    authorizationId, to: ["recipient@example.test"], subject: "Cloud synthetic", text: "Synthetic body",
  }));
  const assertNoNative = () => {
    for (const helper of [nativeApproval, nativeMutation, nativePicker, saveAttachment, vi.mocked(spawn)]) expect(helper).not.toHaveBeenCalled();
  };
  return { service, authority, principal, grant, prepare, drafts, authorizationStore, messageRef,
    reserve, connect, send, smtpDispatched, addFlags, removeFlags, moveMessages, appendMessage, selectMailbox,
    nativeApproval, nativeMutation, nativePicker, assertNoNative,
    advance: (milliseconds: number) => { now += milliseconds; }, now: () => now, remaining: () => remaining };
}

describe("cloud authority composed with the real mail service", () => {
  it("permits bounded draft, SMTP and IMAP operations without native helpers", async () => {
    const h = harness();
    const grant = await h.grant({ maxOperations: 5 });
    const draft = await h.prepare(grant.authorizationId);
    await h.authority.run(h.principal, async () => {
      await h.service.updateDraft({ draftId: draft.draftId, authorizationId: grant.authorizationId,
        to: ["recipient@example.test"], subject: "Updated", text: "Cloud replacement" });
      await expect(h.service.sendEmail({ draftId: draft.draftId, authorizationId: grant.authorizationId })).resolves.toMatchObject({ sent: true });
      await h.service.setEmailFlags({ authorizationId: grant.authorizationId, messageRefs: [h.messageRef()], read: true });
      await h.service.trashEmails({ authorizationId: grant.authorizationId, messageRefs: [h.messageRef()] });
      expect((await h.service.listMailAuthorizations()).authorizations[0]?.remainingOperations).toBe(0);
      await expect(h.service.selectAttachments()).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    });
    expect(h.reserve).toHaveBeenCalledExactlyOnceWith(5);
    expect(h.smtpDispatched).toHaveBeenCalledOnce();
    expect(h.appendMessage).toHaveBeenCalledOnce();
    expect(h.addFlags).toHaveBeenCalledWith([7], ["\\Seen"]);
    expect(h.moveMessages).toHaveBeenCalledWith([7], "Trash");
    h.assertNoNative();
  });

  for (const action of ["edit_draft", "send", "flags", "trash"] as const) {
    for (const missing of ["action", "mail.authorize"] as const) {
      it(`does not let a grant issued with broader permissions bypass missing ${missing} scope for ${action}`, async () => {
        const h = harness();
        const grant = await h.grant();
        const draft = action === "send" ? await h.prepare(grant.authorizationId) : undefined;
        const before = (await h.service.listMailAuthorizations()).authorizations[0]!.remainingOperations;
        const reduced = { ...h.principal, scopes: h.principal.scopes.filter(scope => scope !== (missing === "action" ? actionScopes[action] : missing)) };
        await h.authority.run(reduced, async () => {
          const input = { authorizationId: grant.authorizationId, messageRefs: [h.messageRef()] };
          const operation = action === "send" ? h.service.sendEmail({ ...input, draftId: draft!.draftId })
            : action === "edit_draft" ? h.service.prepareEmail({ ...input, to: ["recipient@example.test"], text: "Must be denied" })
            : action === "flags" ? h.service.setEmailFlags({ ...input, read: true }) : h.service.trashEmails(input);
          await expect(operation).rejects.toMatchObject({ code: action === "send" ? "DRAFT_APPROVAL_REQUIRED" : "OAUTH_SCOPE_REQUIRED" });
        });
        expect((await h.service.listMailAuthorizations()).authorizations[0]?.remainingOperations).toBe(before);
        expect(h.smtpDispatched).not.toHaveBeenCalled();
        expect(h.addFlags).not.toHaveBeenCalled();
        expect(h.removeFlags).not.toHaveBeenCalled();
        expect(h.moveMessages).not.toHaveBeenCalled();
        h.assertNoNative();
      });
    }
  }

  for (const failure of ["cancelled", "token_expired"] as const) {
    it(`rejects ${failure} at the final SMTP guard while the consumed grant is still valid`, async () => {
      const controller = new AbortController();
      const h = harness({ beforeSmtpGuard: async guard => {
        if (failure === "cancelled") controller.abort(); else h.advance(1_000);
        await guard();
      } });
      const grant = await h.grant();
      const draft = await h.prepare(grant.authorizationId);
      const shortPrincipal = { ...h.principal, expiresAt: h.now() + 1_000 };
      await expect(h.authority.run(shortPrincipal, () => h.service.sendEmail({
        authorizationId: grant.authorizationId, draftId: draft.draftId,
      }), controller.signal)).rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
      expect(h.now()).toBeLessThan(grant.expiresAt);
      expect(h.send).toHaveBeenCalledOnce();
      expect(h.smtpDispatched).not.toHaveBeenCalled();
      expect(h.drafts.status(draft.draftId).status).toBe("not_sent");
      expect((await h.service.listMailAuthorizations()).authorizations[0]?.remainingOperations).toBe(18);
      h.assertNoNative();
    });

    for (const action of ["flags", "trash"] as const) {
      it(`rejects ${failure} after IMAP selection and before ${action} mutation`, async () => {
        const controller = new AbortController();
        const h = harness({ beforeSelect: async () => {
          await Promise.resolve();
          if (failure === "cancelled") controller.abort(); else h.advance(1_000);
        } });
        const grant = await h.grant();
        const shortPrincipal = { ...h.principal, expiresAt: h.now() + 1_000 };
        await expect(h.authority.run(shortPrincipal, () => {
          const input = { authorizationId: grant.authorizationId, messageRefs: [h.messageRef()] };
          return action === "flags" ? h.service.setEmailFlags({ ...input, read: true }) : h.service.trashEmails(input);
        }, controller.signal)).rejects.toMatchObject({ code: "OAUTH_SCOPE_REQUIRED" });
        expect(h.now()).toBeLessThan(grant.expiresAt);
        expect(h.connect).toHaveBeenCalledOnce();
        expect(h.selectMailbox).toHaveBeenCalledOnce();
        expect(h.addFlags).not.toHaveBeenCalled();
        expect(h.removeFlags).not.toHaveBeenCalled();
        expect(h.moveMessages).not.toHaveBeenCalled();
        expect((await h.service.listMailAuthorizations()).authorizations[0]?.remainingOperations).toBe(19);
        h.assertNoNative();
      });
    }
  }

  it("checks the current scope again inside the final SMTP callback", async () => {
    const h = harness({ beforeSmtpGuard: guard => h.authority.run({
      ...h.principal, scopes: h.principal.scopes.filter(scope => scope !== "mail.send"),
    }, guard) });
    const grant = await h.grant();
    const draft = await h.prepare(grant.authorizationId);
    await expect(h.authority.run(h.principal, () => h.service.sendEmail({
      authorizationId: grant.authorizationId, draftId: draft.draftId,
    }))).rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.smtpDispatched).not.toHaveBeenCalled();
    h.assertNoNative();
  });

  it("reports partial flag work after cancellation and blocks its second IMAP write", async () => {
    const controller = new AbortController();
    const h = harness({ afterAddFlags: async () => { controller.abort(); } });
    const grant = await h.grant();
    await expect(h.authority.run(h.principal, () => h.service.setEmailFlags({
      authorizationId: grant.authorizationId, messageRefs: [h.messageRef()], read: true, starred: false,
    }), controller.signal)).resolves.toMatchObject({ ok: false, status: "partial_failure", updated: 0,
      unconfirmed: 1, failure: { code: "OAUTH_SCOPE_REQUIRED" } });
    expect(h.addFlags).toHaveBeenCalledOnce();
    expect(h.removeFlags).not.toHaveBeenCalled();
    expect((await h.service.listMailAuthorizations()).authorizations[0]?.remainingOperations).toBe(19);
    h.assertNoNative();
  });

  it("does not create a grant when the requesting HTTP context is cancelled during budget reservation", async () => {
    const controller = new AbortController();
    const h = harness({ beforeReserve: async () => { controller.abort(); } });
    await expect(h.authority.run(h.principal, () => h.service.requestMailAuthorization({
      actions: ["send"], recipients: ["recipient@example.test"], maxOperations: 2, expiresInSeconds: 60,
      purpose: "Synthetic cancelled cloud request",
    }), controller.signal)).rejects.toMatchObject({ code: "OAUTH_SCOPE_REQUIRED" });
    expect(h.remaining()).toBe(98);
    expect((await h.service.listMailAuthorizations()).authorizations).toEqual([]);
    expect(h.smtpDispatched).not.toHaveBeenCalled();
    h.assertNoNative();
  });
});
