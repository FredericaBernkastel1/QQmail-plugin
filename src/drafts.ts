import { randomUUID } from "node:crypto";
import { serialize } from "node:v8";

export const DRAFT_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_DRAFT_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_MAX_DRAFTS = 128;
export const DEFAULT_MAX_DRAFT_BYTES = 16 * 1024 * 1024;

export interface DraftPreview {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
}

export interface PreparedDraft<TPreview = DraftPreview> {
  readonly draftId: string;
  readonly preview: TPreview;
  readonly warnings: readonly string[];
  readonly expiresAt: string;
}

export interface SmtpSendReceipt {
  readonly messageId?: string;
  readonly accepted?: readonly string[];
  readonly rejected?: readonly string[];
}

export interface DraftDeliveryAdapter<TPayload, TReceipt extends SmtpSendReceipt = SmtpSendReceipt> {
  send(payload: TPayload): Promise<TReceipt>;
  saveSentCopy(payload: TPayload, receipt: TReceipt): Promise<void>;
}

export type DraftSendStatus =
  | "sent"
  | "partially_sent"
  | "sent_copy_failed"
  | "partially_sent_copy_failed";

export interface DraftSentResult {
  readonly draftId: string;
  readonly status: DraftSendStatus;
  readonly sent: true;
  readonly sentCopySaved: boolean;
  readonly sentAt: string;
  readonly messageId?: string;
  readonly accepted?: readonly string[];
  readonly rejected?: readonly string[];
  readonly warning?: string;
}

export interface DraftUnknownResult {
  readonly draftId: string;
  readonly status: "delivery_unknown";
  readonly sent: null;
  readonly sentCopySaved: false;
  readonly attemptedAt: string;
  readonly messageId?: string;
  readonly warning: string;
}

export type DraftSendResult = DraftSentResult | DraftUnknownResult;

export type DraftState = "prepared" | "sending" | "sent" | "not_sent" | "delivery_unknown" | "cancelled";

export interface DraftAttemptSummary {
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly messageId?: string;
  readonly status?: "sent" | "not_sent" | "delivery_unknown";
  readonly errorCode?: DraftError["code"];
}

/** Metadata-only view: terminal records never expose the released message body. */
export interface DraftStatus {
  readonly draftId: string;
  readonly status: DraftState;
  readonly expiresAt: string;
  readonly retainUntil?: string;
  readonly attempt?: DraftAttemptSummary;
  readonly result?: DraftSendResult;
  readonly failure?: Readonly<{ code: DraftError["code"]; message: string }>;
}

export class DraftError extends Error {
  readonly code: "DRAFT_NOT_FOUND" | "DRAFT_EXPIRED" | "DRAFT_SEND_FAILED" | "DRAFT_DELIVERY_UNKNOWN" | "DRAFT_ACCOUNT_CHANGED" | "DRAFT_APPROVAL_REQUIRED" | "DRAFT_APPROVAL_DECLINED" | "DRAFT_APPROVAL_TIMEOUT" | "DRAFT_APPROVAL_UNAVAILABLE" | "DRAFT_APPROVAL_TOO_LARGE" | "DRAFT_ATTACHMENTS_INVALID" | "MESSAGE_TOO_LARGE" | "DRAFT_CAPACITY_EXCEEDED" | "DRAFT_NOT_EDITABLE" | "DRAFT_CANCELLED" | "DRAFT_DISPOSED" | "DRAFT_SNAPSHOT_INVALID" | "DRAFT_PERSISTENCE_FAILED";

  constructor(code: DraftError["code"], message: string) {
    super(message);
    this.name = "DraftError";
    this.code = code;
  }
}

export interface DraftStoreOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly ttlMs?: number;
  readonly resultRetentionMs?: number;
  readonly maxDrafts?: number;
  /** Budget for serialized record data, including UTF-8 JSON and the independent preview. */
  readonly maxBytes?: number;
  readonly cleanupIntervalMs?: number;
  /** Notification only; durable write barriers belong to the persistence adapter. */
  readonly onChange?: () => void;
}

export interface DraftPersistenceHooks {
  changed(): void;
  /** Must durably save the current snapshot, including any in-flight marker. */
  beforeSend(): Promise<void>;
}

