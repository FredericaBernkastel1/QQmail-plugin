import { domainToASCII } from "node:url";

import {
  MailParser,
  type AddressObject,
  type AttachmentStream,
  type EmailAddress,
  type Headers,
  type MessageText,
} from "mailparser";

import { htmlToSafeText as coreHtmlToSafeText } from "../security.js";
import type { ImapAddress, ImapBodyStructure, OutgoingAddress, ReadBodyRange } from "./types.js";
import { checkReadCancelled } from "./read-budget.js";

const MAX_BODY_CHARS = 500_000;
const MAX_HEADER_CHARS = 998;

export interface ParsedAttachmentMetadata {
  filename: string;
  contentType: string;
  size: number;
  contentId?: string | undefined;
  related: boolean;
}

export interface ParsedIncomingMessage {
  subject: string;
  date?: Date | undefined;
  messageId?: string | undefined;
  inReplyTo?: string | undefined;
  references: string[];
  from: OutgoingAddress[];
  replyTo: OutgoingAddress[];
  to: OutgoingAddress[];
  cc: OutgoingAddress[];
  text: string;
  bodyTruncated: boolean;
  bodyOffset: number;
  bodyTotalChars: number;
  bodyNextOffset: number | null;
  attachments: ParsedAttachmentMetadata[];
}

export interface BodyAttachmentPart {
  part: string;
  filename: string;
  contentType: string;
  disposition: string;
  size: number;
  contentId?: string | undefined;
}

export async function parseIncomingMessage(source: Buffer, range: ReadBodyRange = {}): Promise<ParsedIncomingMessage> {
  checkReadCancelled(range.signal);
  const parser = new MailParser({
    skipImageLinks: true,
    skipTextLinks: true,
    maxHtmlLengthToParse: 2 * 1024 * 1024,
  });
  let headers: Headers = new Map();
  let textBody = "";
  let htmlBody = "";
  const attachments: ParsedAttachmentMetadata[] = [];

  const abort = (): void => { parser.destroy(new Error("Mail read cancelled")); };
  range.signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    parser.once("error", fail);
    parser.on("headers", (value) => {
      headers = value;
    });
    parser.on("data", (item: AttachmentStream | MessageText) => {
      if (item.type === "attachment") {
        attachments.push({
          filename: sanitizeDisplayText(item.filename || "attachment.bin", 255),
          contentType: sanitizeDisplayText(item.contentType || "application/octet-stream", 255),
          size: boundedNonNegativeInteger(item.size),
          contentId: sanitizeOptionalHeader(item.contentId, 998),
          related: Boolean(item.related),
        });
        item.content.once("error", fail);
        item.content.once("end", () => item.release?.());
        item.content.on("data", () => undefined);
        return;
      }
      if (item.text) {
        textBody = item.text;
      }
      if (typeof item.html === "string") {
        htmlBody = item.html;
      }
    });
    parser.once("end", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    parser.end(source);
    });
  } finally {
    range.signal?.removeEventListener("abort", abort);
    parser.destroy();
  }
  checkReadCancelled(range.signal);

  // Re-process HTML ourselves so generated text never retains remote image or tracking URLs.
  const unsafeBody = htmlBody ? htmlToSafeText(htmlBody) : textBody;
  const normalizedBody = sanitizeBodyText(unsafeBody);
  const bodyOffset = range.bodyOffset ?? 0;
  const clippedBody = normalizedBody.slice(bodyOffset, bodyOffset + (range.bodyLimit ?? MAX_BODY_CHARS));
  const bodyNextOffset = bodyOffset + clippedBody.length < normalizedBody.length ? bodyOffset + clippedBody.length : null;
  return {
    subject: sanitizeDisplayText(readStringHeader(headers, "subject") || "(no subject)", MAX_HEADER_CHARS),
    date: readDateHeader(headers, "date"),
    messageId: sanitizeMessageId(readStringHeader(headers, "message-id")),
    inReplyTo: sanitizeMessageId(readStringHeader(headers, "in-reply-to")),
    references: readReferences(headers),
    from: readAddressHeader(headers, "from"),
    replyTo: readAddressHeader(headers, "reply-to"),
    to: readAddressHeader(headers, "to"),
    cc: readAddressHeader(headers, "cc"),
    text: clippedBody,
    bodyTruncated: bodyOffset > 0 || bodyNextOffset !== null,
    bodyOffset,
    bodyTotalChars: normalizedBody.length,
    bodyNextOffset,
    attachments,
  };
}

