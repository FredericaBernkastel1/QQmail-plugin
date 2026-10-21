import type { Readable } from "node:stream";
import type { OutgoingAttachmentContent } from "../outgoing-attachments.js";

/** Provider-neutral subset used by the mail service. Protocol conversion belongs to the gateway. */
export interface ImapSearchQuery {
  all?: boolean | undefined;
  text?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  since?: Date | undefined;
  before?: Date | undefined;
  seen?: boolean | undefined;
  flagged?: boolean | undefined;
  uid?: string | undefined;
  header?: Record<string, string> | undefined;
  or?: ImapSearchQuery[] | undefined;
}

export interface ImapAddress {
  name?: string | undefined;
  address?: string | undefined;
}

export interface ImapEnvelope {
  date?: Date | string | undefined;
  subject?: string | undefined;
  messageId?: string | undefined;
  inReplyTo?: string | undefined;
  from?: ImapAddress[] | undefined;
  to?: ImapAddress[] | undefined;
  cc?: ImapAddress[] | undefined;
}

export interface ImapBodyStructure {
  part?: string | undefined;
  type: string;
  parameters?: Record<string, string> | undefined;
  id?: string | undefined;
  size?: number | undefined;
  disposition?: string | undefined;
  dispositionParameters?: Record<string, string> | undefined;
  childNodes?: ImapBodyStructure[] | undefined;
}

export interface ReadBodyRange {
  bodyOffset?: number | undefined;
  bodyLimit?: number | undefined;
  /** Internal callers may cancel; this is not an MCP input field. */
  signal?: AbortSignal | undefined;
}

export interface BodyPage {
  format: "plain_text";
  text: string;
  truncated: boolean;
  /** Offsets and character counts use JavaScript UTF-16 code units. */
  offset: number;
  returnedChars: number;
  totalChars: number;
  nextOffset: number | null;
  truncationReasons: string[];
}

export interface ReadAttachment {
  attachmentId: string;
  filename: string;
  contentType: string;
  size: number;
  disposition: string;
  contentId: string | null;
  downloadable: boolean;
}

export interface ReadMessageResult {
  messageRef: string;
  mailbox: string;
  uid: number;
  subject: string;
  date: string | null;
  from: OutgoingAddress[];
  replyTo: OutgoingAddress[];
  to: OutgoingAddress[];
  cc: OutgoingAddress[];
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  unread: boolean;
  starred: boolean;
  body: BodyPage;
  attachments: ReadAttachment[];
  incomplete: boolean;
  truncationReasons: string[];
  untrusted: true;
}

export interface ReadBatchResult {
  messages: ReadMessageResult[];
  incomplete: boolean;
  truncated: boolean;
  truncationReasons: string[];
  skippedMessages: Array<{ messageRef: string; reason: string }>;
  skippedMessageCount: number;
  continuation: string;
}

export interface ThreadResult extends ReadBatchResult {
  mailbox: string;
  rootMessageRef: string;
  searchedMailboxes: string[];
  skippedMailboxes: string[];
}

export type MailTransportSecurity = "tls" | "starttls";

export interface MailServerConfig {
  host: string;
  port: number;
  security: MailTransportSecurity;
}

export interface MailFolderConfig {
  inbox: string;
  sent: string;
  trash: string;
  drafts?: string | undefined;
  spam?: string | undefined;
  archive?: string | undefined;
}

/** Runtime configuration deliberately excludes the authorization code. */
export interface MailAccountConfig {
  /** Cloud deployments have no host filesystem attachment capability. */
  attachmentsDisabled?: boolean;
  email: string;
  username: string;
  displayName: string;
  imap: MailServerConfig;
  smtp: MailServerConfig;
  folders: MailFolderConfig;
  downloadDirectory: string;
  downloadLimitBytes: number;
  messageParseLimitBytes?: number | undefined;
}

export interface MailAccountProvider {
  getContext(): Promise<MailAccountContext | undefined>;
}

