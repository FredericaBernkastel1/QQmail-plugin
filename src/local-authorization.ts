import type { WindowsApprovalRequest } from "./approval.js";
import type { MailAuthorizationApprovalRequest } from "./mail-authorization.js";
import type { MailAccountContext, MessageLocator, MessageReferenceCodec } from "./mail/types.js";

/** Pure presentation builder. The authorization store separately rechecks the account after approval. */
export function createLocalMailAuthorizationRequest(
  request: MailAuthorizationApprovalRequest,
  context: MailAccountContext | undefined,
  references: MessageReferenceCodec,
  now = Date.now(),
): WindowsApprovalRequest | undefined {
  if (!context || context.account.email !== request.accountEmail || !Number.isSafeInteger(now)) return undefined;
  let selectedMessages: MessageLocator[];
  try {
    selectedMessages = request.messageRefs.map(reference => {
      const locator = references.decode(reference);
      if (locator.accountScope !== context.scope) throw new Error("The selected message belongs to another account revision.");
      return { accountScope: locator.accountScope, mailbox: locator.mailbox, uidValidity: locator.uidValidity, uid: locator.uid };
    });
  } catch { return undefined; }
  return {
    title: "QQ Mail - Authorize bounded mail automation",
    description: "Grant only a task you explicitly requested. Within these exact actions, targets, expiry and operation count, the agent can act without another popup. SEND permits agent-selected content to ALL listed To/Cc/Bcc recipients. Purpose text is descriptive, not an enforced content rule. Trash is not permanent deletion. This grant expires on process restart; it cannot undo work already dispatched. Do not let an agent click this approval for you.",
    confirmLabel: "Authorize this task",
    expiresAt: new Date(Math.min(request.expiresAt, now + 120_000)).toISOString(),
    preview: {
      accountEmail: request.accountEmail, actions: [...request.actions], recipients: [...request.recipients],
      messageRefs: [...request.messageRefs], maxOperations: request.maxOperations,
      expiresInSeconds: request.expiresInSeconds, createdAt: request.createdAt,
      expiresAt: new Date(request.expiresAt).toISOString(), purpose: request.purpose,
      deliveryAccount: { email: context.account.email, imap: { ...context.account.imap }, smtp: { ...context.account.smtp } },
      selectedMessages,
    },
  };
}
