import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { MAX_DOWNLOAD_BYTES, isLocalAbsoluteWindowsPath } from "./config.js";
import { isLocalWindowsDrive } from "./windows-drive.js";
import { ensureWindowsDirectory, openWindowsWriteFile } from "./windows-path-lease.js";

export type SecurityErrorCode =
  | "HEADER_INJECTION"
  | "INVALID_HEADER_NAME"
  | "INVALID_DOWNLOAD_SIZE"
  | "UNSAFE_DOWNLOAD_PATH";

export class SecurityError extends Error {
  readonly code: SecurityErrorCode;

  constructor(code: SecurityErrorCode, message: string) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
  }
}

export function assertNoHeaderInjection(value: string, fieldName = "header"): string {
  if (typeof value !== "string" || /[\0\r\n]/u.test(value)) {
    throw new SecurityError("HEADER_INJECTION", `${fieldName} contains a prohibited line break.`);
  }
  return value;
}

export const assertSafeHeaderValue = assertNoHeaderInjection;

export function assertSafeHeaderName(name: string): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
    throw new SecurityError("INVALID_HEADER_NAME", "The email header name is invalid.");
  }
  return name;
}

export function assertSafeAddress(address: string): string {
  return assertNoHeaderInjection(address, "Email address");
}

export function assertSafeAddressList(addresses: readonly string[]): readonly string[] {
  return addresses.map((address) => assertSafeAddress(address));
}

const blockElementPattern =
  /<(script|style|template|noscript|iframe|object|embed|svg|math|head)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const lineBreakTagPattern = /<\/?(?:address|article|aside|blockquote|br|div|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)\b[^>]*>/giu;

const namedEntities: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
});

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#([0-9]{1,7})|#x([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/gu, (match, decimal, hex, named) => {
    if (typeof named === "string") {
      return namedEntities[named.toLowerCase()] ?? match;
    }

    const codePoint = Number.parseInt((decimal ?? hex) as string, decimal === undefined ? 16 : 10);
    if (
      !Number.isInteger(codePoint) ||
      codePoint < 1 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return "\uFFFD";
    }
    return String.fromCodePoint(codePoint);
  });
}

export function htmlToSafeText(html: string): string {
  if (!html) {
    return "";
  }

  let text = html.replace(/<!--(?:[\s\S]*?)-->/gu, " ");
  for (let pass = 0; pass < 4; pass += 1) {
    const stripped = text.replace(blockElementPattern, " ");
    if (stripped === text) {
      break;
    }
    text = stripped;
  }
  text = text.replace(lineBreakTagPattern, "\n");
  text = text.replace(/<[^>]*>/gu, " ");
  text = decodeHtmlEntities(text);
  text = text.replace(/\r\n?/gu, "\n").replace(/[\t\f\v ]+/gu, " ");
  text = text.replace(/ *\n */gu, "\n").replace(/\n{3,}/gu, "\n\n");
  return text.trim();
}

export interface FilenameOptions {
  readonly fallback?: string;
  readonly maxLength?: number;
}

const reservedWindowsName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

// A mailbox filename must not become a discoverable agent instruction, startup
// program or host configuration. Preserve bytes, but neutralize its local name.
// This is download hygiene, not a malware classifier or a host tool sandbox.
const passiveAttachmentExtension = new Set([
  ".txt", ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
  ".csv", ".tsv", ".docx", ".xlsx", ".pptx", ".eml",
  ".zip", ".7z", ".tar", ".gz", ".mp3", ".wav", ".mp4", ".webm",
]);

export function attachmentStorageFilename(input: string): string {
  const safe = sanitizeWindowsFilename(input, { maxLength: 220 });
  return passiveAttachmentExtension.has(path.win32.extname(safe).toLowerCase())
    ? safe
    : `${safe}.download`;
}

export function assertMailDownloadDirectory(directory: string): void {
  const normalized = path.win32.resolve(directory).replace(/\//gu, "\\").toLowerCase();
  const components = normalized.split("\\").map(part => part.replace(/[ .]+$/gu, ""));
  const forbidden = new Set([
    ".codex", ".agents", ".git", ".ssh", ".aws", ".azure", ".kube",
    "windows", "program files", "program files (x86)", "programdata", "startup",
  ]);
  if (components.some(part => forbidden.has(part)) ||
      components.some((part, index) => part === "codex" && components[index + 1] === "plugins")) {
    throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "Host configuration and system directories cannot receive mail attachments.");
  }
}

function truncateFilename(filename: string, maxLength: number): string {
  const characters = Array.from(filename);
  if (characters.length <= maxLength) {
    return filename;
  }

  const lastDot = filename.lastIndexOf(".");
  const extension = lastDot > 0 && filename.length - lastDot <= 20 ? filename.slice(lastDot) : "";
  const extensionCharacters = Array.from(extension);
  const stemLength = Math.max(1, maxLength - extensionCharacters.length);
  return `${characters.slice(0, stemLength).join("")}${extensionCharacters.slice(0, maxLength - stemLength).join("")}`;
}