export interface MailAccountContext {
  readonly account: MailAccountConfig;
  readonly scope: string;
  /** Bound to this account snapshot; must never read a mutable current secret. */
  getAuthorizationCode(): Promise<string | undefined>;
}

export interface MessageLocator {
  accountScope: string;
  mailbox: string;
  uidValidity: string;
  uid: number;
}

export interface MessageReferenceCodec {
  encode(locator: MessageLocator): string;
  decode(reference: string): MessageLocator;
}

export interface ImapMailboxInfo {
  path: string;
  delimiter: string;
  specialUse?: string | undefined;
  flags: string[];
  subscribed: boolean;
  messages?: number | undefined;
  unseen?: number | undefined;
  uidValidity?: string | undefined;
}

export interface SelectedMailbox {
  path: string;
  uidValidity: string;
  exists: number;
  readOnly: boolean;
}

export interface ImapMessageData {
  uid: number;
  flags: Set<string>;
  size?: number | undefined;
  internalDate?: Date | string | undefined;
  envelope?: ImapEnvelope | undefined;
  bodyStructure?: ImapBodyStructure | undefined;
  source?: Buffer | undefined;
}

export interface ImapDownload {
  expectedSize: number;
  contentType: string;
  filename?: string | undefined;
  content: Readable;
}

export interface ImapSession {
  listMailboxes(folders: MailFolderConfig): Promise<ImapMailboxInfo[]>;
  selectMailbox(path: string): Promise<SelectedMailbox>;
  search(query: ImapSearchQuery): Promise<number[]>;
  /** Source fetches accept exactly one UID. Metadata fetches may accept a page. */
  fetchMessages(
    uids: number[],
    options: { sourceMaxBytes?: number | undefined },
  ): Promise<ImapMessageData[]>;
  addFlags(uids: number[], flags: string[]): Promise<void>;
  removeFlags(uids: number[], flags: string[]): Promise<void>;
  moveMessages(uids: number[], destination: string): Promise<void>;
  downloadPart(uid: number, part: string, maxBytes: number): Promise<ImapDownload>;
  appendMessage(mailbox: string, source: Buffer, flags: string[], date: Date): Promise<void>;
  close(): Promise<void>;
}

export interface ImapGateway {
  connect(config: MailServerConfig, username: string, authorizationCode: string): Promise<ImapSession>;
}

export interface OutgoingAddress {
  name: string;
  address: string;
}

export interface OutgoingMessage {
  messageId?: string;
  from: OutgoingAddress;
  to: OutgoingAddress[];
  cc: OutgoingAddress[];
  bcc: OutgoingAddress[];
  subject: string;
  text: string;
  html?: string | undefined;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  attachmentIds?: string[] | undefined;
}

export interface SmtpSendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  rawMessage: Buffer;
}

export interface SmtpGateway {
  verify(config: MailServerConfig, username: string, authorizationCode: string): Promise<void>;
  send(
    config: MailServerConfig,
    username: string,
    authorizationCode: string,
    message: OutgoingMessage,
    attachments?: readonly OutgoingAttachmentContent[],
    beforeDispatch?: () => Promise<void>,
  ): Promise<SmtpSendResult>;
}

export interface AttachmentSaveRequest {
  rootDirectory: string;
  suggestedName: string;
  maxBytes: number;
  expectedBytes: number;
  content: Readable;
}

export interface AttachmentSaveResult {
  path: string;
  filename: string;
  bytes: number;
}

/** Implementations enforce containment, symlink checks, collision handling, and atomic writes. */
export interface AttachmentStorage {
  save(request: AttachmentSaveRequest): Promise<AttachmentSaveResult>;
}

export interface SearchEmailsInput {
  mailbox?: string | undefined;
  query?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  unread?: boolean | undefined;
  starred?: boolean | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface PrepareEmailInput {
  authorizationId?: string | undefined;
  mode?: "compose" | "reply" | "reply_all" | "forward" | undefined;
  sourceRef?: string | undefined;
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject?: string | undefined;
  text?: string | undefined;
  html?: string | undefined;
  attachmentIds?: string[] | undefined;
}
