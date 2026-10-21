export {
  ImapFlowGateway,
  NodemailerSmtpGateway,
  assertSecureServerConfig,
  compileOutgoingMessage,
} from "./gateways.js";
export {
  SafeLocalAttachmentStorage,
  StoredMailAccountProvider,
  coreMessageReferenceCodec,
  createStoredMailAccountProvider,
} from "./adapters.js";
export {
  deduplicateAddresses,
  flattenAttachmentParts,
  htmlToSafeText,
  normalizeEmailAddress,
  normalizeEnvelopeAddresses,
  normalizeOutgoingAddresses,
  parseIncomingMessage,
  prefixSubject,
  sanitizeMessageId,
  validateHeaderText,
} from "./mime.js";
export { QqMailService, type QqMailServiceOptions } from "./service.js";
export type * from "./types.js";
