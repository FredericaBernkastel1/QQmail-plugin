import path from "node:path";

import { mapStoredConfig } from "./account-mapping.js";
import type { AccountRepository } from "../account-store.js";
import { decodeMessageReference, encodeMessageReference } from "../references.js";
import { writeSafeDownload } from "../security.js";
import type {
  AttachmentSaveRequest,
  AttachmentSaveResult,
  AttachmentStorage,
  MailAccountProvider,
  MessageReferenceCodec,
} from "./types.js";

export class StoredMailAccountProvider implements MailAccountProvider {
  constructor(private readonly accounts: Pick<AccountRepository, "snapshot">) {}
  async getContext() {
    const snapshot = await this.accounts.snapshot();
    if (!snapshot.config) return undefined;
    return Object.freeze({
      account: mapStoredConfig(snapshot.config),
      scope: snapshot.scope,
      getAuthorizationCode: () => snapshot.unlock(),
    });
  }
}

export function createStoredMailAccountProvider(
  accounts: Pick<AccountRepository, "snapshot">,
): StoredMailAccountProvider {
  return new StoredMailAccountProvider(accounts);
}

export const coreMessageReferenceCodec: MessageReferenceCodec = Object.freeze({
  encode: encodeMessageReference,
  decode(reference: string) {
    const decoded = decodeMessageReference(reference);
    return {
      accountScope: decoded.accountScope,
      mailbox: decoded.mailbox,
      uidValidity: decoded.uidValidity,
      uid: decoded.uid,
    };
  },
});

export class SafeLocalAttachmentStorage implements AttachmentStorage {
  async save(request: AttachmentSaveRequest): Promise<AttachmentSaveResult> {
    const result = await writeSafeDownload(
      request.rootDirectory,
      request.suggestedName,
      request.content,
      { expectedBytes: request.expectedBytes, maxBytes: request.maxBytes },
    );
    return {
      path: result.path,
      filename: path.basename(result.path),
      bytes: result.bytesWritten,
    };
  }
}

