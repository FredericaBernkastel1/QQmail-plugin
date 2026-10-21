import { AsyncLocalStorage } from "node:async_hooks";
import { ToolFailure } from "../errors.js";
import type { MailAuthorizationAction, MailAuthorizationApprovalRequest } from "../mail-authorization.js";
import type { CloudPrincipal } from "./auth.js";
import type { CloudConfig } from "./config.js";

const scopes: Record<MailAuthorizationAction, string> = { edit_draft: "mail.drafts.write", send: "mail.send", trash: "mail.trash", flags: "mail.flags.write" };
export class CloudAuthority {
  private readonly context = new AsyncLocalStorage<{ principal: CloudPrincipal; signal?: AbortSignal }>();
  constructor(private readonly policy: CloudConfig["delegation"], private readonly reserve: (units: number) => Promise<void>, private readonly now = Date.now) {}
  run<T>(principal: CloudPrincipal, callback: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.context.run({ principal, ...(signal ? { signal } : {}) }, callback);
  }
  assertScope(scope: string): CloudPrincipal {
    const context = this.context.getStore();
    const principal = context?.principal;
    if (!principal || context?.signal?.aborted || principal.expiresAt <= this.now() || !principal.scopes.includes(scope)) {
      throw new ToolFailure("OAUTH_SCOPE_REQUIRED", "A current access token with the required permission is necessary.");
    }
    return principal;
  }
  assertWrite = (action: MailAuthorizationAction): void => {
    this.assertScope("mail.authorize"); this.assertScope(scopes[action]);
    if (!this.policy || Date.parse(this.policy.expiresAt) <= this.now() || !this.policy.actions.includes(action)) {
      throw new ToolFailure("OWNER_DELEGATION_REQUIRED", "The owner's configured mail delegation does not allow this action.");
    }
  };
  approve = async (request: MailAuthorizationApprovalRequest) => {
    const principal = this.assertScope("mail.authorize");
    for (const action of request.actions) this.assertWrite(action);
    if (!this.policy || request.expiresAt > Math.min(principal.expiresAt, Date.parse(this.policy.expiresAt)) ||
        request.recipients.some(address => !this.policy!.recipients.includes(address))) {
      throw new ToolFailure("OWNER_DELEGATION_SCOPE", "The requested task exceeds the owner's recipient or time limits.");
    }
    // Reserve the full grant from a durable total budget; issuing another grant cannot reset it.
    await this.reserve(request.maxOperations);
    for (const action of request.actions) this.assertWrite(action);
    return { status: "approved" as const };
  };
  tools(): ReadonlySet<string> {
    this.assertScope("mail.read");
    const allowed = new Set(["get_account_status", "list_mailboxes", "search_emails", "read_email", "batch_read_emails", "read_email_thread"]);
    const p = this.context.getStore()!.principal;
    if (p.scopes.includes("mail.drafts.read")) for (const name of ["list_drafts", "get_draft"]) allowed.add(name);
    if (!this.policy || Date.parse(this.policy.expiresAt) <= this.now() || !p.scopes.includes("mail.authorize")) return allowed;
    for (const name of ["request_mail_authorization", "list_mail_authorizations", "revoke_mail_authorization"]) allowed.add(name);
    const mapping: Record<MailAuthorizationAction, string[]> = { edit_draft: ["prepare_email", "update_draft", "cancel_draft"], send: ["send_email"], trash: ["trash_emails"], flags: ["set_email_flags"] };
    for (const action of this.policy.actions) if (p.scopes.includes(scopes[action])) for (const name of mapping[action]) allowed.add(name);
    return allowed;
  }
}
