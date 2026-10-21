import { ImapFlow, type FetchQueryObject, type MessageEnvelopeObject, type MessageStructureObject, type SearchObject } from "imapflow";
import nodemailer from "nodemailer";
import { VERSION } from "../version.js";
import { assertSecureServerConfig } from "./config-validation.js";
export { assertSecureServerConfig } from "./config-validation.js";
import { sanitizeWindowsFilename } from "../security.js";
import { ToolFailure, DeliveryFailure } from "../errors.js";
import { IMAP_DOWNLOAD_CHUNK_BYTES, MAX_IMAP_LITERAL_BYTES } from "./read-budget.js";
import type { OutgoingAttachmentContent } from "../outgoing-attachments.js";
import { MAX_OUTGOING_ATTACHMENTS, MAX_OUTGOING_FILE_BYTES, MAX_OUTGOING_TOTAL_BYTES, MAX_OUTGOING_MIME_BYTES } from "../attachment-limits.js";

import type {
  ImapDownload,
  ImapBodyStructure,
  ImapEnvelope,
  ImapGateway,
  ImapMailboxInfo,
  ImapMessageData,
  ImapSession,
  ImapSearchQuery,
  MailFolderConfig,
  MailServerConfig,
  OutgoingMessage,
  SelectedMailbox,
  SmtpGateway,
  SmtpSendResult,
} from "./types.js";

const TLS_OPTIONS = Object.freeze({ rejectUnauthorized: true, minVersion: "TLSv1.2" as const });

export class ImapFlowGateway implements ImapGateway {
  async connect(
    config: MailServerConfig,
    username: string,
    authorizationCode: string,
  ): Promise<ImapSession> {
    assertSecureServerConfig(config);
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.security === "tls",
      doSTARTTLS: config.security === "starttls",
      auth: { user: username, pass: authorizationCode },
      tls: { ...TLS_OPTIONS, servername: config.host },
      logger: false,
      emitLogs: false,
      logRaw: false,
      disableAutoIdle: true,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      maxLineLength: 8 * 1024 * 1024,
      maxLiteralSize: MAX_IMAP_LITERAL_BYTES,
      clientInfo: { name: "QQ Mail", version: VERSION, vendor: "Local development" },
    });
    // ImapFlow emits operational errors as events as well as rejected promises.
    // A no-op listener prevents process termination; errors are surfaced by the awaited call.
    client.on("error", () => undefined);
    await client.connect();
    return new ImapFlowSession(client);
  }
}

class ImapFlowSession implements ImapSession {
  #selectedRelease: (() => void) | undefined;
  #closed = false;

  constructor(private readonly client: ImapFlow) {}

  async listMailboxes(folders: MailFolderConfig): Promise<ImapMailboxInfo[]> {
    const entries = await this.client.list({
      specialUseHints: {
        sent: folders.sent,
        trash: folders.trash,
        ...(folders.spam ? { junk: folders.spam } : {}),
        ...(folders.drafts ? { drafts: folders.drafts } : {}),
      },
      statusQuery: { messages: true, unseen: true, uidValidity: true },
    });
    return entries.map((entry) => ({
      path: entry.path,
      delimiter: entry.delimiter,
      specialUse: entry.specialUse,
      flags: [...entry.flags],
      subscribed: entry.subscribed,
      messages: entry.status?.messages,
      unseen: entry.status?.unseen,
      uidValidity: entry.status?.uidValidity?.toString(),
    }));
  }

  async selectMailbox(path: string): Promise<SelectedMailbox> {
    this.#selectedRelease?.();
    this.#selectedRelease = undefined;
    const lock = await this.client.getMailboxLock(path);
    this.#selectedRelease = () => lock.release();
    const mailbox = this.client.mailbox;
    if (!mailbox) {
      this.#selectedRelease();
      this.#selectedRelease = undefined;
      throw new Error("Mailbox selection failed");
    }
    return {
      path: mailbox.path,
      uidValidity: mailbox.uidValidity.toString(),
      exists: mailbox.exists,
      readOnly: Boolean(mailbox.readOnly),
    };
  }

  async search(query: ImapSearchQuery): Promise<number[]> {
    const result = await this.client.search(toImapFlowSearch(query), { uid: true });
    return result || [];
  }

  async fetchMessages(
    uids: number[],
    options: { sourceMaxBytes?: number | undefined },
  ): Promise<ImapMessageData[]> {
    if (uids.length === 0) {
      return [];
    }
    if (options.sourceMaxBytes !== undefined && uids.length !== 1) {
      throw new ToolFailure("READ_BATCH_SOURCE_FORBIDDEN", "Read MIME sources one message at a time.");
    }
    const query: FetchQueryObject = {
      uid: true,
      flags: true,
      envelope: true,
      internalDate: true,
      size: true,
      bodyStructure: true,
    };
    if (options.sourceMaxBytes !== undefined) {
      query.source = { maxLength: options.sourceMaxBytes };
    }
    const records: ImapMessageData[] = [];
    for await (const record of this.client.fetch(uids, query, { uid: true })) {
      records.push({
        uid: record.uid,
        flags: new Set(record.flags ?? []),
        size: record.size,
        internalDate: record.internalDate,
        envelope: toMailEnvelope(record.envelope),
        bodyStructure: toMailStructure(record.bodyStructure),
        source: record.source,
      });
    }
    return records;
  }

