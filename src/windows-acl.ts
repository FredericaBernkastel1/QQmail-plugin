import { spawn } from "node:child_process";
import path from "node:path";

export const DEFAULT_WINDOWS_ACL_TIMEOUT_MS = 15_000;
const MAX_WINDOWS_ACL_OUTPUT_BYTES = 64 * 1024;
const MAX_WINDOWS_ACL_TIMEOUT_MS = 60_000;

const RESTRICT_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$kind = [Console]::In.ReadLine()
$encodedPath = [Console]::In.ReadToEnd()
$targetPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPath))
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
$principals = @($currentUser)
# An AppContainer has a second access check. Preserve only this container's
# identity, never ALL APPLICATION PACKAGES or inherited broad permissions.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class QQmailTokenInfo {
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size, out int required);
  public static string ContainerSid(IntPtr token) {
    int size;
    GetTokenInformation(token, 31, IntPtr.Zero, 0, out size);
    if (size < IntPtr.Size) throw new System.ComponentModel.Win32Exception();
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      if (!GetTokenInformation(token, 31, buffer, size, out size)) throw new System.ComponentModel.Win32Exception();
      IntPtr sid = Marshal.ReadIntPtr(buffer);
      return sid == IntPtr.Zero ? null : new SecurityIdentifier(sid).Value;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
'@
$containerSid = [QQmailTokenInfo]::ContainerSid([Security.Principal.WindowsIdentity]::GetCurrent().Token)
if ($containerSid) { $principals += [Security.Principal.SecurityIdentifier]::new($containerSid) }

if ($kind -eq 'directory') {
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($principal in $principals) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $principal,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $security.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($targetPath, $security)
} elseif ($kind -eq 'file') {
  $security = [Security.AccessControl.FileSecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  foreach ($principal in $principals) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $principal,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $security.AddAccessRule($rule)
  }
  [IO.File]::SetAccessControl($targetPath, $security)
} else {
  throw 'Invalid ACL target kind.'
}`;

export type WindowsAclTargetKind = "directory" | "file";

export interface WindowsAclProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin: Uint8Array;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly targetKind: WindowsAclTargetKind;
}

export interface WindowsAclProcessResult {
  readonly exitCode: number;
}

export type WindowsAclProcessRunner = (
  request: WindowsAclProcessRequest,
) => Promise<WindowsAclProcessResult>;

export interface WindowsAclOptions {
  readonly runner?: WindowsAclProcessRunner;
  readonly platform?: NodeJS.Platform;
  readonly powershellPath?: string;
  readonly timeoutMs?: number;
}

export class WindowsAclError extends Error {
  readonly code = "WINDOWS_ACL_FAILED" as const;

  constructor() {
    super("Windows could not restrict access to the QQ Mail settings file.");
    this.name = "WindowsAclError";
  }
}

const defaultRunner: WindowsAclProcessRunner = async (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.executable, [...request.args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let outputBytes = 0;
    let settled = false;

    const removeIoListeners = (): void => {
      request.signal.removeEventListener("abort", onAbort);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onOutput);
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
      removeLifecycleListeners();
      if (killChild) {
        try {
          child.kill();
        } catch {
          // The generic failure intentionally hides subprocess details.
        }
      }
      reject(new Error("Windows ACL subprocess failed."));
    };
    const onAbort = (): void => fail();
    const onOutput = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_WINDOWS_ACL_OUTPUT_BYTES) {
        fail();
      }
    };
    const onError = (): void => fail(false);
    const onClose = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeIoListeners();
      removeLifecycleListeners();
      resolve({ exitCode: exitCode ?? -1 });
    };
    const onStdinError = (): void => fail();

    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
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

function powershellArgs(): readonly string[] {
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    RESTRICT_ACL_SCRIPT,
  ]);
}

function resolvePowershellPath(options: WindowsAclOptions): string {
  if (options.powershellPath) {
    return options.powershellPath;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return systemRoot
    ? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function resolveTimeoutMs(options: WindowsAclOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WINDOWS_ACL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WINDOWS_ACL_TIMEOUT_MS) {
    throw new WindowsAclError();
  }
  return timeoutMs;
}

async function runWithTimeout(
  runner: WindowsAclProcessRunner,
  request: Omit<WindowsAclProcessRequest, "signal" | "timeoutMs">,
  timeoutMs: number,
): Promise<WindowsAclProcessResult> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      controller.abort();
      rejectOnce(new Error("Windows ACL subprocess timed out."));
    }, timeoutMs);
    const resolveOnce = (result: WindowsAclProcessResult): void => {
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

export async function restrictWindowsPathToCurrentUser(
  targetPath: string,
  targetKind: WindowsAclTargetKind,
  options: WindowsAclOptions = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "win32") {
    return;
  }

  const timeoutMs = resolveTimeoutMs(options);
  const encodedPath = Buffer.from(targetPath, "utf8").toString("base64");
  const stdin = Buffer.from(`${targetKind}\n${encodedPath}`, "ascii");
  try {
    const result = await runWithTimeout(
      options.runner ?? defaultRunner,
      {
        executable: resolvePowershellPath(options),
        args: powershellArgs(),
        stdin,
        targetKind,
      },
      timeoutMs,
    );
    if (result.exitCode !== 0) {
      throw new WindowsAclError();
    }
  } catch (error) {
    if (error instanceof WindowsAclError) {
      throw error;
    }
    throw new WindowsAclError();
  } finally {
    stdin.fill(0);
  }
}
