import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface SendApprovalRequest {
  readonly draftId: string;
  readonly digest: string;
  readonly expiresAt: string;
  readonly preview: Readonly<Record<string, unknown>>;
}

export const WINDOWS_APPROVAL_MAX_BYTES = 512 * 1024;
export type ApprovalStatus = "approved" | "declined" | "timeout" | "unavailable" | "too_large";
export interface ApprovalResult {
  readonly status: ApprovalStatus;
}
export interface ApprovalPreflight {
  readonly ok: boolean;
  readonly status: "ready" | "too_large";
  readonly bytes: number;
  readonly maxBytes: number;
}

export interface WindowsApprovalRequest {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly expiresAt: string;
  readonly preview: Readonly<Record<string, unknown>>;
}

/** Trusted application boundary. Never expose this capability as an MCP tool. */
export interface SendApproval {
  confirm(request: SendApprovalRequest): Promise<boolean>;
  confirmDetailed?(request: SendApprovalRequest): Promise<ApprovalResult>;
}

export const denySendApproval: SendApproval = Object.freeze({
  confirm: async () => false,
  confirmDetailed: async (): Promise<ApprovalResult> => ({ status: "unavailable" }),
});

// No values from mail or MCP are interpolated into this program.
// The nonce goes over private stdin/stdout, never into MCP responses or URLs.
export const WINDOWS_APPROVAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = $request.title
$form.Width = 800
$form.Height = 680
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$text = New-Object Windows.Forms.TextBox
$text.Multiline = $true
$text.ReadOnly = $true
$text.ScrollBars = 'Both'
$text.WordWrap = $false
$text.Dock = 'Fill'
$text.Font = New-Object Drawing.Font('Consolas', 10)
$text.Text = $request.description + [Environment]::NewLine + [Environment]::NewLine + $request.preview
$panel = New-Object Windows.Forms.FlowLayoutPanel
$panel.Dock = 'Bottom'
$panel.Height = 50
$send = New-Object Windows.Forms.Button
$send.Text = $request.confirmLabel
$send.Width = 160
$send.DialogResult = [Windows.Forms.DialogResult]::Yes
$cancel = New-Object Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Width = 120
$cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
$panel.Controls.Add($cancel)
$panel.Controls.Add($send)
$form.Controls.Add($text)
$form.Controls.Add($panel)
$form.CancelButton = $cancel
$form.AcceptButton = $cancel
try {
  if ($form.ShowDialog() -eq [Windows.Forms.DialogResult]::Yes) {
    [Console]::Out.Write($request.nonce)
  }
} finally { $form.Dispose() }
`;

/** Production approval requires a separate Windows user gesture, not a model flag. */
export class WindowsSendApproval implements SendApproval {
  async confirm(request: SendApprovalRequest): Promise<boolean> {
    return (await this.confirmDetailed(request)).status === "approved";
  }

  confirmDetailed(request: SendApprovalRequest): Promise<ApprovalResult> {
    return requestWindowsApprovalDetailed(sendPresentation(request));
  }
}

function sendPresentation(request: SendApprovalRequest): WindowsApprovalRequest {
    return {
      title: "QQ Mail - Confirm sending",
      description: "Review the complete message below. Sending cannot be undone.",
      confirmLabel: "Send this email",
      expiresAt: request.expiresAt,
      preview: {
        draftId: request.draftId,
        digest: request.digest,
        expiresAt: request.expiresAt,
        ...request.preview,
      },
    };
}

function approvalInput(request: WindowsApprovalRequest, nonce: string): Buffer {
  return Buffer.from(JSON.stringify({
    nonce,
    title: request.title,
    description: request.description,
    confirmLabel: request.confirmLabel,
    preview: JSON.stringify(request.preview, null, 2).replace(/[\u202a-\u202e\u2066-\u2069]/gu, character =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")),
  }), "utf8");
}

/** Uses the exact same complete UTF-8 payload as the native window, including JSON escaping. */
export function preflightWindowsApproval(request: WindowsApprovalRequest): ApprovalPreflight {
  const input = approvalInput(request, "0".repeat(64));
  try {
    const ok = input.byteLength <= WINDOWS_APPROVAL_MAX_BYTES;
    return { ok, status: ok ? "ready" : "too_large", bytes: input.byteLength, maxBytes: WINDOWS_APPROVAL_MAX_BYTES };
  } finally { input.fill(0); }
}

export function preflightSendApproval(request: SendApprovalRequest): ApprovalPreflight {
  return preflightWindowsApproval(sendPresentation(request));
}

/** Only trusted application code selects this presentation; never accept it from MCP. */
export async function requestWindowsApproval(request: WindowsApprovalRequest): Promise<boolean> {
  return (await requestWindowsApprovalDetailed(request)).status === "approved";
}

export async function requestWindowsApprovalDetailed(request: WindowsApprovalRequest): Promise<ApprovalResult> {
    if (process.platform !== "win32") return { status: "unavailable" };
    const remaining = Date.parse(request.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return { status: "timeout" };
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!windowsRoot) return { status: "unavailable" };
    const nonce = randomBytes(32).toString("hex");
    const input = approvalInput(request, nonce);
    if (input.byteLength > WINDOWS_APPROVAL_MAX_BYTES) {
      input.fill(0);
      return { status: "too_large" };
    }
    return new Promise<ApprovalResult>((resolve) => {
      let settled = false;
      let output = "";
      let bytes = 0;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoLogo", "-NoProfile", "-STA", "-NonInteractive", "-Command", WINDOWS_APPROVAL_SCRIPT],
          { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        input.fill(0);
        resolve({ status: "unavailable" });
        return;
      }
      const finish = (status: ApprovalStatus): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.fill(0);
        if (status !== "approved") child.kill();
        resolve({ status });
      };
      const timer = setTimeout(() => finish("timeout"), Math.min(120_000, remaining));
      child.stdout!.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) finish("unavailable");
        else output += chunk.toString("ascii");
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) finish("unavailable");
      });
      child.once("error", () => finish("unavailable"));
      child.stdin!.once("error", () => finish("unavailable"));
      child.once("close", (code) => {
        if (Date.now() >= Date.parse(request.expiresAt)) finish("timeout");
        else if (code !== 0 || (output !== "" && output !== nonce)) finish("unavailable");
        else finish(output === nonce ? "approved" : "declined");
      });
      child.stdin!.end(input.toString("base64"));
    });
}
