import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { getConfigPaths, writeFileAtomically, type ConfigStorageOptions } from "./config.js";

export const MAX_SECRET_BYTES = 16 * 1024;
export const DEFAULT_DPAPI_TIMEOUT_MS = 15_000;
const MAX_DPAPI_OUTPUT_BYTES = 1024 * 1024;
const MAX_DPAPI_TIMEOUT_MS = 60_000;

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd()
$plain = [Convert]::FromBase64String($encoded)
try {
  $cipher = [System.Security.Cryptography.ProtectedData]::Protect(
    $plain,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Convert]::ToBase64String($cipher))
} finally {
  if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
}`;

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd()
$cipher = [Convert]::FromBase64String($encoded)
$plain = $null
try {
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $cipher,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Convert]::ToBase64String($plain))
} finally {
  if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
  if ($null -ne $cipher) { [Array]::Clear($cipher, 0, $cipher.Length) }
}`;

export type DpapiOperation = "protect" | "unprotect";

export interface DpapiProcessRequest {
  readonly operation: DpapiOperation;
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin: Uint8Array;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface DpapiProcessResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr?: Uint8Array;
}

export type DpapiProcessRunner = (request: DpapiProcessRequest) => Promise<DpapiProcessResult>;

export interface DpapiOptions {
  readonly runner?: DpapiProcessRunner;
  readonly platform?: NodeJS.Platform;
  readonly powershellPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface SecretStorageOptions extends ConfigStorageOptions, DpapiOptions {}

export class DpapiError extends Error {
  readonly code: "DPAPI_UNAVAILABLE" | "DPAPI_FAILED" | "SECRET_INVALID" | "SECRET_IO_ERROR";

  constructor(code: DpapiError["code"], message: string) {
    super(message);
    this.name = "DpapiError";
    this.code = code;
  }
}

const defaultRunner: DpapiProcessRunner = async (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.executable, [...request.args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const removeIoListeners = (): void => {
      request.signal.removeEventListener("abort", onAbort);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.stdin.off("error", onStdinError);
    };
    const removeLifecycleListeners = (): void => {
      child.off("error", onError);
      child.off("close", onClose);
    };
    const fail = (killChild = true): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeIoListeners();
      if (killChild) {
        try {
          child.kill();
        } catch {
          // The generic failure below intentionally hides subprocess details.
        }
      }
      reject(new Error("DPAPI subprocess failed."));
    };
    const onAbort = (): void => fail();
    const onStdout = (chunk: Buffer): void => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_DPAPI_OUTPUT_BYTES) {
        fail();
        return;
      }
      stdout.push(chunk);
    };
    const onStderr = (chunk: Buffer): void => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_DPAPI_OUTPUT_BYTES) {
        fail();
        return;
      }
      stderr.push(chunk);
    };
    const onError = (): void => fail(false);
    const onClose = (exitCode: number | null): void => {
      if (settled) {
        removeLifecycleListeners();
        return;
      }
      settled = true;
      removeIoListeners();
      removeLifecycleListeners();
      resolve({
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    };
    const onStdinError = (): void => fail();

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.once("error", onStdinError);
    if (request.signal.aborted) {
      fail();
      return;
    }
    request.signal.addEventListener("abort", onAbort, { once: true });
    child.stdin.end(request.stdin);
  });

function runProcessWithTimeout(
  runner: DpapiProcessRunner,
  request: Omit<DpapiProcessRequest, "signal" | "timeoutMs">,
  timeoutMs: number,
): Promise<DpapiProcessResult> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      controller.abort();
      rejectOnce(new Error("DPAPI subprocess timed out."));
    }, timeoutMs);
    const resolveOnce = (result: DpapiProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    void Promise.resolve()
      .then(() => runner({ ...request, signal: controller.signal, timeoutMs }))
      .then(resolveOnce, rejectOnce);
  });
}

function resolveTimeoutMs(options: DpapiOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DPAPI_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DPAPI_TIMEOUT_MS) {
    throw new DpapiError("DPAPI_FAILED", "Windows could not process the stored QQ Mail authorization code.");
  }
  return timeoutMs;
}

function resolvePowershellPath(options: DpapiOptions): string {
  if (options.powershellPath) {
    return options.powershellPath;
  }
  const environment = options.environment ?? process.env;
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) {
    throw new DpapiError("DPAPI_UNAVAILABLE", "Windows PowerShell could not be located.");
  }
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function powershellArgs(script: string): readonly string[] {
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
}

