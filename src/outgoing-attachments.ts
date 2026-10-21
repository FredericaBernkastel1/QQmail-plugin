import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isLocalAbsoluteWindowsPath } from "./config.js";
import { isLocalWindowsDrive } from "./windows-drive.js";
import { sanitizeWindowsFilename } from "./security.js";
import { readWindowsFile, WindowsPathError } from "./windows-path-lease.js";
import { ToolFailure } from "./errors.js";
import {
  ATTACHMENT_ID_PATTERN, ATTACHMENT_TTL_MS, MAX_ATTACHMENT_STORE_BYTES,
  MAX_ATTACHMENT_STORE_ITEMS, MAX_OUTGOING_ATTACHMENTS, MAX_OUTGOING_FILE_BYTES,
  MAX_OUTGOING_TOTAL_BYTES,
} from "./attachment-limits.js";

export interface OutgoingAttachmentMetadata {
  attachmentId: string;
  filename: string;
  contentType: string;
  bytes: number;
  sha256: string;
  expiresAt: string;
}
export interface OutgoingAttachmentContent extends OutgoingAttachmentMetadata {
  /** A send-local copy, never stored in a draft or returned through MCP. */
  content: Buffer;
}
interface Entry {
  scope: string;
  expires: number;
  metadata: OutgoingAttachmentMetadata;
  content: Buffer;
}

export interface OutgoingAttachmentRepository {
  importSelected(paths: readonly string[], scope: string): Promise<OutgoingAttachmentMetadata[]>;
  metadata(ids: readonly string[], scope: string): OutgoingAttachmentMetadata[];
  list(scope: string): OutgoingAttachmentMetadata[];
  acquire(ids: readonly string[], scope: string): OutgoingAttachmentContent[] | Promise<OutgoingAttachmentContent[]>;
  release(entries: readonly OutgoingAttachmentContent[]): void | Promise<void>;
  remove(ids: readonly string[]): void;
  dispose(): void;
}

function failure(code: string, message: string): ToolFailure { return new ToolFailure(code, message); }