export function flattenAttachmentParts(
  structure: ImapBodyStructure | undefined,
): BodyAttachmentPart[] {
  if (!structure) {
    return [];
  }
  const result: BodyAttachmentPart[] = [];
  const visit = (node: ImapBodyStructure): void => {
    for (const child of node.childNodes ?? []) {
      visit(child);
    }
    const part = node.part;
    const disposition = (node.disposition || "").toLowerCase();
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
    if (
      part &&
      /^\d+(?:\.\d+)*$/u.test(part) &&
      (disposition === "attachment" || disposition === "inline" || Boolean(filename))
    ) {
      result.push({
        part,
        filename: sanitizeDisplayText(filename || "attachment.bin", 255),
        contentType: sanitizeDisplayText(node.type || "application/octet-stream", 255),
        disposition: disposition || "attachment",
        size: boundedNonNegativeInteger(node.size),
        contentId: sanitizeOptionalHeader(node.id, 998),
      });
    }
  };
  visit(structure);
  return result;
}

export function normalizeEnvelopeAddresses(
  addresses: ImapAddress[] | undefined,
): OutgoingAddress[] {
  const result: OutgoingAddress[] = [];
  for (const entry of addresses ?? []) {
    if (!entry.address) {
      continue;
    }
    try {
      result.push({
        address: normalizeEmailAddress(entry.address),
        name: sanitizeDisplayText(entry.name || "", 200),
      });
    } catch {
      // Invalid incoming addresses remain untrusted and are omitted from structured output.
    }
  }
  return deduplicateAddresses(result);
}

export function normalizeOutgoingAddresses(values: readonly string[] | undefined): OutgoingAddress[] {
  const result = (values ?? []).map((address) => ({ name: "", address: normalizeEmailAddress(address) }));
  return deduplicateAddresses(result);
}

export function normalizeEmailAddress(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 320 || /[\s\r\n\0<>(),;:"\[\]\\]/u.test(value)) {
    throw new Error("Email address is invalid");
  }
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator !== value.indexOf("@")) {
    throw new Error("Email address is invalid");
  }
  const local = value.slice(0, separator);
  const rawDomain = value.slice(separator + 1).replace(/\.$/u, "");
  const domain = domainToASCII(rawDomain).toLowerCase();
  if (
    !domain ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/u.test(local) ||
    domain.length > 253 ||
    !domain.includes(".") ||
    !domain.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))
  ) {
    throw new Error("Email address is invalid");
  }
  return `${local}@${domain}`;
}

export function validateHeaderText(value: string, maximum = MAX_HEADER_CHARS): string {
  if (typeof value !== "string" || value.length > maximum || /[\r\n\0]/u.test(value)) {
    throw new Error("Mail header is invalid");
  }
  return value.trim();
}

export function sanitizeMessageId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  if (
    normalized.length < 3 ||
    normalized.length > MAX_HEADER_CHARS ||
    /[\s\r\n\0]/u.test(normalized) ||
    !normalized.startsWith("<") ||
    !normalized.endsWith(">")
  ) {
    return undefined;
  }
  return normalized;
}

export function prefixSubject(subject: string, prefix: "Re:" | "Fwd:"): string {
  const clean = validateHeaderText(subject || "(no subject)");
  const alreadyPrefixed = prefix === "Re:" ? /^\s*re\s*:/iu : /^\s*(?:fwd?|转发)\s*:/iu;
  return alreadyPrefixed.test(clean) ? clean : `${prefix} ${clean}`;
}

export function deduplicateAddresses(values: readonly OutgoingAddress[]): OutgoingAddress[] {
  const seen = new Set<string>();
  const result: OutgoingAddress[] = [];
  for (const value of values) {
    const key = value.address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

export function htmlToSafeText(html: string): string {
  return coreHtmlToSafeText(html);
}

function readAddressHeader(headers: Headers, name: string): OutgoingAddress[] {
  const value = headers.get(name);
  if (!value || typeof value !== "object" || value instanceof Date || Array.isArray(value)) {
    return [];
  }
  if (!("value" in value) || !Array.isArray((value as AddressObject).value)) {
    return [];
  }
  const output: OutgoingAddress[] = [];
  const visit = (entry: EmailAddress): void => {
    for (const child of entry.group ?? []) {
      visit(child);
    }
    if (!entry.address) {
      return;
    }
    try {
      output.push({
        address: normalizeEmailAddress(entry.address),
        name: sanitizeDisplayText(entry.name || "", 200),
      });
    } catch {
      // Drop malformed untrusted addresses instead of reflecting raw header text.
    }
  };
  for (const entry of (value as AddressObject).value) {
    visit(entry);
  }
  return deduplicateAddresses(output);
}

function readStringHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return typeof value === "string" ? value : undefined;
}

function readDateHeader(headers: Headers, name: string): Date | undefined {
  const value = headers.get(name);
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : undefined;
}

function readReferences(headers: Headers): string[] {
  const value = headers.get("references");
  const candidates = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  return [...new Set(candidates.map((entry) => sanitizeMessageId(entry)).filter((entry): entry is string => Boolean(entry)))];
}

function sanitizeBodyText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\0\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
}

function sanitizeDisplayText(value: string, maximum: number): string {
  return value
    .replace(/[\r\n\0\u0001-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function sanitizeOptionalHeader(value: string | undefined, maximum: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const result = sanitizeDisplayText(value, maximum);
  return result || undefined;
}

function boundedNonNegativeInteger(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}