function decodeBase64Output(output: Uint8Array): Buffer {
  const encoded = Buffer.from(output).toString("ascii").trim();
  if (!encoded || encoded.length > MAX_DPAPI_OUTPUT_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new DpapiError("DPAPI_FAILED", "Windows could not process the stored QQ Mail authorization code.");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    decoded.fill(0);
    throw new DpapiError("DPAPI_FAILED", "Windows could not process the stored QQ Mail authorization code.");
  }
  return decoded;
}

async function invokeDpapi(
  operation: DpapiOperation,
  input: Uint8Array,
  options: DpapiOptions,
): Promise<Buffer> {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new DpapiError("DPAPI_UNAVAILABLE", "QQ Mail credentials can only be unlocked on Windows.");
  }

  const timeoutMs = resolveTimeoutMs(options);
  const stdin = Buffer.from(input).toString("base64");
  const stdinBytes = Buffer.from(stdin, "ascii");
  try {
    const runner = options.runner ?? defaultRunner;
    const result = await runProcessWithTimeout(
      runner,
      {
        operation,
        executable: resolvePowershellPath(options),
        args: powershellArgs(operation === "protect" ? PROTECT_SCRIPT : UNPROTECT_SCRIPT),
        stdin: stdinBytes,
      },
      timeoutMs,
    );
    if (result.exitCode !== 0) {
      throw new DpapiError("DPAPI_FAILED", "Windows could not process the stored QQ Mail authorization code.");
    }
    return decodeBase64Output(result.stdout);
  } catch (error) {
    if (error instanceof DpapiError) {
      throw error;
    }
    throw new DpapiError("DPAPI_FAILED", "Windows could not process the stored QQ Mail authorization code.");
  } finally {
    stdinBytes.fill(0);
  }
}

export async function protectSecret(secret: string, options: DpapiOptions = {}): Promise<Buffer> {
  const plaintext = Buffer.from(secret, "utf8");
  if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_SECRET_BYTES) {
    plaintext.fill(0);
    throw new DpapiError("SECRET_INVALID", "The QQ Mail authorization code has an invalid length.");
  }

  try {
    return await invokeDpapi("protect", plaintext, options);
  } finally {
    plaintext.fill(0);
  }
}

export async function unprotectSecret(ciphertext: Uint8Array, options: DpapiOptions = {}): Promise<string> {
  if (ciphertext.byteLength < 1 || ciphertext.byteLength > MAX_DPAPI_OUTPUT_BYTES) {
    throw new DpapiError("SECRET_INVALID", "The stored QQ Mail authorization code is invalid.");
  }
  const plaintext = await invokeDpapi("unprotect", ciphertext, options);
  try {
    if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_SECRET_BYTES) {
      throw new DpapiError("SECRET_INVALID", "The stored QQ Mail authorization code is invalid.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch (error) {
    if (error instanceof DpapiError) {
      throw error;
    }
    throw new DpapiError("SECRET_INVALID", "The stored QQ Mail authorization code is invalid.");
  } finally {
    plaintext.fill(0);
  }
}

export async function saveSecret(secret: string, options: SecretStorageOptions = {}): Promise<void> {
  const encrypted = await protectSecret(secret, options);
  const { secretPath } = getConfigPaths(options);
  try {
    await writeFileAtomically(secretPath, encrypted, 0o600, options.acl);
  } catch {
    throw new DpapiError("SECRET_IO_ERROR", "The QQ Mail authorization code could not be saved.");
  }
}

export async function loadSecret(options: SecretStorageOptions = {}): Promise<string | null> {
  const { secretPath } = getConfigPaths(options);
  let encrypted: Buffer;
  try {
    encrypted = await readFile(secretPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new DpapiError("SECRET_IO_ERROR", "The QQ Mail authorization code could not be read.");
  }
  return unprotectSecret(encrypted, options);
}

export async function deleteSecret(options: ConfigStorageOptions = {}): Promise<void> {
  const { secretPath } = getConfigPaths(options);
  try {
    await rm(secretPath, { force: true });
  } catch {
    throw new DpapiError("SECRET_IO_ERROR", "The QQ Mail authorization code could not be removed.");
  }
}

export class CredentialStore {
  private readonly options: SecretStorageOptions;

  constructor(options: SecretStorageOptions = {}) {
    this.options = options;
  }

  set(secret: string): Promise<void> {
    return saveSecret(secret, this.options);
  }

  get(): Promise<string | null> {
    return loadSecret(this.options);
  }

  delete(): Promise<void> {
    return deleteSecret(this.options);
  }

  clear(): Promise<void> {
    return this.delete();
  }
}
