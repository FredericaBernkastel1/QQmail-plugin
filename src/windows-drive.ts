import { spawn } from "node:child_process";
import path from "node:path";

// Query drive metadata before any filesystem request follows a mapped drive.
// Paths and mail input never become executable PowerShell text.
const DRIVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$drive = [Console]::In.ReadToEnd()
if ($drive -notmatch '^[A-Za-z]:\\$') { exit 1 }
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class QQMailDrive { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetDriveType(string root); }'
$kind = [QQMailDrive]::GetDriveType($drive)
if ($kind -eq 2 -or $kind -eq 3 -or $kind -eq 6) { [Console]::Out.Write('LOCAL') }
`;

export async function isLocalWindowsDrive(root: string): Promise<boolean> {
  if (process.platform !== "win32" || !/^[A-Za-z]:\\$/u.test(root)) return false;
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!windowsRoot) return false;
  return new Promise(resolve => {
    const child = spawn(path.win32.join(windowsRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DRIVE_SCRIPT],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", bytes = 0, finished = false;
    const finish = (allowed: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!allowed) child.kill();
      resolve(allowed);
    };
    const timer = setTimeout(() => finish(false), 10_000);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 1024) finish(false);
      else output += data.toString("ascii");
    });
    child.stderr.on("data", () => finish(false));
    child.once("error", () => finish(false));
    child.stdin.once("error", () => finish(false));
    child.once("close", code => finish(code === 0 && output === "LOCAL"));
    child.stdin.end(root);
  });
}
