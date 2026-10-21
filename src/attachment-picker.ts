import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { MAX_OUTGOING_ATTACHMENTS } from "./attachment-limits.js";

/** Only trusted application code supplies a picker. MCP never supplies paths. */
export interface AttachmentPicker {
  select(accountEmail: string): Promise<readonly string[]>;
  selectDetailed?(accountEmail: string): Promise<AttachmentSelection>;
}
export interface AttachmentSelection { status: "selected" | "cancelled" | "timeout" | "unavailable" | "too_many"; paths: readonly string[]; }

export const denyAttachmentPicker: AttachmentPicker = Object.freeze({ select: async () => [] });

// Fixed program: external values are stdin data, never PowerShell source.
export const WINDOWS_ATTACHMENT_PICKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object Windows.Forms.OpenFileDialog
$dialog.Title = 'QQ Mail - Select attachments for ' + $request.accountEmail + ' (sending requires another confirmation)'
$dialog.Multiselect = $true
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.DereferenceLinks = $false
$dialog.RestoreDirectory = $true
$dialog.AutoUpgradeEnabled = $false
$setOption = [Windows.Forms.FileDialog].GetMethod('SetOption', [Reflection.BindingFlags]'NonPublic,Instance')
if ($null -eq $setOption) { exit 3 }
$setOption.Invoke($dialog, @(0x02000000, $true)) | Out-Null
$dialog.Filter = 'All files (*.*)|*.*'
$files = @()
try {
  if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) {
    $files = @($dialog.FileNames)
  }
  if ($files.Count -gt $request.maxFiles) { exit 2 }
  [Console]::Out.Write((@{nonce=$request.nonce;paths=$files} | ConvertTo-Json -Compress))
} finally { $dialog.Dispose() }
`;

export class WindowsAttachmentPicker implements AttachmentPicker {
  async select(accountEmail: string): Promise<readonly string[]> {
    return (await this.selectDetailed(accountEmail)).paths;
  }
  async selectDetailed(accountEmail: string): Promise<AttachmentSelection> {
    if (process.platform !== "win32") return { status: "unavailable", paths: [] };
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!windowsRoot) return { status: "unavailable", paths: [] };
    const nonce = randomBytes(32).toString("hex");
    const input = Buffer.from(JSON.stringify({
      nonce, maxFiles: MAX_OUTGOING_ATTACHMENTS, accountEmail,
    }), "utf8");
    return new Promise(resolve => {
      const child = spawn(path.win32.join(windowsRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoLogo", "-NoProfile", "-STA", "-NonInteractive", "-Command", WINDOWS_ATTACHMENT_PICKER_SCRIPT],
        { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const output: Buffer[] = [];
      let bytes = 0, finished = false;
      const finish = (status: AttachmentSelection["status"], files: readonly string[] = []): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        input.fill(0);
        child.kill();
        resolve({ status, paths: files });
      };
      const timer = setTimeout(() => finish("timeout"), 120_000);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) finish("unavailable");
        else output.push(chunk);
      });
      child.stderr.on("data", () => finish("unavailable"));
      child.once("error", () => finish("unavailable"));
      child.stdin.once("error", () => finish("unavailable"));
      child.once("close", code => {
        if (code === 2) { finish("too_many"); return; }
        try {
          const result = JSON.parse(Buffer.concat(output).toString("utf8"));
          if (code !== 0 || result.nonce !== nonce || !Array.isArray(result.paths) ||
              result.paths.length > MAX_OUTGOING_ATTACHMENTS ||
              result.paths.some((p: unknown) => typeof p !== "string" || p.length > 4096 || /[\0\r\n]/u.test(p))) {
            finish("unavailable"); return;
          }
          finish(result.paths.length ? "selected" : "cancelled", result.paths);
        } catch { finish("unavailable"); }
      });
      child.stdin.end(input.toString("base64"));
    });
  }
}
