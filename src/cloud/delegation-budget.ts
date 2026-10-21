import { createHmac, timingSafeEqual } from "node:crypto";
import type { DraftJournalStorage } from "../draft-journal.js";
import { ToolFailure } from "../errors.js";

const LEDGER_AAD = Buffer.from("QQ-Mail cloud delegation budget ledger v1\0", "ascii");
const MAX_LEDGER_BYTES = 4096;
export interface CloudDelegationConsent {
  readonly consentId: string;
  readonly policyDigest: string;
  readonly maxOperations: number;
}
type BudgetState = "new" | "initializing" | "ready" | "failed" | "closed";
export interface CloudDelegationBudgetSnapshot extends CloudDelegationConsent {
  readonly remainingOperations: number | null;
  readonly state: BudgetState;
}
interface Ledger {
  version: 1;
  consentId: string;
  policyDigest: string;
  remainingOperations: number;
  mac: string;
}
function unavailable(): ToolFailure {
  return new ToolFailure("CLOUD_DELEGATION_UNAVAILABLE", "The durable delegation budget is unavailable. Do not retry writes until the operator reviews its persistent state.");
}
function invalid(): ToolFailure {
  return new ToolFailure("CLOUD_DELEGATION_INVALID", "The delegation configuration or authenticated budget ledger is invalid.");
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(value);
}
function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

/**
 * Operator-only persistent budget. Every grant reserves its full allowance before approval.
 * The storage owns private directory enforcement and a process-lifetime exclusive lock.
 * A valid MAC detects edits, not deletion or rollback of an authentic older ledger: the
 * operator must retain the same protected volume and never restore an earlier balance.
 */
export class CloudDelegationBudget {
  readonly #storage: DraftJournalStorage;
  readonly #key: Buffer;
  readonly #consent: Readonly<CloudDelegationConsent>;
  #state: BudgetState = "new";
  #remaining: number | undefined;
  #held = false;
  #closing = false;
  #initialization: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(storage: DraftJournalStorage, key: Buffer, consent: CloudDelegationConsent) {
    if (!storage || !Buffer.isBuffer(key) || key.length !== 32 || !consent ||
        !validId(consent.consentId) || !validDigest(consent.policyDigest) ||
        !validCount(consent.maxOperations) || consent.maxOperations < 1) throw invalid();
    this.#storage = storage;
    this.#key = Buffer.from(key);
    this.#consent = Object.freeze({ consentId: consent.consentId, policyDigest: consent.policyDigest, maxOperations: consent.maxOperations });
  }

  initialize(): Promise<void> {
    if (this.#closing || this.#state === "failed" || this.#state === "closed") return Promise.reject(unavailable());
    if (this.#state === "ready") return Promise.resolve();
    if (this.#initialization) return this.#initialization;
    this.#state = "initializing";
    this.#initialization = this.#enqueue(async () => {
      let bytes: Buffer | null = null;
      try {
        await this.#storage.acquire();
        this.#held = true;
        if (this.#closing) throw unavailable();
        bytes = await this.#storage.read();
        if (this.#closing) throw unavailable();
        const previous = bytes === null ? undefined : this.#decode(bytes);
        if (previous?.consentId === this.#consent.consentId) {
          if (previous.policyDigest !== this.#consent.policyDigest) {
            throw new ToolFailure("CLOUD_DELEGATION_POLICY_CHANGED", "The same consent ID cannot authorize a changed policy. The operator must provide a new explicit consent.");
          }
          if (previous.remainingOperations > this.#consent.maxOperations) throw invalid();
          this.#remaining = previous.remainingOperations;
        } else {
          // A different ID comes only from protected operator configuration, never MCP input.
          await this.#write(this.#consent.maxOperations);
          this.#remaining = this.#consent.maxOperations;
        }
        if (this.#closing) throw unavailable();
        this.#state = "ready";
      } catch (error) {
        this.#disable();
        if (this.#held) await this.#release().catch(() => undefined);
        if (error instanceof ToolFailure && ["CLOUD_DELEGATION_INVALID", "CLOUD_DELEGATION_POLICY_CHANGED"].includes(error.code)) throw error;
        throw unavailable();
      } finally { bytes?.fill(0); }
    });
    return this.#initialization;
  }

  reserve(units: number): Promise<void> {
    if (!validCount(units) || units < 1) return Promise.reject(invalid());
    if (this.#state !== "ready" || this.#closing) return Promise.reject(unavailable());
    return this.#enqueue(async () => {
      if (this.#state !== "ready" || this.#closing || this.#remaining === undefined) throw unavailable();
      if (units > this.#remaining) {
        throw new ToolFailure("CLOUD_DELEGATION_EXHAUSTED", "The owner's total delegation budget is insufficient. Only the operator can supply a new explicit consent.");
      }
      const remaining = this.#remaining - units;
      try {
        await this.#write(remaining);
        // The reservation is visible to callers only after the durable write barrier succeeds.
        this.#remaining = remaining;
      } catch {
        // The write may have reached disk despite its error. Never refund or continue locally.
        this.#disable();
        throw unavailable();
      }
    });
  }

  snapshot(): CloudDelegationBudgetSnapshot {
    return Object.freeze({ ...this.#consent, remainingOperations: this.#state === "ready" ? this.#remaining ?? null : null, state: this.#state });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#tail.then(async () => {
      try { if (this.#held) await this.#release(); }
      catch { throw unavailable(); }
      finally { this.#key.fill(0); this.#remaining = undefined; this.#state = "closed"; }
    });
    return this.#closePromise;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
  #disable(): void { this.#state = "failed"; this.#remaining = undefined; }
  async #release(): Promise<void> { await this.#storage.release(); this.#held = false; }
  #mac(ledger: Omit<Ledger, "mac">): Buffer {
    const fields = JSON.stringify({ version: ledger.version, consentId: ledger.consentId, policyDigest: ledger.policyDigest, remainingOperations: ledger.remainingOperations });
    return createHmac("sha256", this.#key).update(LEDGER_AAD).update(fields, "utf8").digest();
  }
  async #write(remainingOperations: number): Promise<void> {
    const fields = { version: 1 as const, consentId: this.#consent.consentId, policyDigest: this.#consent.policyDigest, remainingOperations };
    const mac = this.#mac(fields);
    const bytes = Buffer.from(JSON.stringify({ ...fields, mac: mac.toString("hex") }), "utf8");
    try { await this.#storage.write(bytes); }
    finally { mac.fill(0); bytes.fill(0); }
  }
  #decode(bytes: Buffer): Ledger {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_LEDGER_BYTES) throw invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
    catch { throw invalid(); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(",") !== "consentId,mac,policyDigest,remainingOperations,version" || record.version !== 1 ||
        !validId(record.consentId) || !validDigest(record.policyDigest) || !validCount(record.remainingOperations) ||
        !validDigest(record.mac)) throw invalid();
    const ledger: Ledger = { version: 1, consentId: record.consentId, policyDigest: record.policyDigest, remainingOperations: record.remainingOperations, mac: record.mac };
    const expected = this.#mac(ledger);
    const actual = Buffer.from(ledger.mac, "hex");
    try { if (!timingSafeEqual(expected, actual)) throw invalid(); }
    finally { expected.fill(0); actual.fill(0); }
    return ledger;
  }
}