  async addFlags(uids: number[], flags: string[]): Promise<void> {
    if (uids.length > 0 && flags.length > 0) {
      await this.client.messageFlagsAdd(uids, flags, { uid: true });
    }
  }

  async removeFlags(uids: number[], flags: string[]): Promise<void> {
    if (uids.length > 0 && flags.length > 0) {
      await this.client.messageFlagsRemove(uids, flags, { uid: true });
    }
  }

  async moveMessages(uids: number[], destination: string): Promise<void> {
    if (uids.length > 0) {
      const result = await this.client.messageMove(uids, destination, { uid: true });
      if (result === false) {
        throw new Error("Message move failed");
      }
    }
  }

  async downloadPart(uid: number, part: string, maxBytes: number): Promise<ImapDownload> {
    const result = await this.client.download(uid, part, { uid: true, maxBytes, chunkSize: IMAP_DOWNLOAD_CHUNK_BYTES });
    if (!result.content || !result.meta) throw new Error("Attachment part was not found");
    return {
      expectedSize: result.meta.expectedSize ?? 0,
      contentType: result.meta.contentType ?? "application/octet-stream",
      filename: result.meta.filename,
      content: result.content,
    };
  }

  async appendMessage(mailbox: string, source: Buffer, flags: string[], date: Date): Promise<void> {
    const result = await this.client.append(mailbox, source, flags, date);
    if (result === false) {
      throw new Error("Message append failed");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#selectedRelease?.();
    this.#selectedRelease = undefined;
    try {
      if (this.client.usable) {
        await this.client.logout();
      } else {
        this.client.close();
      }
    } catch {
      this.client.close();
    }
  }
}

function toImapFlowSearch(query: ImapSearchQuery): SearchObject {
  const converted: SearchObject = {
    all: query.all, text: query.text, from: query.from, to: query.to,
    subject: query.subject, since: query.since, before: query.before,
    seen: query.seen, flagged: query.flagged, uid: query.uid,
    header: query.header ? { ...query.header } : undefined,
    or: query.or?.map(toImapFlowSearch),
  };
  for (const key of Object.keys(converted) as Array<keyof SearchObject>) {
    if (converted[key] === undefined) delete converted[key];
  }
  return converted;
}

function toMailEnvelope(envelope: MessageEnvelopeObject | undefined): ImapEnvelope | undefined {
  if (!envelope) return undefined;
  const addresses = (entries: MessageEnvelopeObject["from"]) =>
    entries?.map(entry => ({ name: entry.name, address: entry.address }));
  return {
    date: envelope.date, subject: envelope.subject, messageId: envelope.messageId,
    inReplyTo: envelope.inReplyTo, from: addresses(envelope.from),
    to: addresses(envelope.to), cc: addresses(envelope.cc),
  };
}

function toMailStructure(structure: MessageStructureObject | undefined): ImapBodyStructure | undefined {
  if (!structure) return undefined;
  return {
    part: structure.part, type: structure.type, id: structure.id, size: structure.size,
    disposition: structure.disposition,
    parameters: structure.parameters ? { ...structure.parameters } : undefined,
    dispositionParameters: structure.dispositionParameters ? { ...structure.dispositionParameters } : undefined,
    childNodes: structure.childNodes?.map(node => toMailStructure(node)!),
  };
}

export class NodemailerSmtpGateway implements SmtpGateway {
  async verify(
    config: MailServerConfig,
    username: string,
    authorizationCode: string,
  ): Promise<void> {
    const transport = createSmtpTransport(config, username, authorizationCode);
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  }

