import { describe, expect, it, vi } from "vitest";
import { createLocalMailAuthorizationRequest } from "../src/local-authorization.js";
import { coreMessageReferenceCodec } from "../src/mail/adapters.js";
import type { MailAccountContext } from "../src/mail/types.js";
import type { MailAuthorizationApprovalRequest } from "../src/mail-authorization.js";

const now = Date.parse("2026-10-21T00:00:00.000Z");
function fixture() {
  const unlock = vi.fn(async () => "SYNTHETIC_CREDENTIAL_MUST_NOT_APPEAR");
  const context: MailAccountContext = {
    scope: "a".repeat(64), getAuthorizationCode: unlock,
    account: {
      email: "synthetic@qq.com", username: "synthetic@qq.com", displayName: "Synthetic",
      imap: { host: "imap.qq.com", port: 993, security: "tls" },
      smtp: { host: "smtp.qq.com", port: 465, security: "tls" },
      folders: { inbox: "INBOX", sent: "Sent", trash: "Trash" },
      downloadDirectory: "C:\\Synthetic", downloadLimitBytes: 1024,
    },
  };
  const locator = { accountScope: context.scope, mailbox: "INBOX", uidValidity: "42", uid: 7 };
  const request: MailAuthorizationApprovalRequest = {
    accountEmail: context.account.email, actions: ["edit_draft", "send", "trash", "flags"],
    recipients: ["recipient@example.test"], messageRefs: [coreMessageReferenceCodec.encode(locator)],
    maxOperations: 4, expiresInSeconds: 600, createdAt: now, expiresAt: now + 600_000,
    purpose: "Synthetic explicitly requested bounded mail task",
  };
  return { context, request, locator, unlock };
}

describe("trusted local mail authorization presentation", () => {
  it("shows exact action, recipient, operation, expiry and decoded message bounds", () => {
    const { request, context, locator } = fixture();
    const presentation = createLocalMailAuthorizationRequest(request, context, coreMessageReferenceCodec, now)!;
    expect(presentation.confirmLabel).toBe("Authorize this task");
    expect(presentation.preview).toMatchObject({
      actions: request.actions, recipients: request.recipients, messageRefs: request.messageRefs,
      maxOperations: 4, expiresAt: new Date(request.expiresAt).toISOString(), purpose: request.purpose,
      selectedMessages: [locator], deliveryAccount: { email: context.account.email, imap: context.account.imap, smtp: context.account.smtp },
    });
    expect(presentation.description).toContain("Purpose text is descriptive, not an enforced content rule.");
    expect(presentation.description).toContain("ALL listed To/Cc/Bcc recipients");
    expect(presentation.description).toContain("cannot undo work already dispatched");
  });

  it("caps the approval window at two minutes without shortening the displayed grant lifetime", () => {
    const { request, context } = fixture();
    const presentation = createLocalMailAuthorizationRequest(request, context, coreMessageReferenceCodec, now)!;
    expect(Date.parse(presentation.expiresAt)).toBe(now + 120_000);
    expect(presentation.preview.expiresAt).toBe(new Date(now + 600_000).toISOString());
    const short = createLocalMailAuthorizationRequest({ ...request, expiresAt: now + 30_000 }, context, coreMessageReferenceCodec, now)!;
    expect(Date.parse(short.expiresAt)).toBe(now + 30_000);
  });

  it("rejects absent or different accounts and stale references before creating a window", () => {
    const { request, context } = fixture();
    expect(createLocalMailAuthorizationRequest(request, undefined, coreMessageReferenceCodec, now)).toBeUndefined();
    expect(createLocalMailAuthorizationRequest(request, { ...context, account: { ...context.account, email: "other@qq.com" } }, coreMessageReferenceCodec, now)).toBeUndefined();
    expect(createLocalMailAuthorizationRequest(request, { ...context, scope: "b".repeat(64) }, coreMessageReferenceCodec, now)).toBeUndefined();
    expect(createLocalMailAuthorizationRequest({ ...request, messageRefs: ["invalid-reference"] }, context, coreMessageReferenceCodec, now)).toBeUndefined();
  });

  it("does not unlock credentials, expose local paths or accept approval fields into the preview", () => {
    const { request, context, unlock } = fixture();
    const extra = { ...request, approved: true, command: "SYNTHETIC_DO_NOT_EXECUTE" };
    const presentation = createLocalMailAuthorizationRequest(extra, context, coreMessageReferenceCodec, now)!;
    expect(unlock).not.toHaveBeenCalled();
    expect(presentation.preview).not.toHaveProperty("approved");
    expect(presentation.preview).not.toHaveProperty("command");
    expect(JSON.stringify(presentation)).not.toMatch(/SYNTHETIC_CREDENTIAL|downloadDirectory|C:\\\\Synthetic/u);
  });

  it("snapshots displayed endpoints and target arrays without retaining mutable account objects", () => {
    const { request, context } = fixture();
    const presentation = createLocalMailAuthorizationRequest(request, context, coreMessageReferenceCodec, now)!;
    context.account.smtp.host = "changed.example.test";
    expect(presentation.preview.deliveryAccount).toMatchObject({ smtp: { host: "smtp.qq.com" } });
    expect(presentation.preview.actions).not.toBe(request.actions);
    expect(presentation.preview.messageRefs).not.toBe(request.messageRefs);
  });
});