/** Only called with paths returned by the trusted file picker. */
export async function readSelectedLocalFile(selected: string, maximum: number): Promise<Buffer> {
  if (!isLocalAbsoluteWindowsPath(selected) || /[\0\r\n]/u.test(selected) ||
      selected.slice(2).includes(":") || /[ .](?:[\\/]|$)/u.test(selected)) {
    throw failure("UNSAFE_ATTACHMENT_PATH", "Select a regular file on a local drive.");
  }
  const absolute = path.win32.normalize(selected);
  const drive = path.win32.parse(absolute).root.replace(/\//gu, "\\");
  if (!await isLocalWindowsDrive(drive)) {
    throw failure("UNSAFE_ATTACHMENT_PATH", "Network and unverified drives cannot be used for outgoing attachments.");
  }
  let component = drive;
  for (const part of absolute.slice(drive.length).split(/[\\/]/u)) {
    component = path.win32.join(component, part);
    if ((await lstat(component)).isSymbolicLink()) {
      throw failure("UNSAFE_ATTACHMENT_PATH", "Attachment paths cannot pass through links or junctions.");
    }
  }
  const canonical = await realpath(absolute);
  // A local SUBST drive can resolve to a different drive prefix. Still reject
  // redirection below that root, after checking each selected-path component.
  const canonicalDrive = await realpath(drive);
  const expected = path.win32.join(canonicalDrive, path.win32.relative(drive, absolute));
  if (!isLocalAbsoluteWindowsPath(canonical) || path.win32.normalize(canonical).toLowerCase() !== expected.toLowerCase()) {
    throw failure("UNSAFE_ATTACHMENT_PATH", "The selected attachment path changed or was redirected.");
  }
  try {
    const named = await lstat(absolute);
    if (!named.isFile() || named.isSymbolicLink() ||
        !Number.isSafeInteger(named.size) || named.size < 0 || named.size > maximum) {
      throw failure("ATTACHMENT_TOO_LARGE_OR_UNSAFE", "The selected file is not a regular file within the size limit.");
    }
    // Native I/O holds ancestors and validates the actual opened file handle.
    // The helper also denies writers, caps bytes and verifies final file metadata.
    return await readWindowsFile(absolute, canonical, maximum);
  } catch (error) {
    if (error instanceof WindowsPathError) {
      if (error.code === "LIMIT_EXCEEDED") throw failure("ATTACHMENT_TOO_LARGE_OR_UNSAFE", "The selected file exceeds the size limit.");
      if (error.code === "FILE_CHANGED") throw failure("ATTACHMENT_CHANGED", "The file changed while being imported. Select it again.");
      throw failure("UNSAFE_ATTACHMENT_PATH", "The selected path changed, was redirected, or could not be locked safely.");
    }
    throw error;
  }
}

/** Bounded volatile snapshots: no disk cache and no restart recovery of files. */
export class OutgoingAttachmentStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #read: (selected: string, maximum: number) => Promise<Buffer>;
  readonly #timer: ReturnType<typeof setInterval>;
  #importing = false;
  #disposed = false;
  constructor(options: {
    now?: () => number;
    read?: (selected: string, maximum: number) => Promise<Buffer>;
  } = {}) {
    this.#now = options.now ?? Date.now;
    this.#read = options.read ?? readSelectedLocalFile;
    this.#timer = setInterval(() => this.purgeExpired(), 60_000);
    this.#timer.unref();
  }

  async importSelected(paths: readonly string[], scope: string): Promise<OutgoingAttachmentMetadata[]> {
    if (this.#disposed || this.#importing) throw failure("ATTACHMENTS_BUSY", "Attachment import is unavailable or busy.");
    if (!/^[a-f0-9]{64}$/u.test(scope) || paths.length < 1 || paths.length > MAX_OUTGOING_ATTACHMENTS ||
        new Set(paths.map(p => p.toLowerCase())).size !== paths.length) {
      throw failure("INVALID_ATTACHMENTS", "Select between 1 and 10 distinct files.");
    }
    this.#importing = true;
    const pending: Entry[] = [];
    let committed = false;
    try {
      this.purgeExpired();
      if (this.#entries.size + paths.length > MAX_ATTACHMENT_STORE_ITEMS) {
        throw failure("ATTACHMENT_STORE_FULL", "Too many attachments are pending. Wait for expiry or restart the plugin.");
      }
      let batchBytes = 0;
      const existingBytes = [...this.#entries.values()].reduce((total, entry) => total + entry.content.length, 0);
      for (const selected of paths) {
        const content = await this.#read(selected, MAX_OUTGOING_FILE_BYTES);
        const expires = this.#now() + ATTACHMENT_TTL_MS;
        const metadata = {
          attachmentId: `att_${randomUUID()}`,
          filename: sanitizeWindowsFilename(path.win32.basename(selected), { maxLength: 220 }),
          contentType: "application/octet-stream",
          bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"),
          expiresAt: new Date(expires).toISOString(),
        };
        pending.push({ content, scope, expires, metadata });
        batchBytes += content.length;
        if (this.#disposed || content.length > MAX_OUTGOING_FILE_BYTES || batchBytes > MAX_OUTGOING_TOTAL_BYTES ||
            existingBytes + batchBytes > MAX_ATTACHMENT_STORE_BYTES) {
          throw failure("ATTACHMENT_LIMIT", "Attachment size or pending-memory limits were exceeded.");
        }
      }
      for (const entry of pending) this.#entries.set(entry.metadata.attachmentId, entry);
      committed = true;
      return pending.map(entry => ({ ...entry.metadata }));
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      throw failure("ATTACHMENT_IMPORT_FAILED", "Selected files could not be imported. No attachments from this selection were retained.");
    } finally {
      if (!committed) pending.forEach(entry => entry.content.fill(0));
      this.#importing = false;
    }
  }

  metadata(ids: readonly string[], scope: string): OutgoingAttachmentMetadata[] {
    return this.#resolve(ids, scope).map(entry => ({ ...entry.metadata }));
  }

  acquire(ids: readonly string[], scope: string): OutgoingAttachmentContent[] {
    return this.#resolve(ids, scope).map(entry => ({ ...entry.metadata, content: Buffer.from(entry.content) }));
  }

  list(scope: string): OutgoingAttachmentMetadata[] {
    this.purgeExpired();
    return [...this.#entries.values()].filter(entry => entry.scope === scope).map(entry => ({ ...entry.metadata }));
  }

  release(entries: readonly OutgoingAttachmentContent[]): void { entries.forEach(entry => entry.content.fill(0)); }

  #resolve(ids: readonly string[], scope: string): Entry[] {
    this.purgeExpired();
    if (this.#disposed || !Array.isArray(ids) || ids.length > MAX_OUTGOING_ATTACHMENTS ||
        new Set(ids).size !== ids.length || ids.some(id => !ATTACHMENT_ID_PATTERN.test(id))) {
      throw failure("INVALID_ATTACHMENTS", "Use distinct attachment IDs returned by select_attachments.");
    }
    const entries = ids.map(id => {
      const entry = this.#entries.get(id);
      if (!entry || entry.scope !== scope) {
        throw failure("STALE_ATTACHMENT", "An attachment expired or belongs to a different account version. Select it again.");
      }
      return entry;
    });
    if (entries.reduce((total, entry) => total + entry.content.length, 0) > MAX_OUTGOING_TOTAL_BYTES) {
      throw failure("ATTACHMENT_LIMIT", "The combined attachments exceed the per-message limit.");
    }
    return entries;
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) {
      this.#entries.get(id)?.content.fill(0);
      this.#entries.delete(id);
    }
  }
  purgeExpired(): void {
    this.remove([...this.#entries].filter(([, entry]) => entry.expires <= this.#now()).map(([id]) => id));
  }
  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#timer);
    this.remove([...this.#entries.keys()]);
  }
}