  async send(
    config: MailServerConfig,
    username: string,
    authorizationCode: string,
    message: OutgoingMessage,
    attachments: readonly OutgoingAttachmentContent[] = [],
  ): Promise<SmtpSendResult> {
    assertSecureServerConfig(config);
    const compiled = await compileOutgoingMessage(message, attachments);
    const rawMessage = compiled.message;
    const transport = createSmtpTransport(config, username, authorizationCode);
    try {
      const result = await transport.sendMail({
        messageId: compiled.messageId,
        envelope: compiled.envelope,
        raw: rawMessage,
      });
      return {
        messageId: sanitizeMessageId(compiled.messageId),
        accepted: normalizeEnvelopeAddresses(result.accepted),
        rejected: normalizeEnvelopeAddresses(result.rejected),
        rawMessage,
      };
    } catch (error) {
      rawMessage.fill(0);
      throw classifySmtpFailure(error);
    } finally {
      transport.close();
    }
  }
}

export async function compileOutgoingMessage(message: OutgoingMessage, attachments: readonly OutgoingAttachmentContent[] = []) {
  const ids = message.attachmentIds ?? [];
  if (ids.length !== attachments.length || attachments.length > MAX_OUTGOING_ATTACHMENTS ||
      new Set(ids).size !== ids.length ||
      attachments.some((entry, index) => entry.attachmentId !== ids[index] ||
        !Buffer.isBuffer(entry.content) || entry.content.length !== entry.bytes ||
        entry.content.length > MAX_OUTGOING_FILE_BYTES ||
        entry.filename !== sanitizeWindowsFilename(entry.filename, { maxLength: 220 }) ||
        entry.contentType !== "application/octet-stream" ||
        "path" in entry || "href" in entry || "raw" in entry) ||
      attachments.reduce((total, entry) => total + entry.content.length, 0) > MAX_OUTGOING_TOTAL_BYTES) {
    throw new ToolFailure("INVALID_ATTACHMENTS", "Outgoing attachments must be bounded, approved byte snapshots.");
  }
  const compiler = nodemailer.createTransport({
    streamTransport: true as const,
    buffer: true,
    newline: "windows",
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const compiled = await compiler.sendMail(toMailOptions(message, attachments));
    if (!Buffer.isBuffer(compiled.message) || compiled.message.length > MAX_OUTGOING_MIME_BYTES) {
      if (Buffer.isBuffer(compiled.message)) compiled.message.fill(0);
      throw new ToolFailure("MESSAGE_TOO_LARGE", "The encoded email exceeds the 32 MiB limit. Reduce its body or attachments.");
    }
    return { ...compiled, message: compiled.message };
  } finally {
    compiler.close();
  }
}

function createSmtpTransport(
  config: MailServerConfig,
  username: string,
  authorizationCode: string,
) {
  assertSecureServerConfig(config);
  return nodemailer.createTransport({
    host: config.host,
    // Do not disclose the user's Windows computer name in SMTP EHLO.
    name: "qq-mail.local",
    port: config.port,
    secure: config.security === "tls",
    requireTLS: true,
    ignoreTLS: false,
    auth: { user: username, pass: authorizationCode },
    tls: { ...TLS_OPTIONS, servername: config.host },
    logger: false,
    debug: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

function toMailOptions(message: OutgoingMessage, attachments: readonly OutgoingAttachmentContent[]) {
  return {
    messageId: message.messageId,
    from: message.from,
    to: message.to,
    cc: message.cc,
    // streamTransport intentionally keeps Bcc headers. Supply Bcc recipients
    // only through the SMTP envelope so the generated MIME cannot disclose them.
    envelope: {
      from: message.from.address,
      to: [...message.to, ...message.cc, ...message.bcc].map((recipient) => recipient.address),
    },
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments: attachments.map(entry => ({
      filename: entry.filename, contentType: entry.contentType, content: entry.content,
      contentDisposition: "attachment" as const, contentTransferEncoding: "base64" as const,
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/** A socket loss at DATA can happen after acceptance. Do not retry it automatically. */
export function classifySmtpFailure(error: unknown): DeliveryFailure {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const response = typeof value.responseCode === "number" ? value.responseCode : 0;
  const command = typeof value.command === "string" ? value.command.toUpperCase() : "";
  const code = typeof value.code === "string" ? value.code : "";
  const explicitRejection = response >= 400 && response <= 599;
  // Nodemailer uses CONN for an unexpected close even AFTER DATA. Only actual
  // connect/DNS failures are definite here; generic socket close stays unknown.
  const originalCode = typeof value.originalCode === "string" ? value.originalCode : code;
  const connectFailed = command === "CONN" && (value.syscall === "connect" ||
    ["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(originalCode));
  const beforeData = connectFailed || /^(?:EHLO|HELO|STARTTLS|AUTH|MAIL FROM|RCPT TO)(?:\b|$)/u.test(command) ||
    ["EDNS", "EAUTH", "EENVELOPE"].includes(code);
  return new DeliveryFailure(explicitRejection || beforeData ? "not_sent" : "delivery_unknown");
}

function normalizeEnvelopeAddresses(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const result: string[] = [];
  for (const value of values) {
    const address =
      typeof value === "string"
        ? value
        : value && typeof value === "object" && "address" in value
          ? String(value.address)
          : "";
    if (address && !/[\r\n\0]/u.test(address) && address.length <= 320) {
      result.push(address);
    }
  }
  return result;
}

function sanitizeMessageId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 998 || /[\r\n\0]/u.test(value)) {
    return "unavailable";
  }
  return value;
}

