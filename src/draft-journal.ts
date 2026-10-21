import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { getConfigPaths, writeFileAtomically, type ConfigStorageOptions } from "./config.js";
import { protectSecret, unprotectSecret } from "./dpapi.js";
import { restrictWindowsPathToCurrentUser } from "./windows-acl.js";
import { acquireOwnedFileLock, type OwnedFileLock } from "./local-lock.js";
import { DEFAULT_DRAFT_RESULT_RETENTION_MS, DraftError, type DraftSnapshot, type DraftSnapshotRecord, type DraftStore } from "./drafts.js";

export const MAX_DRAFT_JOURNAL_BYTES = 48 * 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
const JOURNAL_AAD = Buffer.from("QQ-Mail encrypted draft journal v1", "ascii");

/** Storage and protection injection is for application composition and isolated tests. */
export interface DraftJournalStorage {
  acquire(): Promise<void>;
  read(): Promise<Buffer | null>;
  write(data: Buffer): Promise<void>;
  release(): Promise<void>;
}

export interface DraftJournalProtection {
  protect(value: string): Promise<Buffer>;
  unprotect(value: Buffer): Promise<string>;
}

export interface DraftJournalOptions extends ConfigStorageOptions {
  readonly storage?: DraftJournalStorage;
  readonly protection?: DraftJournalProtection;
  readonly now?: () => number;
}

export interface DraftJournalAttachOptions<TPayload, TPreview, TBinding> {
  /** Validate the persisted application payload and the stable profile/revision binding. */
  readonly validateRecord: (record: DraftSnapshotRecord<TPayload, TPreview, TBinding>) => boolean;
  readonly hasAttachments: (payload: TPayload) => boolean;
}

/** A process-lifetime lock prevents two servers from restoring the same prepared draft. */
export class FileDraftJournalStorage implements DraftJournalStorage {
  private readonly directory: string;
  private readonly file: string;
  private readonly lockFile: string;
  private lock: OwnedFileLock | undefined;

  constructor(private readonly options: ConfigStorageOptions = {}) {
    this.directory = getConfigPaths(options).directory;
    this.file = path.join(this.directory, "drafts.enc.json");
    this.lockFile = path.join(this.directory, "drafts.lock");
  }

  async acquire(): Promise<void> {
    if (this.lock) return;
    await mkdir(this.directory, { recursive: true });
    await restrictWindowsPathToCurrentUser(this.directory, "directory", this.options.acl);
    const handle = await acquireOwnedFileLock(this.lockFile);
    try {
      await restrictWindowsPathToCurrentUser(this.lockFile, "file", this.options.acl);
      this.lock = handle;
    } catch (error) {
      await handle.release().catch(() => undefined);
      throw error;
    }
  }

