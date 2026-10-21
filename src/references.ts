import { z } from "zod/v4";

export const MESSAGE_REFERENCE_VERSION = 2 as const;
const REFERENCE_PREFIX = "qqm2_";
const MAX_UINT32 = 4_294_967_295n;

export type UidValidity = string | number | bigint;

export interface MessageReferenceLocation {
  readonly accountScope: string;
  readonly mailbox: string;
  readonly uidValidity: UidValidity;
  readonly uid: number;
}

export interface DecodedMessageReference {
  readonly accountScope: string;
  readonly version: typeof MESSAGE_REFERENCE_VERSION;
  readonly mailbox: string;
  readonly uidValidity: string;
  readonly uid: number;
}

const wireReferenceSchema = z
  .object({
    v: z.literal(MESSAGE_REFERENCE_VERSION),
    a: z.string().regex(/^[a-f0-9]{64}$/u),
    m: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    u: z.string().regex(/^[1-9][0-9]{0,9}$/u),
    i: z.number().int().min(1).max(Number(MAX_UINT32)),
  })
  .strict();

export class MessageReferenceError extends Error {
  readonly code: "INVALID_MESSAGE_REFERENCE" | "STALE_MESSAGE_REFERENCE";

  constructor(code: MessageReferenceError["code"], message: string) {
    super(message);
    this.name = code === "STALE_MESSAGE_REFERENCE" ? "StaleMessageReferenceError" : "MessageReferenceError";
    this.code = code;
  }
}

export class StaleMessageReferenceError extends MessageReferenceError {
  constructor() {
    super(
      "STALE_MESSAGE_REFERENCE",
      "This message reference has expired because the mailbox was recreated. Search for the message again.",
    );
    this.name = "StaleMessageReferenceError";
  }
}

function invalidReference(): MessageReferenceError {
  return new MessageReferenceError("INVALID_MESSAGE_REFERENCE", "The message reference is invalid.");
}

export function normalizeUidValidity(value: UidValidity): string {
  let parsed: bigint;
  try {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw invalidReference();
      }
      parsed = BigInt(value);
    } else {
      parsed = BigInt(value);
    }
  } catch {
    throw invalidReference();
  }

  if (parsed < 1n || parsed > MAX_UINT32) {
    throw invalidReference();
  }
  return parsed.toString(10);
}

export function encodeMessageReference(location: MessageReferenceLocation): string {
  const parsed = wireReferenceSchema.safeParse({
    v: MESSAGE_REFERENCE_VERSION,
    a: location.accountScope,
    m: location.mailbox,
    u: normalizeUidValidity(location.uidValidity),
    i: location.uid,
  });
  if (!parsed.success) {
    throw invalidReference();
  }

  const payload = Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");
  return `${REFERENCE_PREFIX}${payload}`;
}

export function decodeMessageReference(reference: string): DecodedMessageReference {
  if (
    typeof reference !== "string" ||
    reference.length < REFERENCE_PREFIX.length + 4 ||
    reference.length > 4_096 ||
    !reference.startsWith(REFERENCE_PREFIX)
  ) {
    throw invalidReference();
  }

  const encoded = reference.slice(REFERENCE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw invalidReference();
  }

  try {
    const decodedBytes = Buffer.from(encoded, "base64url");
    if (decodedBytes.toString("base64url") !== encoded) {
      throw invalidReference();
    }
    const wire = wireReferenceSchema.parse(JSON.parse(decodedBytes.toString("utf8")) as unknown);
    return {
      version: wire.v,
      accountScope: wire.a,
      mailbox: wire.m,
      uidValidity: wire.u,
      uid: wire.i,
    };
  } catch (error) {
    if (error instanceof MessageReferenceError) {
      throw error;
    }
    throw invalidReference();
  }
}

export function assertCurrentMessageReference(
  reference: string | DecodedMessageReference,
  currentUidValidity: UidValidity,
): DecodedMessageReference {
  const decoded = typeof reference === "string" ? decodeMessageReference(reference) : reference;
  if (decoded.uidValidity !== normalizeUidValidity(currentUidValidity)) {
    throw new StaleMessageReferenceError();
  }
  return decoded;
}

export const encodeMessageRef = encodeMessageReference;
export const decodeMessageRef = decodeMessageReference;
export const validateMessageReference = assertCurrentMessageReference;

