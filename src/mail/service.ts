import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { isLocalAbsoluteWindowsPath } from "../config.js";
import { denySendApproval, preflightSendApproval, type SendApproval } from "../approval.js";
import { DraftError, type DraftStore, type DraftSnapshotRecord, type DraftSendResult } from "../drafts.js";
import { denyAttachmentPicker, type AttachmentPicker } from "../attachment-picker.js";
import { OutgoingAttachmentStore, type OutgoingAttachmentRepository } from "../outgoing-attachments.js";
import { MAX_OUTGOING_ATTACHMENTS, MAX_OUTGOING_FILE_BYTES, MAX_OUTGOING_TOTAL_BYTES, MAX_OUTGOING_MIME_BYTES } from "../attachment-limits.js";
import { ToolFailure, DeliveryFailure } from "../errors.js";
import { MailAuthorizationStore, type MailAuthorizationRequestInput, type MailAuthorizationContext,
  type MailAuthorizationApprover, type MailAuthorizationReceipt } from "../mail-authorization.js";
import { denyMailMutation, type MailMutationApproval } from "./mutation-approval.js";
import { assertSecureServerConfig } from "./config-validation.js";
import {
  DEFAULT_BODY_CHARS, MAX_BODY_PAGE_CHARS, MAX_REQUEST_SOURCE_BYTES, MAX_IMAP_LITERAL_BYTES,
  ReadOutputBudget, ReadResourceBudget, sharedReadBudget, checkReadCancelled,
} from "./read-budget.js";
import {
  deduplicateAddresses,
  flattenAttachmentParts,
  htmlToSafeText,
  normalizeEmailAddress,
  normalizeEnvelopeAddresses,
  normalizeOutgoingAddresses,
  parseIncomingMessage,
  prefixSubject,
  validateHeaderText,
  type BodyAttachmentPart,
  type ParsedIncomingMessage,
} from "./mime.js";
import type {
  AttachmentStorage,
  ImapGateway,
  ImapBodyStructure,
  ImapMessageData,
  ImapSession,
  ImapSearchQuery,
  MailAccountConfig,
  MailAccountProvider,
  MessageLocator,
  MessageReferenceCodec,
  OutgoingAddress,
  OutgoingMessage,
  PrepareEmailInput,
  ReadBodyRange,
  ReadMessageResult,
  ReadBatchResult,
  ThreadResult,
  SearchEmailsInput,
  SmtpGateway,
} from "./types.js";

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_MESSAGE_PARSE_LIMIT = 25 * 1024 * 1024;
const MAX_THREAD_IDENTIFIERS = 25;
const MAX_THREAD_ROUNDS = 5;

export interface QqMailServiceOptions {
  accountProvider: MailAccountProvider;
  referenceCodec: MessageReferenceCodec;
  draftStore: DraftStore<OutgoingMessage, Record<string, unknown>>;
  initializeDrafts?: () => Promise<void>;
  attachmentStorage: AttachmentStorage;
  imapGateway?: ImapGateway | undefined;
  smtpGateway?: SmtpGateway | undefined;
  now?: (() => number) | undefined;
  cursorKey?: Buffer | undefined;
  sendApproval?: SendApproval | undefined;
  mutationApproval?: MailMutationApproval;
  attachmentPicker?: AttachmentPicker;
  outgoingAttachments?: OutgoingAttachmentRepository;
  readBudget?: ReadResourceBudget;
  /** Internal test/deployment limit; cannot exceed the production request ceiling. */
  readRequestLimitBytes?: number;
  requireAuthorization?: boolean;
  authorizationStore?: MailAuthorizationStore;
  authorizationApprover?: MailAuthorizationApprover;
  assertWriteAuthority?: (action: "edit_draft" | "send" | "trash" | "flags") => void;
}

interface ResolvedMessage {
  locator: MessageLocator;
  record: ImapMessageData;
  parsed: ParsedIncomingMessage;
  sourceBytes: number;
}

interface ReadRequestBudget { remainingBytes: number }

interface ConnectionSnapshot {
  state: "unknown" | "ok" | "error";
  scope?: string;
  checkedAt?: string | undefined;
}

interface DraftAccountBinding {
  account: MailAccountConfig;
  fingerprint: string;
  scope: string;
}

interface AccountOperation extends MailAccountConfig {
  accountScope: string;
  getAuthorizationCode(): Promise<string | undefined>;
}

export class QqMailService {
  readonly #accounts: MailAccountProvider;
  readonly #references: MessageReferenceCodec;
  readonly #drafts: DraftStore<OutgoingMessage, Record<string, unknown>>;
  readonly #initializeDrafts: (() => Promise<void>) | undefined;
  #draftInitialization: Promise<void> | undefined;
  readonly #attachments: AttachmentStorage;
  readonly #imap: ImapGateway;
  readonly #smtp: SmtpGateway;
  readonly #now: () => number;
  readonly #cursors: SearchCursorCodec;
  readonly #readBudget: ReadResourceBudget;
  readonly #readRequestLimitBytes: number;
  readonly #approval: SendApproval;
  readonly #mutationApproval: MailMutationApproval;
  readonly #authorizations: MailAuthorizationStore;
  readonly #authorizationApprover: MailAuthorizationApprover;
  readonly #requireAuthorization: boolean;
  readonly #assertWriteAuthority: NonNullable<QqMailServiceOptions["assertWriteAuthority"]>;
  readonly #picker: AttachmentPicker;
  readonly #outgoingAttachments: OutgoingAttachmentRepository;
  #selectingAttachments = false;
  #sendTail: Promise<void> = Promise.resolve();
  #queuedSends = 0;
  #imapStatus: ConnectionSnapshot = { state: "unknown" };
  #smtpStatus: ConnectionSnapshot = { state: "unknown" };