interface DraftRecord<TPayload, TPreview, TBinding> {
  readonly id: string;
  content?: { payload: TPayload; preview: TPreview; warnings: readonly string[] };
  binding?: TBinding;
  expiresAtMs: number;
  bytes: number;
  state: DraftState;
  retainUntilMs?: number;
  inFlight?: Promise<DraftSendResult>;
  outcome?: DraftSendResult;
  failure?: DraftError;
  attempt?: DraftAttemptSummary;
}

export interface DraftSnapshotRecord<TPayload, TPreview, TBinding> {
  readonly draftId: string;
  readonly expiresAtMs: number;
  readonly state: Exclude<DraftState, "sending">;
  readonly binding?: TBinding;
  readonly content?: Readonly<{ payload: TPayload; preview: TPreview; warnings: readonly string[] }>;
  readonly retainUntilMs?: number;
  readonly outcome?: DraftSendResult;
  readonly failure?: Readonly<{ code: DraftError["code"]; message: string }>;
  readonly attempt?: DraftAttemptSummary;
}

/** Plain data for an encrypted, account-scoped persistence adapter. No credentials. */
export interface DraftSnapshot<TPayload, TPreview = DraftPreview, TBinding = unknown> {
  readonly version: 1;
  readonly records: readonly DraftSnapshotRecord<TPayload, TPreview, TBinding>[];
}

function cloneForStorage<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new TypeError("Draft payload and preview must be safely cloneable.");
  }
}

export class DraftStore<TPayload, TPreview = DraftPreview, TBinding = unknown> {
  private readonly records = new Map<string, DraftRecord<TPayload, TPreview, TBinding>>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly ttlMs: number;
  private readonly resultRetentionMs: number;
  private readonly maxDrafts: number;
  private readonly maxBytes: number;
  private readonly onChange: (() => void) | undefined;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private disposed = false;
  private storedBytes = 0;
  private persistence: DraftPersistenceHooks | undefined;

