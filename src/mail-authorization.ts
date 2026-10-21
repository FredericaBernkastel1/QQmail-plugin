import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import type { ApprovalResult } from "./approval.js";
import { ToolFailure } from "./errors.js";

export const MAX_MAIL_AUTHORIZATIONS = 32;
export const MAX_AUTHORIZATION_OPERATIONS = 100;
export const MAX_AUTHORIZATION_SECONDS = 86_400;
export const MAX_AUTHORIZATION_RECIPIENTS = 20;
export const MAX_AUTHORIZATION_MESSAGE_REFS = 100;
export const MAX_AUTHORIZATION_PURPOSE_LENGTH = 300;

export type MailAuthorizationAction = "edit_draft" | "send" | "trash" | "flags";
export interface MailAuthorizationContext {
  readonly scope: string;
  readonly fingerprint: string;
  readonly email: string;
}
export interface MailAuthorizationRequestInput {
  readonly actions: readonly MailAuthorizationAction[];
  readonly recipients?: readonly string[] | undefined;
  /** Exact, account-validated opaque references, resolved by the service before requesting approval. */
  readonly messageRefs?: readonly string[] | undefined;
  readonly maxOperations: number;
  readonly expiresInSeconds: number;
  /** Display only: this description never grants or restricts authority. */
  readonly purpose: string;
}
export interface MailAuthorizationApprovalRequest {
  readonly accountEmail: string;
  readonly actions: readonly MailAuthorizationAction[];
  readonly recipients: readonly string[];
  readonly messageRefs: readonly string[];
  readonly maxOperations: number;
  readonly expiresInSeconds: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly purpose: string;
}
/** Trusted application capability, never supplied through tool input or environment variables. */
export type MailAuthorizationApprover = (request: MailAuthorizationApprovalRequest) => Promise<ApprovalResult>;
export interface MailAuthorizationGrant extends Omit<MailAuthorizationApprovalRequest, "expiresInSeconds"> {
  readonly authorizationId: string;
  readonly remainingOperations: number;
}
export interface MailAuthorizationRecipients {
  readonly to?: readonly string[] | undefined;
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
}
export interface MailAuthorizationOperation {
  readonly action: MailAuthorizationAction;
  readonly recipients?: MailAuthorizationRecipients | undefined;
  readonly messageRefs?: readonly string[] | undefined;
  /** Optional consistency assertion; callers cannot choose a lower operation cost. */
  readonly units?: number | undefined;
}
declare const receiptBrand: unique symbol;
/** Internal capability. JSON, object copying and receipts from another store cannot recreate it. */
export interface MailAuthorizationReceipt { readonly [receiptBrand]: true }