  constructor(options: QqMailServiceOptions) {
    this.#accounts = options.accountProvider;
    this.#references = options.referenceCodec;
    this.#drafts = options.draftStore;
    this.#initializeDrafts = options.initializeDrafts;
    this.#attachments = options.attachmentStorage;
    this.#imap = options.imapGateway ?? { connect: async () => { throw failure("IMAP_UNAVAILABLE", "No IMAP adapter was configured."); } };
    this.#smtp = options.smtpGateway ?? {
      verify: async () => { throw failure("SMTP_UNAVAILABLE", "No SMTP adapter was configured."); },
      send: async () => { throw new DeliveryFailure("not_sent"); },
    };
    this.#now = options.now ?? Date.now;
    this.#cursors = new SearchCursorCodec(options.cursorKey ?? randomBytes(32));
    this.#readBudget = options.readBudget ?? sharedReadBudget;
    this.#readRequestLimitBytes = options.readRequestLimitBytes ?? MAX_REQUEST_SOURCE_BYTES;
    if (!Number.isSafeInteger(this.#readRequestLimitBytes) || this.#readRequestLimitBytes < 1 ||
        this.#readRequestLimitBytes > MAX_REQUEST_SOURCE_BYTES) throw new Error("Invalid read request byte limit");
    this.#approval = options.sendApproval ?? denySendApproval;
    this.#mutationApproval = options.mutationApproval ?? denyMailMutation;
    this.#authorizations = options.authorizationStore ?? new MailAuthorizationStore({ now: this.#now });
    this.#authorizationApprover = options.authorizationApprover ?? (async () => ({ status: "unavailable" }));
    this.#requireAuthorization = options.requireAuthorization ?? false;
    this.#assertWriteAuthority = options.assertWriteAuthority ?? (() => undefined);
    this.#picker = options.attachmentPicker ?? denyAttachmentPicker;
    this.#outgoingAttachments = options.outgoingAttachments ?? new OutgoingAttachmentStore({ now: this.#now });
  }

  dispose(): void { this.#authorizations.dispose(); this.#outgoingAttachments.dispose(); this.#drafts.dispose(); }

  #authorizationContext(account: AccountOperation): MailAuthorizationContext {
    return { scope: account.accountScope, fingerprint: accountFingerprint(account), email: account.email };
  }

  async requestMailAuthorization(input: MailAuthorizationRequestInput) {
    const account = await this.#requireAccount();
    if (input.messageRefs?.length) this.#decodeReferenceList([...input.messageRefs], 100, account);
    return this.#authorizations.request(input, this.#authorizationContext(account), this.#authorizationApprover,
      async () => this.#authorizationContext(await this.#requireAccount()));
  }

  async listMailAuthorizations() {
    return { authorizations: this.#authorizations.list(this.#authorizationContext(await this.#requireAccount())), survivesRestart: false };
  }

  async revokeMailAuthorization(input: { authorizationId: string }) {
    this.#authorizations.revoke(input.authorizationId, this.#authorizationContext(await this.#requireAccount()));
    return { revoked: true, alreadyDispatchedOperationsRecalled: false };
  }

  #consumeAuthorization(id: string | undefined, account: AccountOperation,
    operation: Parameters<MailAuthorizationStore["consume"]>[2]): MailAuthorizationReceipt | undefined {
    this.#assertWriteAuthority(operation.action);
    if (id === undefined && !this.#requireAuthorization) return undefined;
    if (!id) throw failure("AUTHORIZATION_REQUIRED", "Explicit, unexpired mail task authorization is required.");
    return this.#authorizations.consume(id, this.#authorizationContext(account), operation);
  }

  async #checkAuthorization(receipt: MailAuthorizationReceipt | undefined, action: "edit_draft" | "send" | "trash" | "flags", expectedAccount: AccountOperation): Promise<void> {
    const active = await this.#requireAccount();
    if (receipt) this.#authorizations.assertStillValid(receipt, this.#authorizationContext(active));
    if (active.accountScope !== expectedAccount.accountScope) {
      throw failure("ACCOUNT_CHANGED", "The account changed before the mailbox write was dispatched. Refresh message references before continuing.");
    }
    this.#assertWriteAuthority(action);
  }

  async #ensureDrafts(): Promise<void> {
    if (!this.#initializeDrafts) return;
    this.#draftInitialization ??= Promise.resolve().then(this.#initializeDrafts).catch(error => {
      this.#draftInitialization = undefined;
      throw error;
    });
    await this.#draftInitialization;
  }

  async listAttachments() {
    const account = await this.#requireAccount();
    return { attachments: this.#outgoingAttachments.list(account.accountScope) };
  }

  async removeAttachments(input: { attachmentIds: string[] }) {
    const account = await this.#requireAccount();
    this.#outgoingAttachments.metadata(input.attachmentIds, account.accountScope);
    await this.#ensureDrafts();
    const removed = new Set(input.attachmentIds);
    const invalidated = this.#drafts.invalidateWhere((payload) =>
      Boolean(payload.attachmentIds?.some(id => removed.has(id))), "Attachments were removed. Select files and prepare a new draft.");
    this.#outgoingAttachments.remove(input.attachmentIds);
    await this.#drafts.flush();
    return { removed: removed.size, invalidatedDrafts: invalidated };
  }

  async listDrafts() {
    const account = await this.#requireAccount();
    await this.#ensureDrafts();
    return { drafts: this.#drafts.list(binding => (binding as DraftAccountBinding | undefined)?.scope === account.accountScope) };
  }

  async #draftForAccount(draftId: string): Promise<string> {
    const id = validateDraftId(draftId);
    const account = await this.#requireAccount();
    await this.#ensureDrafts();
    const binding = this.#drafts.getBinding(id) as DraftAccountBinding | undefined;
    if (!binding || binding.scope !== account.accountScope) throw failure("DRAFT_ACCOUNT_CHANGED", "This draft does not belong to the active account revision.");
    return id;
  }

  async getDraft(input: { draftId: string }) {
    const id = await this.#draftForAccount(input.draftId);
    const status = this.#drafts.status(id);
    return { ...status, ...(status.status === "prepared" ? { preview: this.#drafts.get(id).preview } : {}) };
  }

  async cancelDraft(input: { draftId: string; authorizationId?: string | undefined }) {
    const id = await this.#draftForAccount(input.draftId);
    const account = await this.#requireAccount();
    const binding = this.#drafts.getBinding(id) as DraftAccountBinding | undefined;
    if (binding?.scope !== account.accountScope) throw failure("DRAFT_ACCOUNT_CHANGED", "The active account changed.");
    this.#consumeAuthorization(input.authorizationId, account, { action: "edit_draft" });
    this.#drafts.cancel(id);
    await this.#drafts.flush();
    return this.#drafts.status(id);
  }

  async updateDraft(input: PrepareEmailInput & { draftId: string }) {
    const id = await this.#draftForAccount(input.draftId);
    return this.prepareEmail({ ...input, mode: "compose" }, id);
  }

  async selectAttachments(): Promise<unknown> {
    if ((await this.#requireAccount()).attachmentsDisabled) throw failure("CAPABILITY_DISABLED", "Local attachments are unavailable for this account.");
    if (this.#selectingAttachments) throw failure("ATTACHMENTS_BUSY", "Another file selection is already open.");
    this.#selectingAttachments = true;
    let importedIds: string[] = [];
    try {
      const account = await this.#requireAccount();
      const selection = this.#picker.selectDetailed ? await this.#picker.selectDetailed(account.email) : undefined;
      if (selection && !["selected", "cancelled"].includes(selection.status)) {
        throw failure(`ATTACHMENT_PICKER_${selection.status.toUpperCase()}`, "File selection did not complete. No files were imported.");
      }
      const paths = selection?.paths ?? await this.#picker.select(account.email);
      if (!paths.length) return { status: "cancelled", attachments: [] };
      if ((await this.#requireAccount()).accountScope !== account.accountScope) {
        throw failure("ATTACHMENT_ACCOUNT_CHANGED", "The account changed while selecting files. Select them again.");
      }
      const attachments = await this.#outgoingAttachments.importSelected(paths, account.accountScope);
      importedIds = attachments.map(entry => entry.attachmentId);
      if ((await this.#requireAccount()).accountScope !== account.accountScope) {
        throw failure("ATTACHMENT_ACCOUNT_CHANGED", "The account changed while importing files. Select them again.");
      }
      return {
        status: "selected", attachments,
        limits: { files: MAX_OUTGOING_ATTACHMENTS, perFileBytes: MAX_OUTGOING_FILE_BYTES,
          totalBytes: MAX_OUTGOING_TOTAL_BYTES, encodedMessageBytes: MAX_OUTGOING_MIME_BYTES },
      };
    } catch (error) {
      this.#outgoingAttachments.remove(importedIds);
      if (error instanceof ToolFailure) throw error;
      throw failure("ATTACHMENT_IMPORT_FAILED", "Attachment selection or import failed.");
    } finally { this.#selectingAttachments = false; }
  }

  async getAccountStatus(): Promise<unknown> {
    const context = await this.#accounts.getContext();
    if (!context) {
      return {
        configured: false,
        credentialStored: false,
        imap: { state: "unknown" },
        smtp: { state: "unknown" },
      };
    }
    const account = validateAccountConfig(context.account);
    const authorizationCode = await context.getAuthorizationCode();
    return {
      configured: true,
      credentialStored: isUsableAuthorizationCode(authorizationCode),
      account: {
        email: maskEmail(account.email),
        displayName: account.displayName,
        providerServers: { imap: account.imap.host, smtp: account.smtp.host },
      },
      imap: this.#imapStatus.scope === context.scope ? this.#imapStatus : { state: "unknown" },
      smtp: this.#smtpStatus.scope === context.scope ? this.#smtpStatus : { state: "unknown" },
    };
  }

  async testConnection(): Promise<unknown> {
    const account = await this.#requireAccount();
    const authorizationCode = await this.#requireAuthorizationCode(account);
    const checkedAt = new Date(this.#now()).toISOString();
    const [imapResult, smtpResult] = await Promise.allSettled([
      this.#testImap(account, authorizationCode),
      this.#smtp.verify(account.smtp, account.username, authorizationCode),
    ]);
    const imapStatus: ConnectionSnapshot = { state: imapResult.status === "fulfilled" ? "ok" : "error", checkedAt, scope: account.accountScope };
    const smtpStatus: ConnectionSnapshot = { state: smtpResult.status === "fulfilled" ? "ok" : "error", checkedAt, scope: account.accountScope };
    const stillCurrent = (await this.#accounts.getContext())?.scope === account.accountScope;
    if (stillCurrent) { this.#imapStatus = imapStatus; this.#smtpStatus = smtpStatus; }
    const mappedFolders = imapResult.status === "fulfilled"
      ? {
          inbox: imapResult.value.some((entry) => mailboxEquals(entry.path, account.folders.inbox)),
          sent: imapResult.value.some((entry) => mailboxEquals(entry.path, account.folders.sent)),
          trash: imapResult.value.some((entry) => mailboxEquals(entry.path, account.folders.trash)),
        }
      : { inbox: false, sent: false, trash: false };
    const folderMappingOk = mappedFolders.inbox && mappedFolders.sent && mappedFolders.trash;
    return {
      ok: imapResult.status === "fulfilled" && smtpResult.status === "fulfilled" && folderMappingOk,
      imap: {
        state: imapStatus.state,
        checkedAt,
        mailboxes: imapResult.status === "fulfilled" ? imapResult.value.length : undefined,
        specialUse: imapResult.status === "fulfilled"
          ? imapResult.value.filter((entry) => entry.specialUse).map((entry) => ({ path: entry.path, role: entry.specialUse }))
          : [],
      },
      smtp: { state: smtpStatus.state, checkedAt },
      stale: !stillCurrent,
      directories: {
        state: folderMappingOk ? "ok" : "error",
        inbox: { path: account.folders.inbox, found: mappedFolders.inbox },
        sent: { path: account.folders.sent, found: mappedFolders.sent },
        trash: { path: account.folders.trash, found: mappedFolders.trash },
      },
    };
  }

  async listMailboxes(): Promise<unknown> {
    const account = await this.#requireAccount();
    return this.#withImap(account, "LIST_MAILBOXES_FAILED", async (session) => {
      const mailboxes = await session.listMailboxes(account.folders);
      return {
        mailboxes: mailboxes.map((mailbox) => ({
          path: mailbox.path,
          delimiter: mailbox.delimiter,
          specialUse: mailbox.specialUse ?? null,
          flags: mailbox.flags,
          subscribed: mailbox.subscribed,
          messages: mailbox.messages ?? null,
          unseen: mailbox.unseen ?? null,
          uidValidity: mailbox.uidValidity ?? null,
        })),
      };
    });
  }

  async searchEmails(input: SearchEmailsInput): Promise<unknown> {
    const account = await this.#requireAccount();
    const mailbox = validateMailboxPath(input.mailbox ?? account.folders.inbox);
    const limit = clampInteger(input.limit ?? 25, 1, 100);
    const query = buildSearchQuery(input);
    const fingerprint = searchFingerprint(mailbox, input, account.accountScope);
    return this.#withImap(account, "SEARCH_FAILED", async (session) => {
      const selected = await session.selectMailbox(mailbox);
      let beforeUid = Number.POSITIVE_INFINITY;
      if (input.cursor) {
        const cursor = this.#cursors.decode(input.cursor);
        if (cursor.mailbox !== mailbox || cursor.fingerprint !== fingerprint) {
          throw failure("INVALID_CURSOR", "The search cursor does not match this query.");
        }
        if (cursor.uidValidity !== selected.uidValidity) {
          throw failure("STALE_CURSOR", "The mailbox changed and this search cursor is no longer valid.");
        }
        beforeUid = cursor.beforeUid;
      }

      const boundedQuery = Number.isFinite(beforeUid) ? { ...query, uid: `1:${beforeUid - 1}` } : query;
      const matchingUids = (beforeUid <= 1 ? [] : await session.search(boundedQuery))
        .filter((uid) => Number.isSafeInteger(uid) && uid > 0 && uid < beforeUid)
        .sort((left, right) => right - left);
      const pageUids = matchingUids.slice(0, limit);
      const records = await session.fetchMessages(pageUids, {});
      const recordsByUid = new Map(records.map((record) => [record.uid, record]));
      const candidateMessages = pageUids
        .map((uid) => recordsByUid.get(uid))
        .filter((record): record is ImapMessageData => Boolean(record))
        .map((record) => this.#formatSearchResult(mailbox, selected.uidValidity, record, account.accountScope));
      const output = new ReadOutputBudget();
      const messages: typeof candidateMessages = [];
      for (const message of candidateMessages) {
        if (!output.add(message)) break;
        messages.push(message);
      }
      const outputTruncated = messages.length < candidateMessages.length;
      if (outputTruncated && messages.length === 0) {
        throw failure("READ_OUTPUT_LIMIT", "The search result metadata exceeds the output budget.");
      }
      const lastUid = outputTruncated
        ? this.#references.decode(messages.at(-1)!.messageRef).uid
        : pageUids.at(-1);
      const nextCursor =
        lastUid !== undefined && (outputTruncated || matchingUids.length > pageUids.length)
          ? this.#cursors.encode({
              mailbox,
              uidValidity: selected.uidValidity,
              beforeUid: lastUid,
              fingerprint,
            })
          : null;
      return { mailbox, messages, nextCursor, incomplete: outputTruncated,
        truncationReasons: outputTruncated ? ["OUTPUT_BYTE_LIMIT"] : [] };
    });
  }

  async readEmail(input: { messageRef: string } & ReadBodyRange): Promise<ReadMessageResult> {
    const range = validateReadRange(input);
    const account = await this.#requireAccount();
    const locator = this.#decodeReference(input.messageRef, account);
    return this.#withImap(account, "READ_EMAIL_FAILED", async (session) => {
      const resolved = await this.#resolveMessage(session, account, locator, range);
      const message = this.#formatReadMessage(resolved);
      if (!new ReadOutputBudget().add(message)) {
        throw failure("READ_OUTPUT_LIMIT", "The requested body page exceeds the output budget. Retry with a smaller bodyLimit.");
      }
      return message;
    });
  }

  async batchReadEmails(input: { messageRefs: string[] }): Promise<ReadBatchResult> {
    if (!Array.isArray(input.messageRefs) || input.messageRefs.length < 1 || input.messageRefs.length > 25) {
      throw failure("INVALID_INPUT", "Batch reads require between 1 and 25 message references.");
    }
    const account = await this.#requireAccount();
    const locators = input.messageRefs.map((reference) => this.#decodeReference(reference, account));
    return this.#withImap(account, "READ_EMAIL_FAILED", async (session) => {
      const messages: ReadMessageResult[] = [];
      const skippedMessages: Array<{ messageRef: string; reason: string }> = [];
      const reasons = new Set<string>();
      const output = new ReadOutputBudget();
      const requestBudget = { remainingBytes: this.#readRequestLimitBytes };
      let skippedMessageCount = 0;
      const skip = (locator: MessageLocator, reason: string): void => {
        skippedMessageCount += 1;
        reasons.add(reason);
        const item = { messageRef: this.#references.encode(locator), reason };
        if (output.add(item)) skippedMessages.push(item);
        else reasons.add("OUTPUT_BYTE_LIMIT");
      };
      for (const locator of locators) {
        try {
          const resolved = await this.#resolveMessage(session, account, locator,
            { bodyLimit: DEFAULT_BODY_CHARS }, requestBudget);
          const message = this.#formatReadMessage(resolved);
          if (!output.add(message)) {
            skip(locator, "OUTPUT_BYTE_LIMIT");
            continue;
          }
          messages.push(message);
          for (const reason of message.truncationReasons) reasons.add(reason);
        } catch (error) {
          if (!isSkippableReadError(error)) throw error;
          skip(locator, error.code);
        }
      }
      return {
        messages, incomplete: reasons.size > 0, truncated: reasons.size > 0,
        truncationReasons: [...reasons], skippedMessages, skippedMessageCount,
        continuation: "Use read_email with each messageRef and body.nextOffset as bodyOffset; retry skipped messages individually.",
      };
    });
  }

  async readEmailThread(input: { messageRef: string; maxMessages: number }): Promise<ThreadResult> {
    const account = await this.#requireAccount();
    const locator = this.#decodeReference(input.messageRef, account);
    const maxMessages = clampInteger(input.maxMessages ?? 50, 1, 100);
    const mailboxes = uniqueMailboxPaths([locator.mailbox, account.folders.inbox, account.folders.sent]);
    return this.#withImap(account, "READ_THREAD_FAILED", async (session) => {
      await this.#selectAndValidate(session, locator);
      const requestBudget = { remainingBytes: this.#readRequestLimitBytes };
      const source = await this.#resolveSelectedMessage(session, account, locator,
        { bodyLimit: DEFAULT_BODY_CHARS }, requestBudget);
      const sourceKey = locatorKey(locator);
      const rootMessage = this.#formatReadMessage(source);
      const output = new ReadOutputBudget();
      if (!output.add(rootMessage)) throw failure("READ_OUTPUT_LIMIT", "The message metadata exceeds the output budget.");
      const resolved = new Map([[sourceKey, { message: rootMessage, timestamp: messageTimestamp(source), uid: locator.uid }]]);
      const examined = new Set<string>([sourceKey]);
      const skippedMailboxes = new Set<string>();
      const searchedMailboxes = new Set<string>();
      const skippedMessages: Array<{ messageRef: string; reason: string }> = [];
      const reasons = new Set<string>(rootMessage.truncationReasons);
      let skippedMessageCount = 0;
      const skip = (locator: MessageLocator, reason: string): void => {
        skippedMessageCount += 1;
        reasons.add(reason);
        const item = { messageRef: this.#references.encode(locator), reason };
        if (output.add(item)) skippedMessages.push(item);
        else reasons.add("OUTPUT_BYTE_LIMIT");
      };
      const allIdentifiers = collectThreadIdentifiers(source.parsed);
      const identifiers = new Set([...allIdentifiers].slice(0, MAX_THREAD_IDENTIFIERS));
      if (allIdentifiers.size > identifiers.size) reasons.add("THREAD_IDENTIFIER_LIMIT");
      let frontierExpanded = false;
      let rounds = 0;

      threadSearch: for (let round = 0; round < MAX_THREAD_ROUNDS && resolved.size < maxMessages && identifiers.size > 0; round += 1) {
        rounds = round + 1;
        const clauses = [...identifiers]
          .slice(0, MAX_THREAD_IDENTIFIERS)
          .flatMap((identifier): ImapSearchQuery[] => [
            { header: { "Message-ID": identifier } },
            { header: { References: identifier } },
            { header: { "In-Reply-To": identifier } },
          ]);
        let addedIdentifier = false;
        for (const mailbox of mailboxes) {
          if (resolved.size >= maxMessages) {
            break;
          }
          const isSourceMailbox = mailboxEquals(mailbox, locator.mailbox);
          let selected: Awaited<ReturnType<ImapSession["selectMailbox"]>>;
          try {
            selected = await session.selectMailbox(mailbox);
            if (isSourceMailbox && selected.uidValidity !== locator.uidValidity) {
              throw failure("STALE_MESSAGE_REFERENCE", "The mailbox UIDVALIDITY changed; search for the message again.");
            }
            const found = await session.search(clauses.length === 1 ? clauses[0]! : { or: clauses });
            searchedMailboxes.add(mailbox);
            const candidates = [...new Set(found)]
              .filter((uid) => Number.isSafeInteger(uid) && uid > 0)
              .map((uid) => ({ mailbox, uidValidity: selected.uidValidity, uid, accountScope: account.accountScope }))
              .filter((candidate) => !examined.has(locatorKey(candidate)));
            if (candidates.length === 0) {
              continue;
            }
            // Limit attempted candidates as well as successful results, including oversized mail.
            if (candidates.length > maxMessages - resolved.size) reasons.add("THREAD_MESSAGE_LIMIT");
            for (const candidateLocator of candidates.slice(0, maxMessages - resolved.size)) {
              if (examined.size >= 100) {
                reasons.add("THREAD_CANDIDATE_LIMIT");
                break threadSearch;
              }
              examined.add(locatorKey(candidateLocator));
              try {
                const candidate = await this.#resolveSelectedMessage(session, account, candidateLocator,
                  { bodyLimit: DEFAULT_BODY_CHARS }, requestBudget);
                const message = this.#formatReadMessage(candidate);
                if (!output.add(message)) {
                  skip(candidateLocator, "OUTPUT_BYTE_LIMIT");
                  continue;
                }
                resolved.set(locatorKey(candidateLocator), { message, timestamp: messageTimestamp(candidate), uid: candidateLocator.uid });
                for (const reason of message.truncationReasons) reasons.add(reason);
                for (const identifier of collectThreadIdentifiers(candidate.parsed)) {
                  if (identifiers.size < MAX_THREAD_IDENTIFIERS && !identifiers.has(identifier)) {
                    identifiers.add(identifier);
                    addedIdentifier = true;
                  } else if (!identifiers.has(identifier)) {
                    reasons.add("THREAD_IDENTIFIER_LIMIT");
                  }
                }
              } catch (error) {
                if (!isSkippableReadError(error)) throw error;
                skip(candidateLocator, error.code);
              }
            }
          } catch (error) {
            if (isSourceMailbox) {
              throw error;
            }
            skippedMailboxes.add(mailbox);
            reasons.add("MAILBOX_UNAVAILABLE");
          }
        }
        frontierExpanded = addedIdentifier;
        if (!addedIdentifier) {
          break;
        }
      }
      if (resolved.size >= maxMessages) reasons.add("THREAD_MESSAGE_LIMIT");
      if (rounds >= MAX_THREAD_ROUNDS && frontierExpanded) reasons.add("THREAD_ROUND_LIMIT");

      const messages = [...resolved.values()]
        .sort((left, right) => left.timestamp - right.timestamp || left.uid - right.uid)
        .map((entry) => entry.message);
      return {
        mailbox: locator.mailbox,
        rootMessageRef: input.messageRef,
        messages,
        truncated: reasons.size > 0,
        searchedMailboxes: [...searchedMailboxes],
        incomplete: reasons.size > 0,
        skippedMailboxes: [...skippedMailboxes],
        skippedMessages, skippedMessageCount, truncationReasons: [...reasons],
        continuation: "Use read_email with messageRef and body.nextOffset for body pages. Search the listed mailboxes by Message-ID/References when thread discovery is limited; retry skipped messages individually.",
      };
    });
  }

  async prepareEmail(input: PrepareEmailInput, existingId?: string) {
    const account = await this.#requireAccount();
    await this.#ensureDrafts();
    const oldBinding = existingId ? this.#drafts.getBinding(existingId) as DraftAccountBinding | undefined : undefined;
    if (existingId && (!oldBinding || oldBinding.scope !== account.accountScope || oldBinding.fingerprint !== accountFingerprint(account))) {
      throw failure("DRAFT_ACCOUNT_CHANGED", "The draft belongs to another account revision.");
    }
    const authorization = this.#consumeAuthorization(input.authorizationId, account, { action: "edit_draft" });
    const previous = existingId ? this.#drafts.getPayload(existingId) : undefined;
    const previousPreview = existingId ? this.#drafts.get(existingId).preview : undefined;
    const attachmentIds = input.attachmentIds ?? [];
    const attachments = this.#outgoingAttachments.metadata(attachmentIds, account.accountScope);
    const mode = input.mode ?? "compose";
    const userText = normalizeOutgoingBody(input.text ?? "");
    const html = input.html === undefined ? undefined : validateOutgoingHtml(input.html);
    if (!userText && !html && attachments.length === 0) {
      throw failure("INVALID_DRAFT", "A body or at least one selected attachment is required.");
    }
    const suppliedTo = normalizeOutgoingAddresses(input.to);
    const suppliedCc = normalizeOutgoingAddresses(input.cc);
    const suppliedBcc = normalizeOutgoingAddresses(input.bcc);
    let to = suppliedTo;
    let cc = suppliedCc;
    let subject = validateHeaderText(input.subject ?? "");
    let text = userText || htmlToSafeText(html ?? "");
    let inReplyTo: string | undefined;
    let references: string[] | undefined;

    if (mode !== "compose") {
      if (!input.sourceRef) {
        throw failure("INVALID_DRAFT", "A source message is required for replies and forwards.");
      }
      const locator = this.#decodeReference(input.sourceRef, account);
      const source = await this.#withImap(account, "PREPARE_EMAIL_FAILED", (session) =>
        this.#resolveMessage(session, account, locator),
      );
      if (mode === "reply" || mode === "reply_all") {
        const replyTarget = source.parsed.replyTo.length > 0 ? source.parsed.replyTo : source.parsed.from;
        if (suppliedTo.length === 0) {
          to = replyTarget;
        }
        if (mode === "reply_all" && suppliedCc.length === 0) {
          const ownAddress = account.email.toLowerCase();
          const primary = new Set(to.map((entry) => entry.address.toLowerCase()));
          cc = deduplicateAddresses([...source.parsed.to, ...source.parsed.cc]).filter(
            (entry) => entry.address.toLowerCase() !== ownAddress && !primary.has(entry.address.toLowerCase()),
          );
        }
        subject = subject || prefixSubject(source.parsed.subject, "Re:");
        inReplyTo = source.parsed.messageId;
        references = [...new Set([...source.parsed.references, ...(source.parsed.messageId ? [source.parsed.messageId] : [])])];
        text = appendQuotedReply(text, source.parsed);
      } else if (mode === "forward") {
        subject = subject || prefixSubject(source.parsed.subject, "Fwd:");
        text = appendForwardedMessage(text, source.parsed);
      } else {
        throw failure("INVALID_DRAFT", "The draft mode is invalid.");
      }
    }

    if (!subject) {
      subject = "(no subject)";
    }
    if (to.length + cc.length + suppliedBcc.length === 0) {
      throw failure("INVALID_DRAFT", "At least one recipient is required.");
    }
    const message: OutgoingMessage = {
      messageId: previous?.messageId ?? `<${randomBytes(24).toString("hex")}@qq-mail.local>`,
      from: { name: validateHeaderText(account.displayName, 200), address: account.email },
      to,
      cc,
      bcc: suppliedBcc,
      subject,
      text,
      ...(html ? { html } : {}),
      ...((previous?.inReplyTo ?? inReplyTo) ? { inReplyTo: (previous?.inReplyTo ?? inReplyTo)! } : {}),
      ...((previous?.references ?? references)?.length ? { references: (previous?.references ?? references)! } : {}),
      ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}),
    };
    const preview = {
      mode: previousPreview?.mode ?? mode,
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      text: message.text,
      html: message.html ?? null,
      attachments,
    };
    const boundAccount = snapshotAccount(account);
    const expiresBy = attachments.length ? Math.min(...attachments.map(entry => Date.parse(entry.expiresAt))) : undefined;
    const binding = {
      account: boundAccount,
      fingerprint: accountFingerprint(boundAccount),
      scope: account.accountScope,
    };
    const approvalPreview = { ...preview, deliveryAccount: { username: boundAccount.username, smtp: boundAccount.smtp, imap: boundAccount.imap } };
    if (!authorization && !preflightSendApproval({ draftId: "0".repeat(128), digest: "0".repeat(64), expiresAt: new Date(this.#now() + 30 * 60_000).toISOString(), preview: approvalPreview }).ok) {
      throw failure("DRAFT_APPROVAL_TOO_LARGE", "The complete preview exceeds the trusted confirmation window's UTF-8 limit. Reduce the body before preparing this draft.");
    }
    const saveAccount = await this.#requireAccount();
    if (saveAccount.accountScope !== account.accountScope) throw failure("DRAFT_ACCOUNT_CHANGED", "The account changed before saving the draft.");
    if (authorization) this.#authorizations.assertStillValid(authorization, this.#authorizationContext(saveAccount));
    this.#assertWriteAuthority("edit_draft");
    const draft = existingId
      ? this.#drafts.update(existingId, message, preview, [], expiresBy, binding)
      : this.#drafts.prepare(message, preview, [], expiresBy, binding);
    await this.#drafts.flush();
    return {
      draftId: draft.draftId,
      expiresAt: draft.expiresAt,
      preview: structuredClone(preview),
      confirmationRequired: !authorization,
      authorizationRequired: this.#requireAuthorization,
    };
  }

  async sendEmail(input: { draftId: string; authorizationId?: string | undefined }): Promise<DraftSendResult> {
    const draftId = validateDraftId(input.draftId);
    if (this.#queuedSends >= 4) throw failure("SEND_BUSY", "The send queue is full. Retry the same draft later.");
    this.#queuedSends++;
    const prior = this.#sendTail;
    let release!: () => void;
    this.#sendTail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    let binding: DraftAccountBinding | undefined;
    let authorizationCode: string | undefined;
    let sentRawMessage: Buffer | undefined;
    try {
      await this.#draftForAccount(draftId);
      binding = this.#drafts.getBinding(draftId) as DraftAccountBinding | undefined;
      const result = await this.#drafts.send(draftId, {
        send: async (message) => {
          if (!binding) {
            throw new DraftError(
              "DRAFT_ACCOUNT_CHANGED",
              "The account settings changed after this preview was prepared. Prepare a new draft before sending.",
            );
          }
          let currentAccount: AccountOperation;
          try {
            currentAccount = await this.#requireAccount();
          } catch {
            throw new DraftError(
              "DRAFT_ACCOUNT_CHANGED",
              "The account settings changed after this preview was prepared. Prepare a new draft before sending.",
            );
          }
          if (currentAccount.accountScope !== binding.scope || accountFingerprint(currentAccount) !== binding.fingerprint) {
            throw new DraftError(
              "DRAFT_ACCOUNT_CHANGED",
              "The account settings changed after this preview was prepared. Prepare a new draft before sending.",
            );
          }
          const draft = this.#drafts.get(draftId);
          let authorization: MailAuthorizationReceipt | undefined;
          try {
            authorization = this.#consumeAuthorization(input.authorizationId, currentAccount, { action: "send",
              recipients: { to: message.to.map(a => a.address), cc: message.cc.map(a => a.address), bcc: message.bcc.map(a => a.address) } });
          } catch (error) {
            throw new DraftError("DRAFT_APPROVAL_REQUIRED", error instanceof ToolFailure ? error.message : "Mail task authorization was denied.");
          }
          const beforeDispatch = async () => {
            const active = await this.#requireAccount();
            if (active.accountScope !== binding!.scope || accountFingerprint(active) !== binding!.fingerprint) {
              throw new DraftError("DRAFT_ACCOUNT_CHANGED", "The account changed before SMTP dispatch.");
            }
            if (this.#now() >= Date.parse(draft.expiresAt)) throw new DraftError("DRAFT_EXPIRED", "The draft expired before SMTP dispatch.");
            try {
              if (authorization) this.#authorizations.assertStillValid(authorization, this.#authorizationContext(active));
              this.#assertWriteAuthority("send");
            } catch (error) {
              throw new DraftError("DRAFT_APPROVAL_REQUIRED", error instanceof ToolFailure ? error.message : "Mail task authorization expired or was revoked.");
            }
          };
          try {
            this.#outgoingAttachments.metadata(message.attachmentIds ?? [], binding.scope);
          } catch {
            throw new DraftError("DRAFT_ATTACHMENTS_INVALID", "The draft attachments are no longer available. Select them and prepare a new draft.");
          }
          const digest = createHash("sha256")
            .update(JSON.stringify({ draftId, account: binding.fingerprint, scope: binding.scope, message }))
            .digest("hex");
          let approvalStatus = authorization ? "approved" : "unavailable";
          try {
            const request = Object.freeze({
              draftId,
              digest,
              expiresAt: draft.expiresAt,
              preview: {
                ...structuredClone(draft.preview),
                deliveryAccount: {
                  username: binding.account.username,
                  smtp: { ...binding.account.smtp },
                  imap: { ...binding.account.imap },
                },
              },
            });
            if (!authorization) approvalStatus = this.#approval.confirmDetailed
              ? (await this.#approval.confirmDetailed(request)).status
              : (await this.#approval.confirm(request)) ? "approved" : "required";
          } catch {
            // Missing, failed or timed-out trusted approval is always a denial.
          }
          if (approvalStatus !== "approved") {
            const codes = { declined: "DRAFT_APPROVAL_DECLINED", timeout: "DRAFT_APPROVAL_TIMEOUT", unavailable: "DRAFT_APPROVAL_UNAVAILABLE", too_large: "DRAFT_APPROVAL_TOO_LARGE" } as const;
            const code = codes[approvalStatus as keyof typeof codes] ?? "DRAFT_APPROVAL_REQUIRED";
            throw new DraftError(code, `Sending was not authorized: ${approvalStatus}. No SMTP delivery was started.`);
          }
          if (this.#now() >= Date.parse(draft.expiresAt)) {
            throw new DraftError("DRAFT_EXPIRED", "The draft expired while awaiting confirmation. No SMTP delivery was started.");
          }
          // Settings may change while the user is reading the confirmation window.
          const afterApproval = await this.#requireAccount();
          if (afterApproval.accountScope !== binding.scope || accountFingerprint(afterApproval) !== binding.fingerprint) {
            throw new DraftError("DRAFT_ACCOUNT_CHANGED", "The account changed while awaiting approval. Prepare a new draft.");
          }
          authorizationCode = await this.#requireAuthorizationCode(afterApproval);
          // Decryption can await a helper process. Recheck before dispatch, but
          // always use the secret from the already captured matching snapshot.
          if ((await this.#requireAccount()).accountScope !== binding.scope) {
            throw new DraftError("DRAFT_ACCOUNT_CHANGED", "The account changed before delivery. Prepare a new draft.");
          }
          if (this.#now() >= Date.parse(draft.expiresAt)) {
            throw new DraftError("DRAFT_EXPIRED", "The approved draft expired before delivery. Prepare a new draft.");
          }
          try {
            const attachments = await this.#outgoingAttachments.acquire(message.attachmentIds ?? [], binding.scope);
            try {
              await beforeDispatch();
              const receipt = await this.#smtp.send(
                binding.account.smtp, binding.account.username, authorizationCode, message, attachments, beforeDispatch,
              );
              sentRawMessage = receipt.rawMessage;
              return receipt;
            } finally { await this.#outgoingAttachments.release(attachments); }
          } catch (error) {
            if (error instanceof DraftError) throw error;
            if (error instanceof ToolFailure && error.code === "MESSAGE_TOO_LARGE") {
              throw new DraftError("MESSAGE_TOO_LARGE", "The encoded email exceeds 32 MiB. Reduce the attachments and prepare a new draft.");
            }
            if (error instanceof DeliveryFailure && error.outcome === "not_sent") {
              throw new DraftError("DRAFT_SEND_FAILED", "SMTP did not accept the email. Check its attempt status before preparing another message.");
            }
            throw new DraftError("DRAFT_DELIVERY_UNKNOWN", "SMTP acceptance is uncertain. Do not resend automatically.");
          }
        },
        saveSentCopy: async (_message, receipt) => {
          try {
          if (!binding || !authorizationCode) {
            throw failure("SENT_COPY_FAILED", "The sent copy could not be stored safely.");
          }
          const boundAccount = binding.account;
          await this.#withImapAuthorization(boundAccount, authorizationCode, "SENT_COPY_FAILED", (session) =>
            session.appendMessage(boundAccount.folders.sent, receipt.rawMessage, ["\\Seen"], new Date(this.#now())),
          );
          } finally { receipt.rawMessage.fill(0); }
        },
      });
      await this.#drafts.flush();
      return result;
    } catch (error) {
      if (error instanceof ToolFailure) {
        throw error;
      }
      if (error instanceof DraftError) {
        throw failure(error.code, error.message);
      }
      throw failure("DRAFT_SEND_FAILED", "The draft operation did not complete. Query the draft status before any further send request.");
    } finally {
      sentRawMessage?.fill(0);
      this.#queuedSends--;
      release();
    }
  }

  async setEmailFlags(input: {
    messageRefs: string[];
    authorizationId?: string | undefined;
    read?: boolean | undefined;
    starred?: boolean | undefined;
  }): Promise<unknown> {
    if (input.read === undefined && input.starred === undefined) {
      throw failure("INVALID_INPUT", "At least one flag change is required.");
    }
    const account = await this.#requireAccount();
    const locators = this.#decodeReferenceList(input.messageRefs, 100, account);
    const authorization = this.#consumeAuthorization(input.authorizationId, account, { action: "flags", messageRefs: input.messageRefs });
    return this.#withImap(account, "SET_FLAGS_FAILED", async (session) => {
      let started = false;
      let completed = 0;
      try {
      for (const group of groupLocators(locators)) {
        await this.#selectAndValidate(session, group[0]!);
        const uids = [...new Set(group.map((entry) => entry.uid))];
        const additions: string[] = [];
        const removals: string[] = [];
        placeFlag("\\Seen", input.read, additions, removals);
        placeFlag("\\Flagged", input.starred, additions, removals);
        await this.#checkAuthorization(authorization, "flags", account);
        if (additions.length) started = true;
        await session.addFlags(uids, additions);
        await this.#checkAuthorization(authorization, "flags", account);
        if (removals.length) started = true;
        await session.removeFlags(uids, removals);
        completed += uids.length;
      }
      } catch (error) {
        if (!started) throw error;
        return { ok: false, status: "partial_failure", updated: completed,
          unconfirmed: new Set(input.messageRefs).size - completed,
          failure: { code: error instanceof ToolFailure ? error.code : "SET_FLAGS_FAILED",
            message: "Some flag writes may already have been applied. Read current flags before requesting another change." } };
      }
      return { updated: locators.length, read: input.read ?? null, starred: input.starred ?? null };
    });
  }

  async moveEmails(input: { messageRefs: string[]; destination: string }): Promise<unknown> {
    const destination = validateMailboxPath(input.destination);
    return this.#moveTo(input.messageRefs, destination, "MOVE_FAILED", "moved");
  }

  async trashEmails(input: { messageRefs: string[]; authorizationId?: string | undefined }): Promise<unknown> {
    const account = await this.#requireAccount();
    return this.#moveTo(input.messageRefs, account.folders.trash, "TRASH_FAILED", "trashed", account, input.authorizationId);
  }

  async downloadAttachment(input: { messageRef: string; attachmentId: string }): Promise<unknown> {
    const account = await this.#requireAccount();
    if (account.attachmentsDisabled) throw failure("CAPABILITY_DISABLED", "File downloads are unavailable for this account.");
    const locator = this.#decodeReference(input.messageRef, account);
    if (!/^\d+(?:\.\d+)*$/u.test(input.attachmentId)) {
      throw failure("INVALID_ATTACHMENT", "The attachment identifier is invalid.");
    }
    return this.#withImap(account, "ATTACHMENT_DOWNLOAD_FAILED", async (session) => {
      await this.#selectAndValidate(session, locator);
      const records = await session.fetchMessages([locator.uid], {});
      const record = records.find((entry) => entry.uid === locator.uid);
      if (!record) {
        throw failure("MESSAGE_NOT_FOUND", "The referenced message no longer exists.");
      }
      const part = flattenAttachmentParts(record.bodyStructure).find((entry) => entry.part === input.attachmentId);
      if (!part) {
        throw failure("ATTACHMENT_NOT_FOUND", "The attachment no longer exists in this message.");
      }
      if (part.size > account.downloadLimitBytes) {
        throw failure("ATTACHMENT_TOO_LARGE", "The attachment exceeds the configured download limit.");
      }
      const download = await session.downloadPart(locator.uid, part.part, account.downloadLimitBytes + 1);
      if (download.expectedSize > account.downloadLimitBytes) {
        download.content.destroy();
        throw failure("ATTACHMENT_TOO_LARGE", "The attachment exceeds the configured download limit.");
      }
      try {
        const saved = await this.#attachments.save({
          rootDirectory: account.downloadDirectory,
          suggestedName: part.filename,
          maxBytes: account.downloadLimitBytes,
          expectedBytes: download.expectedSize,
          content: download.content,
        });
        return {
          messageRef: input.messageRef,
          attachmentId: part.part,
          contentType: part.contentType,
          path: saved.path,
          filename: saved.filename,
          bytes: saved.bytes,
        };
      } catch (error) {
        download.content.destroy();
        if (error instanceof ToolFailure) {
          throw error;
        }
        throw failure("ATTACHMENT_SAVE_FAILED", "The attachment could not be saved in the configured download directory.");
      }
    });
  }

  async #testImap(account: MailAccountConfig, authorizationCode: string) {
    let session: ImapSession | undefined;
    try {
      session = await this.#imap.connect(account.imap, account.username, authorizationCode);
      return await session.listMailboxes(account.folders);
    } finally {
      await session?.close().catch(() => undefined);
    }
  }

  async #withImap<T>(
    account: AccountOperation,
    errorCode: string,
    operation: (session: ImapSession) => Promise<T>,
  ): Promise<T> {
    const authorizationCode = await this.#requireAuthorizationCode(account);
    return this.#withImapAuthorization(account, authorizationCode, errorCode, operation);
  }

  async #withImapAuthorization<T>(
    account: MailAccountConfig,
    authorizationCode: string,
    errorCode: string,
    operation: (session: ImapSession) => Promise<T>,
  ): Promise<T> {
    let session: ImapSession | undefined;
    try {
      session = await this.#imap.connect(account.imap, account.username, authorizationCode);
      return await operation(session);
    } catch (error) {
      if (error instanceof ToolFailure) {
        throw error;
      }
      throw failure(errorCode, "QQ Mail could not complete the IMAP operation.");
    } finally {
      await session?.close().catch(() => undefined);
    }
  }

  async #requireAccount(): Promise<AccountOperation> {
    const context = await this.#accounts.getContext();
    if (!context) {
      throw failure("ACCOUNT_NOT_CONFIGURED", "Open QQ Mail settings and configure an account first.");
    }
    try {
      if (!/^[a-f0-9]{64}$/u.test(context.scope)) throw new Error("Invalid account scope");
      return {
        ...validateAccountConfig(context.account),
        accountScope: context.scope,
        getAuthorizationCode: () => context.getAuthorizationCode(),
      };
    } catch {
      throw failure("INVALID_ACCOUNT_CONFIG", "The saved QQ Mail settings are invalid. Open settings and save them again.");
    }
  }

  async #requireAuthorizationCode(account: AccountOperation): Promise<string> {
    const authorizationCode = await account.getAuthorizationCode();
    if (!isUsableAuthorizationCode(authorizationCode)) {
      throw failure("CREDENTIAL_REQUIRED", "Open QQ Mail settings and store an authorization code first.");
    }
    return authorizationCode;
  }

  #decodeReference(reference: string, account: AccountOperation): MessageLocator {
    try {
      const locator = this.#references.decode(reference);
      if (
        !locator ||
        !Number.isSafeInteger(locator.uid) ||
        locator.uid < 1 ||
        !/^\d+$/u.test(locator.uidValidity) ||
        !locator.mailbox
      ) {
        throw new Error("Invalid message locator");
      }
      if (locator.accountScope !== account.accountScope) {
        throw failure("STALE_MESSAGE_REFERENCE", "The account changed; search for the message again.");
      }
      return { ...locator, mailbox: validateMailboxPath(locator.mailbox) };
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      throw failure("INVALID_MESSAGE_REFERENCE", "The message reference is invalid.");
    }
  }

  #decodeReferenceList(references: string[], maximum: number, account: AccountOperation): MessageLocator[] {
    if (!Array.isArray(references) || references.length < 1 || references.length > maximum) {
      throw failure("INVALID_INPUT", `Between 1 and ${maximum} message references are required.`);
    }
    return references.map((reference) => this.#decodeReference(reference, account));
  }

  async #selectAndValidate(session: ImapSession, locator: MessageLocator): Promise<void> {
    const selected = await session.selectMailbox(locator.mailbox);
    if (selected.uidValidity !== locator.uidValidity) {
      throw failure("STALE_MESSAGE_REFERENCE", "The mailbox UIDVALIDITY changed; search for the message again.");
    }
  }

  async #resolveMessage(
    session: ImapSession,
    account: MailAccountConfig,
    locator: MessageLocator,
    range: ReadBodyRange = {},
    requestBudget?: ReadRequestBudget,
  ): Promise<ResolvedMessage> {
    await this.#selectAndValidate(session, locator);
    return this.#resolveSelectedMessage(session, account, locator, range, requestBudget);
  }

  async #resolveSelectedMessage(
    session: ImapSession,
    account: MailAccountConfig,
    locator: MessageLocator,
    range: ReadBodyRange = {},
    requestBudget?: ReadRequestBudget,
  ): Promise<ResolvedMessage> {
    if (requestBudget && requestBudget.remainingBytes < 1) {
      throw failure("READ_REQUEST_BYTE_LIMIT", "The total MIME byte budget for this request was reached. Read remaining messages individually.");
    }
    const maximum = Math.min(messageParseLimit(account), requestBudget?.remainingBytes ?? Infinity);
    return this.#readBudget.run(maximum + 1, async () => {
      let records: ImapMessageData[] = [];
      try {
        records = await session.fetchMessages([locator.uid], { sourceMaxBytes: maximum + 1 });
        checkReadCancelled(range.signal);
        const record = records.find((entry) => entry.uid === locator.uid);
        if (!record) throw failure("MESSAGE_NOT_FOUND", "The referenced message no longer exists.");
        if (requestBudget) {
          requestBudget.remainingBytes = Math.max(0, requestBudget.remainingBytes - (record.source?.length ?? 0));
          if ((record.size ?? record.source?.length ?? 0) > maximum && maximum < messageParseLimit(account)) {
            throw failure("READ_REQUEST_BYTE_LIMIT", "The total MIME byte budget for this request was reached. Read remaining messages individually.");
          }
        }
        return await this.#parseResolved(account, locator, record, range);
      } finally {
        // Never retain source in a ResolvedMessage or mutate gateway-owned/test fixture records.
        records = [];
      }
    }, range.signal);
  }

  async #parseResolved(
    account: MailAccountConfig,
    locator: MessageLocator,
    record: ImapMessageData,
    range: ReadBodyRange = {},
  ): Promise<ResolvedMessage> {
    const maximum = messageParseLimit(account);
    if ((record.size ?? 0) > maximum || (record.source?.length ?? 0) > maximum) {
      throw failure("MESSAGE_TOO_LARGE", "The message exceeds the configured safe parsing limit.");
    }
    if (!record.source) {
      throw failure("MESSAGE_NOT_FOUND", "The message source is unavailable.");
    }
    if ((record.size ?? 0) > record.source.length) {
      throw failure("MESSAGE_SOURCE_INCOMPLETE", "The server returned an incomplete MIME source. Retry this message individually.");
    }
    try {
      const { source, ...metadata } = record;
      return { locator, record: metadata, sourceBytes: source.length, parsed: await parseIncomingMessage(source, range) };
    } catch {
      checkReadCancelled(range.signal);
      throw failure("MAIL_PARSE_FAILED", "The message MIME content could not be parsed safely.");
    }
  }

  #formatSearchResult(mailbox: string, uidValidity: string, record: ImapMessageData, accountScope: string) {
    const envelope = record.envelope;
    return {
      messageRef: this.#references.encode({ mailbox, uidValidity, uid: record.uid, accountScope }),
      subject: cleanEnvelopeText(envelope?.subject, "(no subject)"),
      date: normalizeDate(envelope?.date ?? record.internalDate),
      from: normalizeEnvelopeAddresses(envelope?.from),
      to: normalizeEnvelopeAddresses(envelope?.to),
      cc: normalizeEnvelopeAddresses(envelope?.cc),
      size: record.size ?? null,
      unread: !record.flags.has("\\Seen"),
      starred: record.flags.has("\\Flagged"),
      hasAttachments: flattenAttachmentParts(record.bodyStructure).length > 0,
      untrusted: true,
    };
  }

  #formatReadMessage(message: ResolvedMessage): ReadMessageResult {
    const attachments = mergeAttachmentMetadata(message.record.bodyStructure, message.parsed);
    const metadataTruncated = attachments.length > 50 || message.parsed.references.length > 25 ||
      [message.parsed.from, message.parsed.replyTo, message.parsed.to, message.parsed.cc].some(entries => entries.length > 20);
    const truncationReasons = [
      ...(message.parsed.bodyTruncated ? ["BODY_RANGE"] : []),
      ...(metadataTruncated ? ["METADATA_LIMIT"] : []),
    ];
    return {
      messageRef: this.#references.encode(message.locator),
      mailbox: message.locator.mailbox,
      uid: message.locator.uid,
      subject: message.parsed.subject,
      date: normalizeDate(message.parsed.date ?? message.record.internalDate),
      from: message.parsed.from.slice(0, 20),
      replyTo: message.parsed.replyTo.slice(0, 20),
      to: message.parsed.to.slice(0, 20),
      cc: message.parsed.cc.slice(0, 20),
      messageId: message.parsed.messageId ?? null,
      inReplyTo: message.parsed.inReplyTo ?? null,
      references: message.parsed.references.slice(0, 25),
      unread: !message.record.flags.has("\\Seen"),
      starred: message.record.flags.has("\\Flagged"),
      body: {
        format: "plain_text", text: message.parsed.text, truncated: message.parsed.bodyTruncated,
        offset: message.parsed.bodyOffset, returnedChars: message.parsed.text.length,
        totalChars: message.parsed.bodyTotalChars, nextOffset: message.parsed.bodyNextOffset,
        truncationReasons: message.parsed.bodyTruncated ? ["BODY_RANGE"] : [],
      },
      attachments: attachments.slice(0, 50),
      incomplete: truncationReasons.length > 0, truncationReasons,
      untrusted: true,
    };
  }

  async #moveTo(
    references: string[],
    rawDestination: string,
    errorCode: string,
    countName: "moved" | "trashed",
    existingAccount?: AccountOperation,
    authorizationId?: string,
  ): Promise<unknown> {
    const account = existingAccount ?? await this.#requireAccount();
    const locators = this.#decodeReferenceList(references, 100, account);
    const destination = validateMailboxPath(rawDestination);
    const authorization = countName === "trashed"
      ? this.#consumeAuthorization(authorizationId, account, { action: "trash", messageRefs: references }) : undefined;
    const expiresAt = new Date(this.#now() + 120_000).toISOString();
    const decision = authorization ? { status: "approved" } : await this.#mutationApproval.confirm({ action: countName === "trashed" ? "trash" : "move",
      account: account.email, destination, messages: locators, expiresAt });
    if (decision.status !== "approved" || this.#now() >= Date.parse(expiresAt)) {
      throw failure("MAIL_CHANGE_APPROVAL_REQUIRED", `Mailbox change was not approved (${decision.status}). No messages were moved.`);
    }
    if ((await this.#requireAccount()).accountScope !== account.accountScope) {
      throw failure("ACCOUNT_CHANGED", "The account changed while awaiting confirmation. No messages were moved.");
    }
    return this.#withImap(account, errorCode, async (session) => {
      const mailboxes = await session.listMailboxes(account.folders);
      if (!mailboxes.some((entry) => mailboxEquals(entry.path, destination))) {
        throw failure("MAILBOX_NOT_FOUND", "The destination mailbox does not exist.");
      }
      let completedCount = 0;
      for (const group of groupLocators(locators)) {
        try {
          await this.#selectAndValidate(session, group[0]!);
          await this.#checkAuthorization(authorization, "trash", account);
          await session.moveMessages([...new Set(group.map((entry) => entry.uid))], destination);
          completedCount += group.length;
        } catch (error) {
          if (completedCount === 0) {
            throw error;
          }
          const failedCount = locators.length - completedCount;
          return {
            ok: false,
            status: "partial_failure",
            [countName]: completedCount,
            failed: failedCount,
            destination,
            failure: {
              code: error instanceof ToolFailure ? error.code : errorCode,
              message: `QQ Mail completed ${completedCount} of ${locators.length} requested operations; ${failedCount} failed or could not be confirmed.`,
            },
          };
        }
      }
      return { [countName]: locators.length, destination };
    });
  }

}