export function sanitizeWindowsFilename(input: string, options: FilenameOptions = {}): string {
  const maxLength = options.maxLength ?? 240;
  if (!Number.isSafeInteger(maxLength) || maxLength < 16 || maxLength > 255) {
    throw new RangeError("Filename length must be between 16 and 255 characters.");
  }

  const fallbackSource = options.fallback ?? "attachment";
  const normalized = String(input ?? "")
    .normalize("NFKC")
    .replace(/[\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/\\/gu, "/");
  const components = normalized.split("/");
  let filename = components.at(-1) ?? "";
  filename = filename.replace(/[\x00-\x1F\x7F<>:"/\\|?*]/gu, "_").trim();
  filename = filename.replace(/[ .]+$/gu, "");

  if (!filename || filename === "." || filename === "..") {
    filename = fallbackSource.replace(/[\x00-\x1F\x7F<>:"/\\|?*]/gu, "_").trim().replace(/[ .]+$/gu, "");
  }
  if (!filename || filename === "." || filename === "..") {
    filename = "attachment";
  }
  if (reservedWindowsName.test(filename)) {
    filename = `_${filename}`;
  }

  filename = truncateFilename(filename, maxLength).replace(/[ .]+$/gu, "");
  return filename || "attachment";
}

function withCollisionSuffix(filename: string, index: number, maxLength: number): string {
  if (index === 0) {
    return truncateFilename(filename, maxLength);
  }
  const suffix = ` (${index})`;
  const lastDot = filename.lastIndexOf(".");
  const hasExtension = lastDot > 0 && filename.length - lastDot <= 20;
  const stem = hasExtension ? filename.slice(0, lastDot) : filename;
  const extension = hasExtension ? filename.slice(lastDot) : "";
  const allowedStemLength = Math.max(1, maxLength - Array.from(suffix).length - Array.from(extension).length);
  return `${Array.from(stem).slice(0, allowedStemLength).join("")}${suffix}${extension}`;
}

export interface DownloadFileStat {
  isSymbolicLink(): boolean;
}

export interface DownloadFileHandle {
  write(data: Uint8Array): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
  /** Native writers delete the same uncommitted handle while its ancestor lease is held. */
  abort?(): Promise<void>;
}

export interface DownloadFileSystem {
  isLocalDrive(root: string): Promise<boolean>;
  mkdir(directory: string): Promise<void>;
  lstat(targetPath: string): Promise<DownloadFileStat>;
  realpath(targetPath: string): Promise<string>;
  openExclusive(targetPath: string): Promise<DownloadFileHandle>;
  unlink(targetPath: string): Promise<void>;
}

const nodeDownloadFileSystem: DownloadFileSystem = {
  isLocalDrive: isLocalWindowsDrive,
  async mkdir(directory) {
    try { await ensureWindowsDirectory(directory); }
    catch { throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "The download directory could not be safely created or locked."); }
  },
  lstat,
  realpath,
  async openExclusive(targetPath) {
    return openWindowsWriteFile(targetPath);
  },
  unlink,
};

export interface DownloadPathOptions {
  readonly expectedBytes?: number;
  readonly maxBytes?: number;
  readonly maxCollisions?: number;
  readonly fileSystem?: DownloadFileSystem;
}

export function assertDownloadSize(size: number, maxBytes = MAX_DOWNLOAD_BYTES): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DOWNLOAD_BYTES) {
    throw new SecurityError("INVALID_DOWNLOAD_SIZE", "The configured attachment size limit is invalid.");
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw new SecurityError("INVALID_DOWNLOAD_SIZE", "The attachment exceeds the configured download size limit.");
  }
  return size;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isCollision(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function prepareDownloadRoot(downloadRoot: string, fileSystem: DownloadFileSystem): Promise<string> {
  const normalizedRoot = downloadRoot.trim();
  if (!isLocalAbsoluteWindowsPath(normalizedRoot)) {
    throw new SecurityError(
      "UNSAFE_DOWNLOAD_PATH",
      "The attachment download directory must be an absolute path on a local drive.",
    );
  }
  assertMailDownloadDirectory(normalizedRoot);
  const drive = path.win32.parse(normalizedRoot).root.replace(/\//gu, "\\");
  if (!await fileSystem.isLocalDrive(drive)) {
    throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "Network or unverified download drives are not allowed.");
  }
  // Check each existing component before mkdir. A junction in an ancestor can
  // otherwise redirect an apparently local destination to an SMB share.
  let current = drive;
  for (const component of path.win32.relative(drive, path.win32.resolve(normalizedRoot)).split("\\")) {
    if (!component) continue;
    current = path.win32.join(current, component);
    try {
      if ((await fileSystem.lstat(current)).isSymbolicLink()) {
        throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "Redirected download directories are not allowed.");
      }
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
  await fileSystem.mkdir(normalizedRoot);
  const requestedRootStat = await fileSystem.lstat(normalizedRoot);
  if (requestedRootStat.isSymbolicLink()) {
    throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "Symbolic-link download directories are not allowed.");
  }
  const canonicalRoot = await fileSystem.realpath(normalizedRoot);
  if (!isLocalAbsoluteWindowsPath(canonicalRoot)) {
    throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "The resolved download directory is not local.");
  }
  assertMailDownloadDirectory(canonicalRoot);
  const canonicalRootStat = await fileSystem.lstat(canonicalRoot);
  if (canonicalRootStat.isSymbolicLink()) {
    throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "Symbolic-link download directories are not allowed.");
  }
  return canonicalRoot;
}

function candidateInsideRoot(canonicalRoot: string, filename: string): string {
  const candidate = path.resolve(canonicalRoot, filename);
  const relative = path.relative(canonicalRoot, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "The attachment path escapes the configured download directory.");
  }
  return candidate;
}

function validateDownloadOptions(options: DownloadPathOptions): {
  maxBytes: number;
  maxCollisions: number;
  fileSystem: DownloadFileSystem;
} {
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  assertDownloadSize(0, maxBytes);
  if (options.expectedBytes !== undefined) {
    assertDownloadSize(options.expectedBytes, maxBytes);
  }
  const maxCollisions = options.maxCollisions ?? 10_000;
  if (!Number.isSafeInteger(maxCollisions) || maxCollisions < 1 || maxCollisions > 100_000) {
    throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "The attachment collision limit is invalid.");
  }
  return { maxBytes, maxCollisions, fileSystem: options.fileSystem ?? nodeDownloadFileSystem };
}

