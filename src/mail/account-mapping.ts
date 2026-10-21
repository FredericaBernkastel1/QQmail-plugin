import type { QqMailConfig } from "../config.js";
import type { MailAccountConfig, MailFolderConfig } from "./types.js";

export const DEFAULT_MAIL_FOLDERS = Object.freeze({
  inbox: "INBOX", sent: "Sent Messages", drafts: "Drafts", trash: "Deleted Messages", spam: "Junk", archive: "Archive",
});

export function foldersFromStoredConfig(config: QqMailConfig): MailFolderConfig {
  return {
    inbox: config.inboxMailbox ?? DEFAULT_MAIL_FOLDERS.inbox,
    sent: config.sentMailbox ?? DEFAULT_MAIL_FOLDERS.sent,
    drafts: config.draftsMailbox ?? DEFAULT_MAIL_FOLDERS.drafts,
    trash: config.trashMailbox ?? DEFAULT_MAIL_FOLDERS.trash,
    spam: config.spamMailbox ?? DEFAULT_MAIL_FOLDERS.spam,
    ...(config.archiveMailbox ? { archive: config.archiveMailbox } : {}),
  };
}

/** One pure mapping is shared by saved-account operations and settings tests. */
export function mapStoredConfig(config: QqMailConfig): MailAccountConfig {
  return {
    email: config.email, username: config.username, displayName: config.displayName,
    imap: { host: config.imap.host, port: config.imap.port, security: config.imap.security },
    smtp: { host: config.smtp.host, port: config.smtp.port, security: config.smtp.security },
    folders: foldersFromStoredConfig(config), downloadDirectory: config.downloadDirectory,
    downloadLimitBytes: config.maxDownloadBytes,
  };
}