export function validateRestoredDraftRecord(record: DraftSnapshotRecord<OutgoingMessage, Record<string, unknown>, unknown>): boolean {
  try {
    const binding = record.binding as DraftAccountBinding | undefined;
    if (!binding || !/^[a-f0-9]{64}$/u.test(binding.scope) || !/^[A-Za-z0-9_-]{43}$/u.test(binding.fingerprint) ||
        accountFingerprint(validateAccountConfig(binding.account)) !== binding.fingerprint) return false;
    const message = record.content?.payload;
    if (!message) return record.state !== "prepared";
    if (!message.messageId || !/^<[a-f0-9]{48}@qq-mail\.local>$/u.test(message.messageId) ||
        message.from.address !== binding.account.email || typeof message.text !== "string" || message.text.length > 1_500_000 ||
        (message.html !== undefined && (typeof message.html !== "string" || message.html.length > 1_000_000))) return false;
    validateHeaderText(message.subject);
    for (const recipients of [message.to, message.cc, message.bcc]) {
      if (!Array.isArray(recipients) || recipients.length > 100) return false;
      for (const recipient of recipients) { normalizeEmailAddress(recipient.address); validateHeaderText(recipient.name ?? "", 200); }
    }
    return message.to.length + message.cc.length + message.bcc.length > 0;
  } catch { return false; }
}