export async function resolveSafeDownloadPath(
  downloadRoot: string,
  untrustedFilename: string,
  options: DownloadPathOptions = {},
): Promise<string> {
  const { maxCollisions, fileSystem } = validateDownloadOptions(options);
  const canonicalRoot = await prepareDownloadRoot(downloadRoot, fileSystem);
  const sanitized = attachmentStorageFilename(untrustedFilename);

  for (let index = 0; index < maxCollisions; index += 1) {
    const candidate = candidateInsideRoot(canonicalRoot, withCollisionSuffix(sanitized, index, 240));
    try {
      const stat = await fileSystem.lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "A symbolic link blocks the attachment destination.");
      }
    } catch (error) {
      if (isMissing(error)) {
        return candidate;
      }
      throw error;
    }
  }
  throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "A unique attachment filename could not be allocated.");
}

export interface OpenSafeDownloadResult {
  readonly path: string;
  readonly handle: DownloadFileHandle;
  readonly maxBytes: number;
}

export async function openSafeDownloadFile(
  downloadRoot: string,
  untrustedFilename: string,
  options: DownloadPathOptions = {},
): Promise<OpenSafeDownloadResult> {
  const { maxBytes, maxCollisions, fileSystem } = validateDownloadOptions(options);
  const canonicalRoot = await prepareDownloadRoot(downloadRoot, fileSystem);
  const sanitized = attachmentStorageFilename(untrustedFilename);

  for (let index = 0; index < maxCollisions; index += 1) {
    const candidate = candidateInsideRoot(canonicalRoot, withCollisionSuffix(sanitized, index, 240));
    try {
      const existing = await fileSystem.lstat(candidate);
      if (existing.isSymbolicLink()) {
        throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "A symbolic link blocks the attachment destination.");
      }
      continue;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    try {
      // Keep the original configured path in the native check. A realpath result
      // alone must not authorize a raced junction redirect to a different tree.
      const handle = fileSystem === nodeDownloadFileSystem
        ? await openWindowsWriteFile(path.win32.join(downloadRoot, path.win32.basename(candidate)), maxBytes, candidate)
        : await fileSystem.openExclusive(candidate);
      return { path: candidate, handle, maxBytes };
    } catch (error) {
      if (!isCollision(error)) {
        if (fileSystem === nodeDownloadFileSystem) {
          throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "The attachment destination changed or could not be locked safely.");
        }
        throw error;
      }
    }
  }
  throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "A unique attachment filename could not be allocated.");
}

export interface SafeDownloadResult {
  readonly path: string;
  readonly bytesWritten: number;
}

export async function writeSafeDownload(
  downloadRoot: string,
  untrustedFilename: string,
  chunks: AsyncIterable<Uint8Array>,
  options: DownloadPathOptions = {},
): Promise<SafeDownloadResult> {
  const fileSystem = options.fileSystem ?? nodeDownloadFileSystem;
  const opened = await openSafeDownloadFile(downloadRoot, untrustedFilename, options);
  let bytesWritten = 0;
  let completed = false;

  try {
    for await (const chunk of chunks) {
      assertDownloadSize(bytesWritten + chunk.byteLength, opened.maxBytes);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await opened.handle.write(chunk.subarray(offset));
        if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1) {
          throw new SecurityError("UNSAFE_DOWNLOAD_PATH", "The attachment file could not be written safely.");
        }
        offset += result.bytesWritten;
      }
      bytesWritten += chunk.byteLength;
    }
    completed = true;
    return { path: opened.path, bytesWritten };
  } finally {
    if (!completed && opened.handle.abort) {
      await opened.handle.abort().catch(() => undefined);
    } else {
      await opened.handle.close();
      if (!completed) await fileSystem.unlink(opened.path).catch(() => undefined);
    }
  }
}
