import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { DraftJournalProtection, DraftJournalStorage } from "../draft-journal.js";
import { ToolFailure } from "../errors.js";
import { acquireOwnedFileLock, type OwnedFileLock } from "../local-lock.js";

// Keep the same envelope ceiling as DraftJournal without importing its Windows defaults at runtime.
export const MAX_CLOUD_DRAFT_BYTES = 48 * 1024 * 1024;
const WRAP_MAGIC = Buffer.from("QQMDKEY1", "ascii");
const WRAP_AAD = Buffer.from("QQ-Mail cloud draft data key v1", "ascii");
const WRAPPED_KEY_BYTES = WRAP_MAGIC.length + 12 + 16 + 32;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const posixPermissions = process.platform !== "win32";

function storageFailure(code = "CLOUD_DRAFT_STORAGE_UNAVAILABLE"): ToolFailure {
  return new ToolFailure(code, "The private encrypted draft storage or its process lock is unavailable. Check the configured state directory.");
}
function keyFailure(): ToolFailure {
  return new ToolFailure("CLOUD_DRAFT_KEY_INVALID", "The draft key cannot be protected or authenticated with the configured master key.");
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
    : path.normalize(left) === path.normalize(right);
}
function assertOwner(stat: Stats): void {
  if (posixPermissions && typeof process.geteuid === "function" && stat.uid !== process.geteuid()) throw storageFailure();
}
function assertPrivateFile(stat: Stats, maximum: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximum) {
    throw storageFailure("CLOUD_DRAFT_FILE_INVALID");
  }
  assertOwner(stat);
  if (posixPermissions && (stat.mode & 0o7777) !== 0o600) throw storageFailure("CLOUD_DRAFT_PERMISSIONS_INVALID");
}

/**
 * The operator loads a 32-byte master key from its environment or secret mount and injects it here.
 * This class reads no environment variables or secret paths. Only the journal's random data key
 * is wrapped; journal contents remain encrypted by DraftJournal's separate AES-GCM envelope.
 */
export class KeyFileDraftProtection implements DraftJournalProtection {
  #masterKey: Buffer | undefined;

  constructor(masterKey: Buffer) {
    if (!Buffer.isBuffer(masterKey) || masterKey.byteLength !== 32) throw keyFailure();
    this.#masterKey = Buffer.from(masterKey);
  }