  constructor(options: DraftStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `draft_${randomUUID()}`);
    this.ttlMs = options.ttlMs ?? DRAFT_TTL_MS;
    this.resultRetentionMs = options.resultRetentionMs ?? DEFAULT_DRAFT_RESULT_RETENTION_MS;
    this.maxDrafts = options.maxDrafts ?? DEFAULT_MAX_DRAFTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_DRAFT_BYTES;
    this.onChange = options.onChange;

    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new TypeError("Draft TTL must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.resultRetentionMs) || this.resultRetentionMs < this.ttlMs) {
      throw new TypeError("Draft result retention must be an integer at least as long as the draft TTL.");
    }
    for (const value of [this.maxDrafts, this.maxBytes, options.cleanupIntervalMs ?? 60_000]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Draft capacity and cleanup interval must be positive integers.");
    }
    this.cleanupTimer = setInterval(() => this.purgeExpired(), options.cleanupIntervalMs ?? 60_000);
    this.cleanupTimer.unref?.();
  }

  prepare(payload: TPayload, preview: TPreview, warnings: readonly string[] = [], expiresByMs?: number, binding?: TBinding): PreparedDraft<TPreview> {
    this.requireOpen();
    this.purgeExpired();
    const draftId = this.createUniqueId();
    const expiresAtMs = Math.min(this.now() + this.ttlMs, expiresByMs ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      throw new DraftError("DRAFT_EXPIRED", "The draft attachments expired. Select them again.");
    }
    const storedPreview = cloneForStorage(preview);
    const storedWarnings = Object.freeze([...warnings]);
    const record: DraftRecord<TPayload, TPreview, TBinding> = {
      id: draftId,
      content: { payload: cloneForStorage(payload), preview: storedPreview, warnings: storedWarnings },
      ...(binding === undefined ? {} : { binding: cloneForStorage(binding) }),
      expiresAtMs,
      state: "prepared",
      bytes: 0,
    };
    record.bytes = this.measure(record);
    this.requireCapacity(1, record.bytes);
    this.records.set(draftId, record);
    this.storedBytes += record.bytes;
    this.changed();
    return this.toPreparedDraft(record);
  }

  prepareEmail(payload: TPayload, preview: TPreview, warnings: readonly string[] = []): PreparedDraft<TPreview> {
    return this.prepare(payload, preview, warnings);
  }

  get(draftId: string): PreparedDraft<TPreview> {
    const record = this.requireRecord(draftId);
    return this.toPreparedDraft(record);
  }

  getBinding(draftId: string): TBinding | undefined {
    const binding = this.requireRecord(draftId).binding;
    return binding === undefined ? undefined : cloneForStorage(binding);
  }

  getPayload(draftId: string): TPayload {
    const record = this.requireRecord(draftId);
    if (!record.content) throw new DraftError("DRAFT_NOT_EDITABLE", "This draft has reached a final state; its message content was released.");
    return cloneForStorage(record.content.payload);
  }

  status(draftId: string): DraftStatus {
    return this.toStatus(this.requireRecord(draftId));
  }

  list(predicate?: (binding: TBinding | undefined) => boolean): readonly DraftStatus[] {
    this.requireOpen();
    this.purgeExpired();
    return [...this.records.values()]
      .filter(record => !predicate || predicate(record.binding === undefined ? undefined : cloneForStorage(record.binding)))
      .map(record => this.toStatus(record));
  }

  update(draftId: string, payload: TPayload, preview: TPreview, warnings: readonly string[] = [], expiresByMs?: number, binding?: TBinding): PreparedDraft<TPreview> {
    const record = this.requireRecord(draftId);
    this.requireEditable(record);
    const expiresAtMs = Math.min(record.expiresAtMs, expiresByMs ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) throw new DraftError("DRAFT_EXPIRED", "The updated draft attachments have expired.");
    const replacement: DraftRecord<TPayload, TPreview, TBinding> = {
      ...record,
      content: { payload: cloneForStorage(payload), preview: cloneForStorage(preview), warnings: Object.freeze([...warnings]) },
      ...(binding === undefined ? {} : { binding: cloneForStorage(binding) }),
      expiresAtMs,
      bytes: 0,
    };
    replacement.bytes = this.measure(replacement);
    this.requireCapacity(0, replacement.bytes - record.bytes);
    this.storedBytes += replacement.bytes - record.bytes;
    this.records.set(record.id, replacement);
    this.changed();
    return this.toPreparedDraft(replacement);
  }

  cancel(draftId: string, reason = "The draft was cancelled."): DraftStatus {
    const record = this.requireRecord(draftId);
    if (record.state === "cancelled") return this.toStatus(record);
    this.requireEditable(record);
    record.state = "cancelled";
    record.failure = new DraftError("DRAFT_CANCELLED", reason.slice(0, 512));
    this.finish(record);
    return this.toStatus(record);
  }

  /** Invalidates only unstarted drafts; an already sending record is never evicted. */
  invalidateWhere(predicate: (payload: TPayload, binding: TBinding | undefined) => boolean, reason = "The draft attachments are no longer available."): number {
    this.requireOpen();
    this.purgeExpired();
    let invalidated = 0;
    for (const record of this.records.values()) {
      if (record.state !== "prepared" || !record.content) continue;
      if (!predicate(cloneForStorage(record.content.payload), record.binding === undefined ? undefined : cloneForStorage(record.binding))) continue;
      record.state = "not_sent";
      record.failure = new DraftError("DRAFT_ATTACHMENTS_INVALID", reason.slice(0, 512));
      this.finish(record);
      invalidated++;
    }
    return invalidated;
  }

  send<TReceipt extends SmtpSendReceipt>(
    draftId: string,
    delivery: DraftDeliveryAdapter<TPayload, TReceipt>,
  ): Promise<DraftSendResult> {
    try {
      const record = this.requireRecord(draftId);
      if (record.state === "sent" || record.state === "delivery_unknown") {
        return Promise.resolve(record.outcome as DraftSendResult);
      }
      if (record.state === "not_sent" || record.state === "cancelled") {
        return Promise.reject(record.failure as DraftError);
      }
      if (record.state === "sending") {
        return record.inFlight as Promise<DraftSendResult>;
      }
      record.state = "sending";
      const messageId = this.payloadMessageId(record.content!.payload);
      record.attempt = Object.freeze({ startedAt: new Date(this.now()).toISOString(), ...(messageId ? { messageId } : {}) });
      this.changed();
      const inFlight = this.deliver(record, delivery);
      record.inFlight = inFlight;
      return inFlight;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  sendEmail<TReceipt extends SmtpSendReceipt>(
    draftId: string,
    delivery: DraftDeliveryAdapter<TPayload, TReceipt>,
  ): Promise<DraftSendResult> {
    return this.send(draftId, delivery);
  }

  purgeExpired(): number {
    const now = this.now();
    let deleted = 0;
    for (const [id, record] of this.records) {
      const preparedExpired = record.state === "prepared" && now >= record.expiresAtMs;
      const terminalExpired =
        record.state !== "prepared" && record.state !== "sending" &&
        record.retainUntilMs !== undefined &&
        now >= record.retainUntilMs;
      if (preparedExpired || terminalExpired) {
        this.removeRecord(id);
        deleted += 1;
      }
    }
    if (deleted > 0) this.changed();
    return deleted;
  }

  get size(): number {
    return this.records.size;
  }

  get usage(): Readonly<{ count: number; bytes: number; sending: number; maxDrafts: number; maxBytes: number }> {
    return { count: this.records.size, bytes: this.storedBytes, sending: [...this.records.values()].filter(record => record.state === "sending").length, maxDrafts: this.maxDrafts, maxBytes: this.maxBytes };
  }

  attachPersistence(hooks: DraftPersistenceHooks): () => void {
    this.requireOpen();
    if (this.persistence) throw new DraftError("DRAFT_PERSISTENCE_FAILED", "Draft persistence is already attached.");
    this.persistence = hooks;
    return () => { if (this.persistence === hooks) this.persistence = undefined; };
  }

  async flush(): Promise<void> {
    if (!this.persistence) return;
    try { await this.persistence.beforeSend(); }
    catch { throw new DraftError("DRAFT_PERSISTENCE_FAILED", "The encrypted draft journal could not be saved. Check the draft status before taking further action."); }
  }

  /**
   * In-flight records are persisted only as body-free unknown outcomes. A crash
   * must never turn a started attempt back into a sendable prepared draft.
   * Persist this snapshot durably before dispatching SMTP, outside this store.
   */
  exportSnapshot(): DraftSnapshot<TPayload, TPreview, TBinding> {
    this.requireOpen();
    this.purgeExpired();
    return {
      version: 1,
      records: [...this.records.values()].map(record => {
        const sending = record.state === "sending";
        return cloneForStorage({
          draftId: record.id,
          expiresAtMs: record.expiresAtMs,
          state: sending ? "delivery_unknown" as const : record.state as Exclude<DraftState, "sending">,
          ...(record.binding === undefined ? {} : { binding: record.binding }),
          ...(record.state === "prepared" && record.content ? { content: record.content } : {}),
          ...(sending ? { retainUntilMs: this.now() + this.resultRetentionMs, outcome: this.unknownResult(record) }
            : { ...(record.retainUntilMs === undefined ? {} : { retainUntilMs: record.retainUntilMs }), ...(record.outcome ? { outcome: record.outcome } : {}) }),
          ...(record.failure ? { failure: { code: record.failure.code, message: record.failure.message } } : {}),
          ...(record.attempt ? { attempt: sending ? { ...record.attempt, status: "delivery_unknown" as const, errorCode: "DRAFT_DELIVERY_UNKNOWN" as const } : record.attempt } : {}),
        });
      }),
    };
  }

  /** The adapter must validate account binding and application payload schemas. */
  restoreSnapshot(snapshot: DraftSnapshot<TPayload, TPreview, TBinding>, validate: (record: DraftSnapshotRecord<TPayload, TPreview, TBinding>) => boolean): number {
    this.requireOpen();
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.records) || snapshot.records.length > this.maxDrafts || typeof validate !== "function") {
      throw new DraftError("DRAFT_SNAPSHOT_INVALID", "The stored draft snapshot is invalid.");
    }
    const restored = new Map<string, DraftRecord<TPayload, TPreview, TBinding>>();
    let bytes = 0;
    for (const input of snapshot.records) {
      const item = cloneForStorage(input);
      if (!item || typeof item !== "object") throw new DraftError("DRAFT_SNAPSHOT_INVALID", "The stored draft record is invalid.");
      const terminal = item.state !== "prepared";
      if (typeof item.draftId !== "string" || !/^draft_[A-Za-z0-9_-]{10,250}$/u.test(item.draftId)
        || this.records.has(item.draftId) || restored.has(item.draftId)
        || !Number.isSafeInteger(item.expiresAtMs) || !Number.isFinite(new Date(item.expiresAtMs).getTime())
        || !["prepared", "sent", "not_sent", "delivery_unknown", "cancelled"].includes(item.state)
        || (terminal ? item.content !== undefined || !Number.isSafeInteger(item.retainUntilMs) : !item.content || item.outcome !== undefined || item.failure !== undefined || item.attempt !== undefined || item.retainUntilMs !== undefined)
        || !validate(item)) {
        throw new DraftError("DRAFT_SNAPSHOT_INVALID", "The stored draft snapshot contains an invalid record.");
      }
      if ((terminal ? item.retainUntilMs! : item.expiresAtMs) <= this.now()) continue;
      if (!terminal && (!Array.isArray(item.content!.warnings) || item.content!.warnings.some((value: unknown) => typeof value !== "string"))) {
        throw new DraftError("DRAFT_SNAPSHOT_INVALID", "The stored draft warnings are invalid.");
      }
      if ((item.state === "sent" && (!item.outcome || item.outcome.sent !== true || !["sent", "partially_sent", "sent_copy_failed", "partially_sent_copy_failed"].includes(item.outcome.status)))
        || (item.state === "delivery_unknown" && (!item.outcome || item.outcome.sent !== null || item.outcome.status !== "delivery_unknown"))
        || ((item.state === "not_sent" || item.state === "cancelled") && (!item.failure || typeof item.failure.code !== "string" || typeof item.failure.message !== "string"))
        || (item.outcome && item.outcome.draftId !== item.draftId)) {
        throw new DraftError("DRAFT_SNAPSHOT_INVALID", "The stored draft result is invalid.");
      }
      const record: DraftRecord<TPayload, TPreview, TBinding> = {
        id: item.draftId,
        expiresAtMs: terminal ? item.expiresAtMs : Math.min(item.expiresAtMs, this.now() + this.ttlMs),
        state: item.state,
        bytes: 0,
        ...(item.binding === undefined ? {} : { binding: item.binding }),
        ...(item.content ? { content: { ...item.content } } : {}),
        ...(item.retainUntilMs === undefined ? {} : { retainUntilMs: Math.min(item.retainUntilMs, this.now() + this.resultRetentionMs) }),
        ...(item.outcome ? { outcome: Object.freeze(item.outcome) } : {}),
        ...(item.failure ? { failure: new DraftError(item.failure.code, item.failure.message.slice(0, 512)) } : {}),
        ...(item.attempt ? { attempt: Object.freeze(item.attempt) } : {}),
      };
      record.bytes = this.measure(record);
      bytes += record.bytes;
      restored.set(record.id, record);
      this.requireCapacity(restored.size, bytes);
    }
    for (const [id, record] of restored) this.records.set(id, record);
    this.storedBytes += bytes;
    if (restored.size > 0) this.changed();
    return restored.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.cleanupTimer);
    for (const [id, record] of this.records) if (record.state !== "sending") this.removeRecord(id);
    // In-flight adapters own their current payload until they finish. Their records
    // are released by finish(), never removed underneath SMTP or Sent-copy work.
  }

  private async deliver<TReceipt extends SmtpSendReceipt>(
    record: DraftRecord<TPayload, TPreview, TBinding>,
    delivery: DraftDeliveryAdapter<TPayload, TReceipt>,
  ): Promise<DraftSendResult> {
    let receipt: TReceipt;
    try {
      if (this.persistence) await this.flush();
      receipt = await delivery.send(cloneForStorage(record.content!.payload));
    } catch (error) {
      if (error instanceof DraftError && error.code === "DRAFT_DELIVERY_UNKNOWN") {
        const outcome = this.unknownResult(record);
        record.state = "delivery_unknown";
        record.outcome = Object.freeze(outcome);
        record.attempt = Object.freeze({ ...record.attempt!, completedAt: new Date(this.now()).toISOString(), status: "delivery_unknown", errorCode: "DRAFT_DELIVERY_UNKNOWN" });
        this.finish(record);
        return record.outcome;
      }
      const failure = error instanceof DraftError
        ? new DraftError(error.code, error.message.slice(0, 512))
        : new DraftError(
            "DRAFT_SEND_FAILED",
            "The send attempt did not complete. Check the attempt status before deciding what to do next.",
          );
      record.state = "not_sent";
      record.failure = failure;
      record.attempt = Object.freeze({ ...record.attempt!, completedAt: new Date(this.now()).toISOString(), status: "not_sent", errorCode: failure.code });
      this.finish(record);
      throw failure;
    }

    const accepted = receipt.accepted === undefined ? undefined : Object.freeze([...receipt.accepted]);
    const rejected = receipt.rejected === undefined ? undefined : Object.freeze([...receipt.rejected]);
    if (accepted !== undefined && rejected !== undefined && accepted.length === 0 && rejected.length > 0) {
      const failure = new DraftError(
        "DRAFT_SEND_FAILED",
        "SMTP rejected every recipient. No recipient was accepted.",
      );
      record.state = "not_sent";
      record.failure = failure;
      record.attempt = Object.freeze({ ...record.attempt!, completedAt: new Date(this.now()).toISOString(), status: "not_sent", errorCode: failure.code });
      this.finish(record);
      throw failure;
    }

    const sentAt = new Date(this.now()).toISOString();
    let sentCopySaved = true;
    try {
      await delivery.saveSentCopy(cloneForStorage(record.content!.payload), receipt);
    } catch {
      sentCopySaved = false;
    }

    const partiallySent = (rejected?.length ?? 0) > 0;
    const warnings = [
      ...(partiallySent
        ? [`SMTP rejected ${rejected!.length} recipient(s); only the accepted recipients may have received the email.`]
        : []),
      ...(sentCopySaved
        ? []
        : ["The email was sent, but its copy could not be saved to the Sent mailbox."]),
    ];
    const outcome: DraftSendResult = {
      draftId: record.id,
      status: partiallySent
        ? sentCopySaved
          ? "partially_sent"
          : "partially_sent_copy_failed"
        : sentCopySaved
          ? "sent"
          : "sent_copy_failed",
      sent: true,
      sentCopySaved,
      sentAt,
      ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
      ...(accepted === undefined ? {} : { accepted }),
      ...(rejected === undefined ? {} : { rejected }),
      ...(warnings.length === 0 ? {} : { warning: warnings.join(" ") }),
    };
    record.state = "sent";
    record.outcome = Object.freeze(outcome);
    record.attempt = Object.freeze({ ...record.attempt!, completedAt: new Date(this.now()).toISOString(), status: "sent", ...(receipt.messageId ? { messageId: receipt.messageId } : {}) });
    this.finish(record);
    return record.outcome;
  }

  private requireRecord(draftId: string): DraftRecord<TPayload, TPreview, TBinding> {
    this.requireOpen();
    const record = this.records.get(draftId);
    if (!record) {
      throw new DraftError("DRAFT_NOT_FOUND", "The draft was not found. Prepare the email again.");
    }
    if (record.state === "prepared" && this.now() >= record.expiresAtMs) {
      this.removeRecord(record.id);
      this.changed();
      throw new DraftError("DRAFT_EXPIRED", "This draft has expired. Prepare the email again.");
    }
    if (record.retainUntilMs !== undefined && this.now() >= record.retainUntilMs) {
      this.removeRecord(record.id);
      this.changed();
      throw new DraftError("DRAFT_NOT_FOUND", "The retained draft result has expired.");
    }
    return record;
  }

  private requireOpen(): void {
    if (this.disposed) throw new DraftError("DRAFT_DISPOSED", "The draft store is closed.");
  }

  private requireEditable(record: DraftRecord<TPayload, TPreview, TBinding>): void {
    if (record.state !== "prepared") throw new DraftError("DRAFT_NOT_EDITABLE", "Only an unstarted prepared draft can be edited or cancelled.");
  }

  private requireCapacity(addCount: number, addBytes: number): void {
    if (this.records.size + addCount > this.maxDrafts || this.storedBytes + addBytes > this.maxBytes) {
      throw new DraftError("DRAFT_CAPACITY_EXCEEDED", "The draft storage limit was reached. Cancel unused drafts or wait for retained results to expire.");
    }
  }

  private measure(record: DraftRecord<TPayload, TPreview, TBinding>): number {
    const { inFlight: _inFlight, bytes: _bytes, ...data } = record;
    const encoded = serialize(data);
    try {
      // JSON escaping can be larger than V8's string encoding. Include it so
      // a permitted message cannot unexpectedly exhaust the journal envelope.
      let jsonBytes = 0;
      try { jsonBytes = Buffer.byteLength(JSON.stringify(data), "utf8"); }
      catch { /* Non-JSON cloneable data is usable by in-memory adapters only. */ }
      return Math.max(encoded.byteLength, jsonBytes);
    } finally { encoded.fill(0); }
  }

  private removeRecord(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    this.storedBytes -= record.bytes;
    delete record.content;
    delete record.binding;
    this.records.delete(id);
  }

  private finish(record: DraftRecord<TPayload, TPreview, TBinding>): void {
    record.retainUntilMs = this.now() + this.resultRetentionMs;
    delete record.content;
    delete record.inFlight;
    const bytes = this.measure(record);
    this.storedBytes += bytes - record.bytes;
    record.bytes = bytes;
    if (this.disposed) this.removeRecord(record.id);
    else this.changed();
  }

  private changed(): void {
    // A notification failure must not reinterpret a completed SMTP result. A
    // persistence adapter provides its own awaited pre-dispatch barrier.
    try { this.onChange?.(); } catch { /* notification only */ }
    try { this.persistence?.changed(); } catch { /* the awaited barrier fails closed */ }
  }

  private payloadMessageId(payload: TPayload): string | undefined {
    if (!payload || typeof payload !== "object" || !("messageId" in payload)) return undefined;
    const messageId = payload.messageId;
    return typeof messageId === "string" && messageId.length <= 998 ? messageId : undefined;
  }

  private unknownResult(record: DraftRecord<TPayload, TPreview, TBinding>): DraftUnknownResult {
    return {
      draftId: record.id,
      status: "delivery_unknown",
      sent: null,
      sentCopySaved: false,
      attemptedAt: record.attempt?.startedAt ?? new Date(this.now()).toISOString(),
      ...(record.attempt?.messageId ? { messageId: record.attempt.messageId } : {}),
      warning: "Delivery could not be confirmed. Check the server or recipient using the Message-ID before deciding whether to send another message. A missing Sent copy does not prove non-delivery, and Message-ID does not guarantee deduplication.",
    };
  }

  private toStatus(record: DraftRecord<TPayload, TPreview, TBinding>): DraftStatus {
    return cloneForStorage({
      draftId: record.id,
      status: record.state,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      ...(record.retainUntilMs === undefined ? {} : { retainUntil: new Date(record.retainUntilMs).toISOString() }),
      ...(record.attempt ? { attempt: record.attempt } : {}),
      ...(record.outcome ? { result: record.outcome } : {}),
      ...(record.failure ? { failure: { code: record.failure.code, message: record.failure.message } } : {}),
    });
  }

  private createUniqueId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.idFactory();
      if (typeof id === "string" && id.length >= 16 && id.length <= 256 && !this.records.has(id)) {
        return id;
      }
    }
    throw new Error("A unique draft identifier could not be created.");
  }

  private toPreparedDraft(record: DraftRecord<TPayload, TPreview, TBinding>): PreparedDraft<TPreview> {
    if (!record.content) throw new DraftError("DRAFT_NOT_EDITABLE", "This draft has reached a final state; query its status for the result.");
    return {
      draftId: record.id,
      preview: cloneForStorage(record.content.preview),
      warnings: [...record.content.warnings],
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    };
  }
}

export { DraftStore as DraftManager };