const actionSchema = z.enum(["edit_draft", "send", "trash", "flags"]);
const addressSchema = z.string().min(1).max(320).email().refine(value => !/[?*]/u.test(value));
const referenceSchema = z.string().min(8).max(4_096).regex(/^[A-Za-z0-9_-]+$/u);
const requestSchema = z.strictObject({
  actions: z.array(actionSchema).min(1).max(4).refine(actions => new Set(actions).size === actions.length),
  recipients: z.array(addressSchema).max(MAX_AUTHORIZATION_RECIPIENTS).optional(),
  messageRefs: z.array(referenceSchema).max(MAX_AUTHORIZATION_MESSAGE_REFS).optional(),
  maxOperations: z.number().int().min(1).max(MAX_AUTHORIZATION_OPERATIONS),
  expiresInSeconds: z.number().int().min(1).max(MAX_AUTHORIZATION_SECONDS),
  purpose: z.string().trim().min(1).max(MAX_AUTHORIZATION_PURPOSE_LENGTH).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
});
const operationSchema = z.strictObject({
  action: actionSchema,
  recipients: z.strictObject({
    to: z.array(addressSchema).max(100).optional(),
    cc: z.array(addressSchema).max(100).optional(),
    bcc: z.array(addressSchema).max(100).optional(),
  }).optional(),
  messageRefs: z.array(referenceSchema).max(MAX_AUTHORIZATION_MESSAGE_REFS).optional(),
  units: z.number().int().min(1).max(MAX_AUTHORIZATION_OPERATIONS).optional(),
});
interface Entry {
  readonly authorizationId: string;
  readonly context: MailAuthorizationContext;
  readonly request: MailAuthorizationApprovalRequest;
  remainingOperations: number;
}
function failure(code: string, message: string): ToolFailure { return new ToolFailure(code, message); }
function invalidRequest(): ToolFailure {
  return failure("INVALID_MAIL_AUTHORIZATION", "Provide bounded actions, exact targets, an operation limit and an expiry.");
}
function invalidContext(): ToolFailure {
  return failure("MAIL_AUTHORIZATION_ACCOUNT_CHANGED", "The authorization does not match the current account. Request a new authorization.");
}
export function normalizeMailAuthorizationAddress(value: string): string {
  const separator = value.lastIndexOf("@");
  // Preserve the local part: accepting a different spelling must not broaden an exact allowlist.
  return value.slice(0, separator + 1) + value.slice(separator + 1).toLowerCase();
}
const normalizeAddress = normalizeMailAuthorizationAddress;
function contextSnapshot(context: MailAuthorizationContext): MailAuthorizationContext {
  if (!context || typeof context.scope !== "string" || typeof context.fingerprint !== "string" ||
      context.scope.length < 1 || context.scope.length > 256 ||
      context.fingerprint.length < 1 || context.fingerprint.length > 256 ||
      /[\s\u0000-\u001f\u007f]/u.test(context.scope + context.fingerprint) ||
      !addressSchema.safeParse(context.email).success) throw invalidContext();
  return Object.freeze({ scope: context.scope, fingerprint: context.fingerprint, email: normalizeAddress(context.email) });
}
function sameAccount(left: MailAuthorizationContext, right: MailAuthorizationContext): boolean {
  return left.scope === right.scope && left.fingerprint === right.fingerprint && left.email === right.email;
}

/**
 * Bounded, process-local authority. Restart deliberately discards all grants; no disk persistence,
 * automatic approval, content-based rules or refund/retry mechanism is provided here.
 */
export class MailAuthorizationStore {
  readonly #entries = new Map<string, Entry>();
  #receipts = new WeakMap<object, Entry>();
  readonly #now: () => number;
  #pending = 0;
  #disposed = false;