  async protect(value: string): Promise<Buffer> {
    if (!this.#masterKey || typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw keyFailure();
    const plain = Buffer.from(value, "hex");
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#masterKey, nonce);
      cipher.setAAD(WRAP_AAD);
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([WRAP_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
    } catch { throw keyFailure(); }
    finally { plain.fill(0); }
  }

  async unprotect(value: Buffer): Promise<string> {
    if (!this.#masterKey || !Buffer.isBuffer(value) || value.byteLength !== WRAPPED_KEY_BYTES ||
        !value.subarray(0, WRAP_MAGIC.length).equals(WRAP_MAGIC)) throw keyFailure();
    let plain: Buffer | undefined;
    let tail: Buffer | undefined;
    try {
      const nonceOffset = WRAP_MAGIC.length;
      const tagOffset = nonceOffset + 12;
      const dataOffset = tagOffset + 16;
      const cipher = createDecipheriv("aes-256-gcm", this.#masterKey, value.subarray(nonceOffset, tagOffset));
      cipher.setAAD(WRAP_AAD);
      cipher.setAuthTag(value.subarray(tagOffset, dataOffset));
      plain = cipher.update(value.subarray(dataOffset));
      tail = cipher.final();
      if (plain.byteLength !== 32 || tail.byteLength !== 0) throw keyFailure();
      return plain.toString("hex");
    } catch { throw keyFailure(); }
    finally { plain?.fill(0); tail?.fill(0); }
  }

  dispose(): void { this.#masterKey?.fill(0); this.#masterKey = undefined; }
}

/**
 * Fixed-file, process-lifetime storage for one operator-controlled absolute state directory.
 * Linux production requires a private local filesystem with reliable exclusive-create/rename/fsync.
 * Windows is supported for isolated testing; POSIX modes and directory fsync are Linux guarantees.
 * File handles, no-follow opens and identity checks reject accidental redirects and named symlinks.
 * This is not a sandbox against malicious code running as the same OS user (including path races).
 * Unknown locks are never removed; stop all servers and inspect them before manual recovery.
 */
export class PortableDraftStorage implements DraftJournalStorage {
  readonly #directory: string;
  readonly #file: string;
  readonly #lockFile: string;
  #lock: OwnedFileLock | undefined;
  #lockContents: Buffer | undefined;
  #directoryIdentity: Stats | undefined;
  #canonicalDirectory: string | undefined;
  #directoryHandle: FileHandle | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(stateDirectory: string) {
    if (typeof stateDirectory !== "string" || !path.isAbsolute(stateDirectory) || /[\u0000-\u001f\u007f]/u.test(stateDirectory)) {
      throw storageFailure("CLOUD_DRAFT_DIRECTORY_INVALID");
    }
    this.#directory = path.resolve(stateDirectory);
    if (samePath(this.#directory, path.parse(this.#directory).root)) throw storageFailure("CLOUD_DRAFT_DIRECTORY_INVALID");
    this.#file = path.join(this.#directory, "drafts.enc.json");
    this.#lockFile = path.join(this.#directory, "drafts.lock");
  }

  acquire(): Promise<void> {
    return this.#run(async () => {
      if (this.#lock) { await this.#assertReady(); return; }
      try {
        await this.#prepareDirectory();
        for (const file of [this.#lockFile, this.#lockFile + ".recovery"]) await this.#inspectFile(file, 2_048);
        this.#lock = await acquireOwnedFileLock(this.#lockFile);
        this.#lockContents = await this.#readBounded(this.#lockFile, 2_048, false) ?? undefined;
        if (!this.#lockContents) throw storageFailure();
        await this.#assertReady();
      } catch (error) {
        await this.#releaseResources().catch(() => undefined);
        if (error instanceof ToolFailure) throw error;
        throw storageFailure("CLOUD_DRAFT_LOCK_UNAVAILABLE");
      }
    });
  }

  read(): Promise<Buffer | null> {
    return this.#run(async () => {
      let bytes: Buffer | null = null;
      try {
        await this.#assertReady();
        bytes = await this.#readBounded(this.#file, MAX_CLOUD_DRAFT_BYTES, true);
        await this.#assertReady();
        return bytes;
      } catch (error) {
        bytes?.fill(0);
        if (error instanceof ToolFailure) throw error;
        throw storageFailure();
      }
    });
  }

  write(data: Buffer): Promise<void> {
    if (!Buffer.isBuffer(data) || data.byteLength > MAX_CLOUD_DRAFT_BYTES) {
      return Promise.reject(storageFailure("CLOUD_DRAFT_TOO_LARGE"));
    }
    return this.#run(async () => {
      await this.#assertReady();
      if (data.byteLength > MAX_CLOUD_DRAFT_BYTES) throw storageFailure("CLOUD_DRAFT_TOO_LARGE");
      const snapshot = Buffer.from(data);
      let temporary: string | undefined;
      let handle: FileHandle | undefined;
      try {
        await this.#inspectFile(this.#file, MAX_CLOUD_DRAFT_BYTES);
        const candidate = path.join(this.#directory, ".drafts.enc." + randomBytes(16).toString("hex") + ".tmp");
        handle = await open(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
        temporary = candidate;
        if (posixPermissions) await handle.chmod(0o600);
        assertPrivateFile(await handle.stat(), MAX_CLOUD_DRAFT_BYTES);
        await handle.writeFile(snapshot);
        await handle.sync();
        assertPrivateFile(await handle.stat(), MAX_CLOUD_DRAFT_BYTES);
        await handle.close();
        handle = undefined;
        await this.#assertReady();
        await this.#inspectFile(this.#file, MAX_CLOUD_DRAFT_BYTES);
        await rename(temporary, this.#file);
        temporary = undefined;
        // A post-rename fsync error reports failure; the file is still an entire old/new envelope,
        // never a partial write. Do not retry sending if journal durability could not be confirmed.
        if (this.#directoryHandle) await this.#directoryHandle.sync();
        await this.#assertReady();
      } catch (error) {
        if (error instanceof ToolFailure) throw error;
        throw storageFailure();
      } finally {
        snapshot.fill(0);
        await handle?.close().catch(() => undefined);
        if (temporary) {
          // Only the random temporary name created by this write may be removed.
          await this.#verifyDirectory();
          await unlink(temporary).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw storageFailure("CLOUD_DRAFT_TEMP_CLEANUP_FAILED");
          });
        }
      }
    });
  }

  release(): Promise<void> { return this.#run(() => this.#releaseResources()); }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation).catch(error => {
      if (error instanceof ToolFailure) throw error;
      throw storageFailure();
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #prepareDirectory(): Promise<void> {
    // Check existing ancestors before mkdir, then recheck every component. Never chmod ancestors.
    await this.#verifyComponents(true);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.#verifyComponents(false);
    const named = await lstat(this.#directory);
    if (!named.isDirectory() || named.isSymbolicLink()) throw storageFailure("CLOUD_DRAFT_DIRECTORY_INVALID");
    assertOwner(named);
    if (posixPermissions) {
      this.#directoryHandle = await open(this.#directory, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
      const opened = await this.#directoryHandle.stat();
      if (!opened.isDirectory() || !sameFile(named, opened)) throw storageFailure("CLOUD_DRAFT_DIRECTORY_INVALID");
      // Only the exact configured state directory is changed; mounts are supported.
      await this.#directoryHandle.chmod(0o700);
    }
    this.#directoryIdentity = await lstat(this.#directory);
    this.#canonicalDirectory = await realpath(this.#directory);
    await this.#verifyDirectory();
  }

  async #verifyComponents(allowMissing: boolean): Promise<void> {
    const root = path.parse(this.#directory).root;
    // Resolve the root independently to support a trusted Windows SUBST test drive.
    const canonicalRoot = await realpath(root);
    let component = root;
    for (const part of path.relative(root, this.#directory).split(path.sep)) {
      component = path.join(component, part);
      let stat: Stats;
      try { stat = await lstat(component); }
      catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw storageFailure("CLOUD_DRAFT_DIRECTORY_INVALID");
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageFailure("CLOUD_DRAFT_DIRECTORY_INVALID");
      // Check each existing ancestor before an absent child permits mkdir. Some Windows
      // reparse points expose directory attributes without an isSymbolicLink marker;
      // checking only the final (possibly missing) path would traverse their target first.
      const expected = path.join(canonicalRoot, path.relative(root, component));
      if (!samePath(await realpath(component), expected)) throw storageFailure("CLOUD_DRAFT_DIRECTORY_INVALID");
    }
  }

  async #verifyDirectory(): Promise<void> {
    if (!this.#directoryIdentity || !this.#canonicalDirectory) throw storageFailure();
    await this.#verifyComponents(false);
    const named = await lstat(this.#directory);
    if (!named.isDirectory() || named.isSymbolicLink() || !sameFile(named, this.#directoryIdentity) ||
        !samePath(await realpath(this.#directory), this.#canonicalDirectory)) throw storageFailure("CLOUD_DRAFT_DIRECTORY_INVALID");
    assertOwner(named);
    if (posixPermissions && (named.mode & 0o7777) !== 0o700) throw storageFailure("CLOUD_DRAFT_PERMISSIONS_INVALID");
    if (this.#directoryHandle && !sameFile(named, await this.#directoryHandle.stat())) throw storageFailure("CLOUD_DRAFT_DIRECTORY_INVALID");
  }

  async #assertReady(): Promise<void> {
    if (!this.#lock || !this.#lockContents) throw storageFailure("CLOUD_DRAFT_NOT_LOCKED");
    await this.#verifyDirectory();
    const current = await this.#readBounded(this.#lockFile, 2_048, false);
    try { if (!current?.equals(this.#lockContents)) throw storageFailure("CLOUD_DRAFT_LOCK_CHANGED"); }
    finally { current?.fill(0); }
  }

  async #inspectFile(file: string, maximum: number): Promise<Stats | null> {
    let stat: Stats;
    try { stat = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    assertPrivateFile(stat, maximum);
    return stat;
  }

  async #readBounded(file: string, maximum: number, missingAllowed: boolean): Promise<Buffer | null> {
    const named = await this.#inspectFile(file, maximum);
    if (!named) {
      if (missingAllowed) return null;
      throw storageFailure("CLOUD_DRAFT_LOCK_CHANGED");
    }
    let handle: FileHandle | undefined;
    let bytes: Buffer | undefined;
    try {
      handle = await open(file, constants.O_RDONLY | NOFOLLOW);
      const opened = await handle.stat();
      assertPrivateFile(opened, maximum);
      if (!sameFile(named, opened)) throw storageFailure("CLOUD_DRAFT_FILE_INVALID");
      bytes = Buffer.alloc(opened.size + 1);
      let count = 0;
      while (count < bytes.byteLength) {
        const read = await handle.read(bytes, count, bytes.byteLength - count, count);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
      }
      const after = await handle.stat();
      const current = await this.#inspectFile(file, maximum);
      if (!current || !sameFile(opened, current) || !sameFile(opened, after) || count !== opened.size ||
          after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
        throw storageFailure("CLOUD_DRAFT_FILE_INVALID");
      }
      const result = bytes.subarray(0, count);
      bytes = undefined;
      return result;
    } finally { bytes?.fill(0); await handle?.close(); }
  }

  async #releaseResources(): Promise<void> {
    const lock = this.#lock;
    this.#lock = undefined;
    this.#lockContents?.fill(0);
    this.#lockContents = undefined;
    try {
      if (lock) {
        await this.#verifyDirectory();
        await lock.release();
        if (this.#directoryHandle) await this.#directoryHandle.sync();
      }
    } catch { throw storageFailure("CLOUD_DRAFT_LOCK_CHANGED"); }
    finally {
      await this.#directoryHandle?.close();
      this.#directoryHandle = undefined;
      this.#directoryIdentity = undefined;
      this.#canonicalDirectory = undefined;
    }
  }
}