function validateAccountConfig(value: MailAccountConfig): MailAccountConfig {
  const email = normalizeEmailAddress(value.email);
  const username = validateCredentialUsername(value.username);
  const displayName = validateHeaderText(value.displayName, 200);
  assertSecureServerConfig(value.imap);
  assertSecureServerConfig(value.smtp);
  const folders = {
    inbox: validateMailboxPath(value.folders.inbox),
    sent: validateMailboxPath(value.folders.sent),
    trash: validateMailboxPath(value.folders.trash),
    ...(value.folders.drafts ? { drafts: validateMailboxPath(value.folders.drafts) } : {}),
    ...(value.folders.spam ? { spam: validateMailboxPath(value.folders.spam) } : {}),
    ...(value.folders.archive ? { archive: validateMailboxPath(value.folders.archive) } : {}),
  };
  if (
    !Number.isSafeInteger(value.downloadLimitBytes) ||
    value.downloadLimitBytes < 1 ||
    value.downloadLimitBytes > MAX_DOWNLOAD_BYTES ||
    typeof value.downloadDirectory !== "string" ||
    (!value.attachmentsDisabled && !value.downloadDirectory.trim()) ||
    value.downloadDirectory.length > 4096 ||
    /[\r\n\0]/u.test(value.downloadDirectory) ||
    (value.attachmentsDisabled ? value.downloadDirectory !== "" : !isLocalAbsoluteWindowsPath(value.downloadDirectory)) ||
    (value.attachmentsDisabled !== undefined && typeof value.attachmentsDisabled !== "boolean")
  ) {
    throw new Error("Download configuration is invalid");
  }
  if (
    value.messageParseLimitBytes !== undefined &&
    (!Number.isSafeInteger(value.messageParseLimitBytes) ||
      value.messageParseLimitBytes < 1 ||
      value.messageParseLimitBytes > MAX_DOWNLOAD_BYTES)
  ) {
    throw new Error("Message parse limit is invalid");
  }
  return {
    ...value,
    email,
    username,
    displayName,
    folders,
    downloadDirectory: value.downloadDirectory.trim(),
  };
}