  constructor(options: { now?: () => number } = {}) { this.#now = options.now ?? Date.now; }

  async request(input: MailAuthorizationRequestInput, context: MailAuthorizationContext,
    approver: MailAuthorizationApprover,
    recheckContext: () => MailAuthorizationContext | Promise<MailAuthorizationContext>): Promise<MailAuthorizationGrant> {
    this.#assertAvailable();
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw invalidRequest();
    const normalized = parsed.data;
    const initialContext = contextSnapshot(context);
    const recipients = Object.freeze([...new Set((normalized.recipients ?? []).map(normalizeAddress))]);
    const messageRefs = Object.freeze([...new Set(normalized.messageRefs ?? [])]);
    if ((normalized.actions.includes("send") && recipients.length === 0) ||
        ((normalized.actions.includes("trash") || normalized.actions.includes("flags")) && messageRefs.length === 0)) {
      throw invalidRequest();
    }
    if (typeof approver !== "function" || typeof recheckContext !== "function") {
      throw failure("MAIL_AUTHORIZATION_UNAVAILABLE", "Trusted authorization confirmation is unavailable.");
    }
    const createdAt = this.#time();
    const expiresAt = createdAt + normalized.expiresInSeconds * 1_000;
    if (!Number.isSafeInteger(expiresAt)) throw invalidRequest();
    this.#purgeExpired(createdAt);
    if (this.#entries.size + this.#pending >= MAX_MAIL_AUTHORIZATIONS) {
      throw failure("MAIL_AUTHORIZATION_CAPACITY", "The authorization limit is reached. Revoke an authorization or wait for expiry.");
    }
    const request: MailAuthorizationApprovalRequest = Object.freeze({
      accountEmail: initialContext.email,
      actions: Object.freeze([...normalized.actions]), recipients, messageRefs,
      maxOperations: normalized.maxOperations, expiresInSeconds: normalized.expiresInSeconds,
      createdAt, expiresAt, purpose: normalized.purpose,
    });
    // Reserve synchronously before the first await, including time spent in native confirmation.
    this.#pending += 1;
    try {
      let result: ApprovalResult;
      try { result = await approver(request); }
      catch (error) {
        if (error instanceof ToolFailure && error.code === "OAUTH_SCOPE_REQUIRED") {
          throw failure("OAUTH_SCOPE_REQUIRED", "A current access token with the required mail permissions is necessary.");
        }
        throw failure("MAIL_AUTHORIZATION_UNAVAILABLE", "Trusted authorization confirmation is unavailable.");
      }
      this.#assertAvailable();
      if (result?.status !== "approved") {
        if (result?.status === "declined") throw failure("MAIL_AUTHORIZATION_DECLINED", "Authorization was cancelled.");
        if (result?.status === "timeout") throw failure("MAIL_AUTHORIZATION_TIMEOUT", "Authorization confirmation timed out.");
        throw failure("MAIL_AUTHORIZATION_UNAVAILABLE", "Trusted authorization confirmation is unavailable.");
      }
      let currentContext: MailAuthorizationContext;
      try { currentContext = contextSnapshot(await recheckContext()); }
      catch { throw invalidContext(); }
      this.#assertAvailable();
      if (!sameAccount(initialContext, currentContext)) throw invalidContext();
      if (this.#time() >= expiresAt) throw failure("MAIL_AUTHORIZATION_EXPIRED", "The authorization expired during confirmation.");
      let authorizationId: string;
      do { authorizationId = "auth_" + randomBytes(32).toString("base64url"); } while (this.#entries.has(authorizationId));
      const entry: Entry = { authorizationId, context: initialContext, request, remainingOperations: request.maxOperations };
      this.#entries.set(authorizationId, entry);
      return this.#metadata(entry);
    } finally { this.#pending -= 1; }
  }

  /** Atomic precharge: once returned, failures downstream never restore this operation budget. */
  consume(authorizationId: string, context: MailAuthorizationContext,
    operation: MailAuthorizationOperation): MailAuthorizationReceipt {
    const entry = this.#lookup(authorizationId, context);
    const parsed = operationSchema.safeParse(operation);
    if (!parsed.success) throw invalidRequest();
    const requested = parsed.data;
    if (!entry.request.actions.includes(requested.action)) {
      throw failure("MAIL_AUTHORIZATION_ACTION_DENIED", "This action is outside the authorization.");
    }
    let units = 1;
    if (requested.action === "send") {
      const recipients = [
        ...(requested.recipients?.to ?? []), ...(requested.recipients?.cc ?? []), ...(requested.recipients?.bcc ?? []),
      ];
      if (recipients.length < 1 || recipients.length > 100 ||
          recipients.some(recipient => !entry.request.recipients.includes(normalizeAddress(recipient)))) {
        throw failure("MAIL_AUTHORIZATION_RECIPIENT_DENIED", "Every To, Cc and Bcc recipient must be explicitly authorized.");
      }
      if (requested.messageRefs?.length) throw invalidRequest();
    } else if (requested.action === "trash" || requested.action === "flags") {
      const messageRefs = [...new Set(requested.messageRefs ?? [])];
      if (messageRefs.length === 0 || messageRefs.some(reference => !entry.request.messageRefs.includes(reference))) {
        throw failure("MAIL_AUTHORIZATION_MESSAGE_DENIED", "Every message reference must be explicitly authorized.");
      }
      if (requested.recipients !== undefined) throw invalidRequest();
      units = messageRefs.length;
    } else if (requested.recipients !== undefined || requested.messageRefs?.length) {
      // edit_draft covers local draft preparation/edit/cancel for this account. It does not send.
      throw invalidRequest();
    }
    if (requested.units !== undefined && requested.units !== units) throw invalidRequest();
    if (entry.remainingOperations < units) {
      throw failure("MAIL_AUTHORIZATION_EXHAUSTED", "The remaining authorization budget is insufficient. Request a new authorization.");
    }
    entry.remainingOperations -= units;
    const receipt = Object.freeze(Object.create(null)) as MailAuthorizationReceipt;
    this.#receipts.set(receipt, entry);
    return receipt;
  }

  /** Recheck after awaits and immediately before an external mutation, including SMTP delivery. */
  assertStillValid(receipt: MailAuthorizationReceipt, context: MailAuthorizationContext): void {
    this.#assertAvailable();
    const entry = receipt && typeof receipt === "object" ? this.#receipts.get(receipt) : undefined;
    if (!entry || this.#entries.get(entry.authorizationId) !== entry) {
      throw failure("MAIL_AUTHORIZATION_INVALID", "The authorization was revoked or its receipt is invalid.");
    }
    this.#assertEntry(entry, context);
    // An operation that consumed the last unit remains valid; only subsequent consume calls fail.
  }

  list(context: MailAuthorizationContext): readonly MailAuthorizationGrant[] {
    this.#assertAvailable();
    const currentContext = contextSnapshot(context);
    this.#purgeExpired(this.#time());
    return Object.freeze([...this.#entries.values()]
      .filter(entry => sameAccount(entry.context, currentContext)).map(entry => this.#metadata(entry)));
  }

  /** Stops subsequent operations and active receipts; already delivered mail cannot be recalled. */
  revoke(authorizationId: string, context: MailAuthorizationContext): void {
    const entry = this.#lookup(authorizationId, context);
    this.#entries.delete(entry.authorizationId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#entries.clear();
    this.#receipts = new WeakMap();
  }

  #assertAvailable(): void {
    if (this.#disposed) throw failure("MAIL_AUTHORIZATION_UNAVAILABLE", "The authorization store is unavailable.");
  }
  #time(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw failure("MAIL_AUTHORIZATION_UNAVAILABLE", "The authorization clock is unavailable.");
    return now;
  }
  #lookup(authorizationId: string, context: MailAuthorizationContext): Entry {
    this.#assertAvailable();
    const entry = typeof authorizationId === "string" && /^auth_[A-Za-z0-9_-]{43}$/u.test(authorizationId)
      ? this.#entries.get(authorizationId) : undefined;
    if (!entry) throw failure("MAIL_AUTHORIZATION_INVALID", "The authorization is unknown or revoked. Request a new authorization.");
    this.#assertEntry(entry, context);
    return entry;
  }
  #assertEntry(entry: Entry, context: MailAuthorizationContext): void {
    if (!sameAccount(entry.context, contextSnapshot(context))) throw invalidContext();
    if (this.#time() >= entry.request.expiresAt) {
      this.#entries.delete(entry.authorizationId);
      throw failure("MAIL_AUTHORIZATION_EXPIRED", "The authorization has expired. Request a new authorization.");
    }
  }
  #purgeExpired(now: number): void {
    for (const [id, entry] of this.#entries) if (now >= entry.request.expiresAt) this.#entries.delete(id);
  }
  #metadata(entry: Entry): MailAuthorizationGrant {
    const { expiresInSeconds: _expiresInSeconds, ...metadata } = entry.request;
    return Object.freeze({ ...metadata, authorizationId: entry.authorizationId, remainingOperations: entry.remainingOperations });
  }
}
