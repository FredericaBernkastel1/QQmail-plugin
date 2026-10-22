/** Selected only by trusted process startup configuration, never by tool input. */
export type ToolProfile = "interactive" | "read-only" | "authorized";

const readTools = [
  "get_account_status", "list_mailboxes", "search_emails", "read_email",
  "batch_read_emails", "read_email_thread",
] as const;

const draftAndWriteTools = [
  "list_drafts", "get_draft", "prepare_email", "update_draft", "cancel_draft",
  "send_email", "set_email_flags", "trash_emails",
] as const;

const authorizationTools = [
  "request_mail_authorization", "list_mail_authorizations", "revoke_mail_authorization",
] as const;

const interactiveTools = [
  ...readTools, ...draftAndWriteTools, ...authorizationTools,
  "open_settings", "test_connection", "list_accounts", "switch_account",
  "plugin_settings_read", "plugin_settings_update", "settings_request",
  "select_attachments", "list_attachments", "remove_attachments", "download_attachment", "move_emails",
] as const;

const authorizedTools = [
  ...readTools, ...draftAndWriteTools, ...authorizationTools,
] as const;

export function parseToolProfile(args: readonly string[]): ToolProfile {
  if (args.length === 0) return "interactive";
  if (args.length === 1) {
    switch (args[0]) {
      case "--profile=interactive": return "interactive";
      case "--profile=read-only": return "read-only";
      case "--profile=authorized": return "authorized";
    }
  }
  throw new TypeError("Expected no arguments or one --profile=interactive|read-only|authorized argument.");
}

/** An explicit allowlist keeps newly added tools out of every profile until reviewed. */
export function getToolNamesForProfile(profile: ToolProfile): readonly string[] {
  switch (profile) {
    case "interactive": return [...interactiveTools];
    case "read-only": return [...readTools];
    case "authorized": return [...authorizedTools];
    default: throw new TypeError("Unknown QQ Mail tool profile.");
  }
}