function snapshotAccount(account: MailAccountConfig): MailAccountConfig {
  return {
    email: account.email,
    username: account.username,
    displayName: account.displayName,
    imap: {
      host: account.imap.host,
      port: account.imap.port,
      security: account.imap.security,
    },
    smtp: {
      host: account.smtp.host,
      port: account.smtp.port,
      security: account.smtp.security,
    },
    folders: {
      inbox: account.folders.inbox,
      sent: account.folders.sent,
      trash: account.folders.trash,
      ...(account.folders.drafts === undefined ? {} : { drafts: account.folders.drafts }),
      ...(account.folders.spam === undefined ? {} : { spam: account.folders.spam }),
      ...(account.folders.archive === undefined ? {} : { archive: account.folders.archive }),
    },
    downloadDirectory: account.downloadDirectory,
    ...(account.attachmentsDisabled ? { attachmentsDisabled: true } : {}),
    downloadLimitBytes: account.downloadLimitBytes,
    ...(account.messageParseLimitBytes === undefined
      ? {}
      : { messageParseLimitBytes: account.messageParseLimitBytes }),
  };
}

function accountFingerprint(account: MailAccountConfig): string {
  return createHash("sha256").update(JSON.stringify(snapshotAccount(account))).digest("base64url");
}

function validateCredentialUsername(value: string): string {
  if (typeof value !== "string" || !value || value.length > 320 || /[\r\n\0]/u.test(value)) {
    throw new Error("Username is invalid");
  }
  return value;
}