  async read(): Promise<Buffer | null> {
    this.requireLock();
    let stat;
    try { stat = await lstat(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DRAFT_JOURNAL_BYTES) throw new Error("Invalid encrypted draft journal.");
    const bytes = await readFile(this.file);
    if (bytes.byteLength > MAX_DRAFT_JOURNAL_BYTES) { bytes.fill(0); throw new Error("Oversized encrypted draft journal."); }
    return bytes;
  }

  async write(data: Buffer): Promise<void> {
    this.requireLock();
    if (data.byteLength > MAX_DRAFT_JOURNAL_BYTES) throw new Error("Oversized encrypted draft journal.");
    await writeFileAtomically(this.file, data, 0o600, this.options.acl);
    const handle = await open(this.file, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async release(): Promise<void> {
    const lock = this.lock;
    if (!lock) return;
    this.lock = undefined;
    await lock.release();
  }

  private requireLock(): void {
    if (!this.lock) throw new Error("The encrypted draft journal is not locked.");
  }
}

interface Envelope {
  version: 1;
  protectedKey: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

function decodeBase64(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maximum / 3) * 4
    || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(value)) throw new Error("Invalid encrypted journal encoding.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maximum || decoded.toString("base64") !== value) throw new Error("Invalid encrypted journal encoding.");
  return decoded;
}

/**
 * Whole snapshots are AES-GCM encrypted; only the random data key enters DPAPI.
 * The DPAPI secret helper's small input limit therefore never truncates mail.
 * No unencrypted message or attachment content is written to temporary files.
 */
export class DraftJournal<TPayload, TPreview, TBinding = unknown> {
  private readonly storage: DraftJournalStorage;
  private readonly protection: DraftJournalProtection;
  private readonly now: () => number;
  private store: DraftStore<TPayload, TPreview, TBinding> | undefined;
  private detach: (() => void) | undefined;
  private key: Buffer | undefined;
  private protectedKey: Buffer | undefined;
  private generation = 0;
  private savedGeneration = -1;
  private writing: Promise<void> | undefined;
  private closed = false;

  constructor(options: DraftJournalOptions = {}) {
    this.storage = options.storage ?? new FileDraftJournalStorage(options);
    this.protection = options.protection ?? { protect: protectSecret, unprotect: unprotectSecret };
    this.now = options.now ?? Date.now;
  }

  async attach(store: DraftStore<TPayload, TPreview, TBinding>, options: DraftJournalAttachOptions<TPayload, TPreview, TBinding>): Promise<{ restored: number; invalidatedAttachments: number }> {
    if (this.store || this.closed || store.size !== 0) throw this.failure();
    let acquired = false;
    try {
      await this.storage.acquire();
      acquired = true;
      const snapshot = await this.load();
      let invalidatedAttachments = 0;
      const records = snapshot.records.map(record => {
        if (record.state !== "prepared" || record.expiresAtMs <= this.now() || !record.content || !options.hasAttachments(record.content.payload)) return record;
        invalidatedAttachments++;
        const { content: _content, ...summary } = record;
        return {
          ...summary,
          state: "not_sent" as const,
          retainUntilMs: this.now() + DEFAULT_DRAFT_RESULT_RETENTION_MS,
          failure: { code: "DRAFT_ATTACHMENTS_INVALID" as const, message: "Selected attachments cannot be restored after restart. Select them again and prepare a new draft." },
        };
      });
      const restored = store.restoreSnapshot({ version: 1, records }, options.validateRecord);
      this.store = store;
      this.detach = store.attachPersistence({ changed: () => this.changed(), beforeSend: () => this.flush() });
      await this.flush();
      return { restored, invalidatedAttachments };
    } catch {
      this.detach?.();
      this.detach = undefined;
      this.store = undefined;
      this.key?.fill(0);
      this.key = undefined;
      this.protectedKey = undefined;
      if (acquired) await this.storage.release().catch(() => undefined);
      throw this.failure();
    }
  }

  /** Reads only while this journal owns its process lock. Attach normally calls this. */
  async load(): Promise<DraftSnapshot<TPayload, TPreview, TBinding>> {
    const bytes = await this.storage.read();
    if (!bytes) return { version: 1, records: [] };
    let plain: Buffer | undefined;
    try {
      if (bytes.byteLength > MAX_DRAFT_JOURNAL_BYTES) throw this.failure();
      const value = JSON.parse(bytes.toString("utf8")) as Envelope;
      if (value?.version !== 1) throw this.failure();
      const protectedKey = decodeBase64(value.protectedKey, 16 * 1024);
      const keyString = await this.protection.unprotect(protectedKey);
      if (!/^[a-f0-9]{64}$/u.test(keyString)) throw this.failure();
      const key = Buffer.from(keyString, "hex");
      let encrypted: Buffer | undefined;
      try {
        const nonce = decodeBase64(value.nonce, 12);
        const tag = decodeBase64(value.tag, 16);
        if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw this.failure();
        encrypted = decodeBase64(value.ciphertext, MAX_PLAINTEXT_BYTES);
        const cipher = createDecipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(JOURNAL_AAD);
        cipher.setAuthTag(tag);
        plain = Buffer.concat([cipher.update(encrypted), cipher.final()]);
        const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as DraftSnapshot<TPayload, TPreview, TBinding>;
        if (snapshot?.version !== 1 || !Array.isArray(snapshot.records)) throw this.failure();
        this.key?.fill(0);
        this.key = Buffer.from(key);
        this.protectedKey = protectedKey;
        return snapshot;
      } finally { key.fill(0); encrypted?.fill(0); }
    } finally { bytes.fill(0); plain?.fill(0); }
  }

  flush(): Promise<void> {
    if (this.closed || !this.store) return Promise.reject(this.failure());
    // Defer the drain so exportSnapshot()->purgeExpired()->changed() cannot
    // start another writer before writing has been assigned.
    this.writing ??= Promise.resolve().then(() => this.writePending()).finally(() => { this.writing = undefined; });
    return this.writing.then(() => this.savedGeneration === this.generation ? undefined : this.flush());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try { if (this.store) await this.flush(); }
    finally {
      this.closed = true;
      this.detach?.();
      this.detach = undefined;
      this.store = undefined;
      this.key?.fill(0);
      this.key = undefined;
      this.protectedKey = undefined;
      await this.storage.release();
    }
  }

  private changed(): void {
    this.generation++;
    // Save promptly, but callers use flush() when persistence is part of their
    // completion contract. DraftStore always awaits it before dispatching SMTP.
    void this.flush().catch(() => undefined);
  }

  private async writePending(): Promise<void> {
    try {
      while (this.savedGeneration !== this.generation) {
        const generation = this.generation;
        const snapshot = this.store!.exportSnapshot();
        const plain = Buffer.from(JSON.stringify(snapshot), "utf8");
        let encoded: Buffer | undefined;
        try {
          if (plain.byteLength > MAX_PLAINTEXT_BYTES) throw this.failure();
          if (!this.key) {
            const key = randomBytes(32);
            try {
              this.protectedKey = await this.protection.protect(key.toString("hex"));
              this.key = Buffer.from(key);
            } finally { key.fill(0); }
          }
          const nonce = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
          cipher.setAAD(JOURNAL_AAD);
          const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
          encoded = Buffer.from(JSON.stringify({ version: 1, protectedKey: this.protectedKey!.toString("base64"), nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") } satisfies Envelope), "utf8");
          encrypted.fill(0);
          await this.storage.write(encoded);
          this.savedGeneration = generation;
        } finally { plain.fill(0); encoded?.fill(0); }
      }
    } catch { throw this.failure(); }
  }

  private failure(): DraftError {
    return new DraftError("DRAFT_PERSISTENCE_FAILED", "The encrypted draft journal is unavailable. Resolve its storage or lock problem before sending.");
  }
}
