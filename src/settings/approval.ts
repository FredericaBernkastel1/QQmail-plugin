import { requestWindowsApproval } from "../approval.js";

export interface SettingsApprovalRequest {
  readonly action: "store-credential" | "clear-credential" | "save-settings" | "test-imap" | "test-smtp" | "create-profile" | "switch-profile" | "delete-profile";
  readonly details: Readonly<Record<string, unknown>>;
}

export interface SettingsApproval {
  confirm(request: SettingsApprovalRequest): Promise<boolean>;
}

export const denySettingsApproval: SettingsApproval = Object.freeze({
  confirm: async () => false,
});

/** The loopback bearer token is routing authentication, not user consent. */
export class WindowsSettingsApproval implements SettingsApproval {
  confirm(request: SettingsApprovalRequest): Promise<boolean> {
    return requestWindowsApproval({
      title: "QQ Mail - Confirm settings action",
      description: request.action.startsWith("test-")
        ? "This connection test will send your saved login name and authorization code to the server shown below. Approve only a server you trust."
        : "Review this settings change. Saved mail servers will receive your credentials and mailbox requests during later mail operations.",
      confirmLabel: "Allow this action",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      preview: { action: request.action, ...request.details },
    });
  }
}