function validateMailboxPath(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\r\n\0]/u.test(value)) {
    throw new Error("Mailbox path is invalid");
  }
  return value.trim();
}

function validateDraftId(value: string): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 256 || /[^A-Za-z0-9._~-]/u.test(value)) {
    throw failure("INVALID_DRAFT", "The draft identifier is invalid.");
  }
  return value;
}

function isUsableAuthorizationCode(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\r\n\0]/u.test(value);
}

function validateReadRange(input: ReadBodyRange): ReadBodyRange {
  const bodyOffset = input.bodyOffset ?? 0;
  const bodyLimit = input.bodyLimit ?? DEFAULT_BODY_CHARS;
  if (!Number.isSafeInteger(bodyOffset) || bodyOffset < 0 ||
      !Number.isSafeInteger(bodyLimit) || bodyLimit < 1 || bodyLimit > MAX_BODY_PAGE_CHARS) {
    throw failure("INVALID_INPUT", "bodyOffset must be non-negative and bodyLimit must be between 1 and 50000 characters.");
  }
  return { bodyOffset, bodyLimit, signal: input.signal };
}

function isSkippableReadError(error: unknown): error is ToolFailure {
  return error instanceof ToolFailure && [
    "MESSAGE_TOO_LARGE", "MESSAGE_NOT_FOUND", "MESSAGE_SOURCE_INCOMPLETE",
    "MAIL_PARSE_FAILED", "READ_REQUEST_BYTE_LIMIT", "READ_BYTE_BUDGET_EXCEEDED", "READ_CONCURRENCY_LIMIT",
  ].includes(error.code);
}

function buildSearchQuery(input: SearchEmailsInput): ImapSearchQuery {
  const result: ImapSearchQuery = {};
  assignSearchText(result, "text", input.query, 500);
  assignSearchText(result, "from", input.from, 320);
  assignSearchText(result, "to", input.to, 320);
  assignSearchText(result, "subject", input.subject, 998);
  if (input.after) {
    result.since = parseSearchDate(input.after, "after");
  }
  if (input.before) {
    result.before = parseSearchDate(input.before, "before");
  }
  if (input.unread !== undefined) {
    result.seen = !input.unread;
  }
  if (input.starred !== undefined) {
    result.flagged = input.starred;
  }
  return Object.keys(result).length > 0 ? result : { all: true };
}

function assignSearchText(
  query: ImapSearchQuery,
  key: "text" | "from" | "to" | "subject",
  value: string | undefined,
  maximum: number,
): void {
  if (value === undefined) {
    return;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/u.test(normalized)) {
    throw failure("INVALID_SEARCH", `The ${key} search value is invalid.`);
  }
  query[key] = normalized;
}

function parseSearchDate(value: string, name: string): Date {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/u.test(value)) {
    throw failure("INVALID_SEARCH", `The ${name} date is invalid.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw failure("INVALID_SEARCH", `The ${name} date is invalid.`);
  }
  return date;
}

function searchFingerprint(mailbox: string, input: SearchEmailsInput, accountScope: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      mailbox,
      accountScope,
      query: input.query ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      subject: input.subject ?? null,
      after: input.after ?? null,
      before: input.before ?? null,
      unread: input.unread ?? null,
      starred: input.starred ?? null,
    }))
    .digest("base64url")
    .slice(0, 22);
}

function normalizeOutgoingBody(value: string): string {
  if (typeof value !== "string" || value.length > 500_000 || /\0/u.test(value)) {
    throw failure("INVALID_DRAFT", "The message text is invalid or too large.");
  }
  return value.replace(/\r\n?/gu, "\n").trim();
}

function validateOutgoingHtml(value: string): string {
  if (typeof value !== "string" || value.length > 1_000_000 || /\0/u.test(value)) {
    throw failure("INVALID_DRAFT", "The HTML body is invalid or too large.");
  }
  return value;
}

function appendQuotedReply(text: string, source: ParsedIncomingMessage): string {
  const sender = source.from[0]?.address ?? "unknown sender";
  const date = source.date?.toISOString() ?? "unknown date";
  const quote = source.text
    .split("\n")
    .slice(0, 2_000)
    .map((line) => `> ${line}`)
    .join("\n");
  return `${text}\n\nOn ${date}, ${sender} wrote:\n${quote}`.slice(0, 500_000);
}

function appendForwardedMessage(text: string, source: ParsedIncomingMessage): string {
  const from = source.from.map((entry) => entry.address).join(", ");
  const to = source.to.map((entry) => entry.address).join(", ");
  const metadata = [
    "---------- Forwarded message ----------",
    `From: ${from}`,
    `Date: ${source.date?.toISOString() ?? ""}`,
    `Subject: ${source.subject}`,
    `To: ${to}`,
    "",
    source.text,
  ].join("\n");
  return `${text}\n\n${metadata}`.slice(0, 500_000);
}

function mergeAttachmentMetadata(
  structure: ImapBodyStructure | undefined,
  parsed: ParsedIncomingMessage,
) {
  const parts = flattenAttachmentParts(structure);
  return parts.map((part, index) => ({
    attachmentId: part.part,
    filename: part.filename || parsed.attachments[index]?.filename || "attachment.bin",
    contentType: part.contentType || parsed.attachments[index]?.contentType || "application/octet-stream",
    size: part.size || parsed.attachments[index]?.size || 0,
    disposition: part.disposition,
    contentId: part.contentId ?? parsed.attachments[index]?.contentId ?? null,
    downloadable: true,
  }));
}

function collectThreadIdentifiers(message: ParsedIncomingMessage): Set<string> {
  return new Set(
    [message.messageId, message.inReplyTo, ...message.references]
      .filter((value): value is string => Boolean(value)),
  );
}

function groupLocators(locators: MessageLocator[]): MessageLocator[][] {
  const groups = new Map<string, MessageLocator[]>();
  for (const locator of locators) {
    const key = `${locator.mailbox}\0${locator.uidValidity}`;
    const group = groups.get(key) ?? [];
    group.push(locator);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function uniqueMailboxPaths(mailboxes: string[]): string[] {
  const unique: string[] = [];
  for (const mailbox of mailboxes) {
    if (!unique.some((candidate) => mailboxEquals(candidate, mailbox))) {
      unique.push(mailbox);
    }
  }
  return unique;
}

function locatorKey(locator: MessageLocator): string {
  return `${locator.mailbox}\0${locator.uidValidity}\0${locator.uid}`;
}

function placeFlag(
  flag: string,
  value: boolean | undefined,
  additions: string[],
  removals: string[],
): void {
  if (value === true) {
    additions.push(flag);
  } else if (value === false) {
    removals.push(flag);
  }
}

function mailboxEquals(left: string, right: string): boolean {
  return left === right || (left.toUpperCase() === "INBOX" && right.toUpperCase() === "INBOX");
}

function messageTimestamp(message: ResolvedMessage): number {
  const value = message.parsed.date ?? message.record.internalDate;
  const date = value instanceof Date ? value : value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function normalizeDate(value: Date | string | undefined): string | null {
  const date = value instanceof Date ? value : value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function cleanEnvelopeText(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  return value.replace(/[\r\n\0\u0001-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 998) || fallback;
}

function messageParseLimit(account: MailAccountConfig): number {
  // Leave one byte for detecting a message over the safe parse limit without
  // requesting a literal the protocol parser must reject outright.
  return Math.min(account.messageParseLimitBytes ?? DEFAULT_MESSAGE_PARSE_LIMIT, MAX_IMAP_LITERAL_BYTES - 1);
}

function maskEmail(value: string): string {
  const separator = value.lastIndexOf("@");
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function failure(code: string, message: string): ToolFailure {
  return new ToolFailure(code, message);
}

interface SearchCursorPayload {
  mailbox: string;
  uidValidity: string;
  beforeUid: number;
  fingerprint: string;
}

class SearchCursorCodec {
  constructor(private readonly key: Buffer) {
    if (key.length < 16) {
      throw new Error("Search cursor key must contain at least 16 bytes");
    }
  }

  encode(payload: SearchCursorPayload): string {
    const body = Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.key).update(body).digest("base64url");
    return `qqc1.${body}.${signature}`;
  }

  decode(value: string): SearchCursorPayload {
    try {
      if (typeof value !== "string" || value.length > 4096) {
        throw new Error("Invalid cursor");
      }
      const [prefix, body, signature, extra] = value.split(".");
      if (prefix !== "qqc1" || !body || !signature || extra !== undefined) {
        throw new Error("Invalid cursor");
      }
      const expected = createHmac("sha256", this.key).update(body).digest();
      const received = Buffer.from(signature, "base64url");
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        throw new Error("Invalid cursor");
      }
      const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
      if (
        parsed.v !== 1 ||
        typeof parsed.mailbox !== "string" ||
        typeof parsed.uidValidity !== "string" ||
        typeof parsed.fingerprint !== "string" ||
        typeof parsed.beforeUid !== "number" ||
        !Number.isSafeInteger(parsed.beforeUid) ||
        parsed.beforeUid < 1
      ) {
        throw new Error("Invalid cursor");
      }
      return {
        mailbox: parsed.mailbox,
        uidValidity: parsed.uidValidity,
        beforeUid: parsed.beforeUid,
        fingerprint: parsed.fingerprint,
      };
    } catch {
      throw failure("INVALID_CURSOR", "The search cursor is invalid or expired.");
    }
  }
}
