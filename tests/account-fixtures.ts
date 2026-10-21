import { createHash } from "node:crypto";
import type { MailAccountConfig, MailAccountContext } from "../src/mail/types.js";
import { AccountStore, AccountStateError, type AccountStateStorage } from "../src/account-store.js";
import { createConfig, type QqMailConfig } from "../src/config.js";

export function testContext(account: MailAccountConfig, secret = "authorization-code-secret", revision = ""): MailAccountContext {
  const copy = structuredClone(account);
  return {
    account: copy,
    scope: createHash("sha256").update(JSON.stringify([copy, revision])).digest("hex"),
    getAuthorizationCode: async () => secret,
  };
}

export function syntheticConfig(email = "user@qq.com"): QqMailConfig {
  return createConfig({
    preset: "personal", email, downloadDirectory: "C:\\Synthetic\\Downloads",
    inboxMailbox: "INBOX", sentMailbox: "Sent Messages", draftsMailbox: "Drafts",
    trashMailbox: "Deleted Messages", spamMailbox: "Junk", archiveMailbox: "Archive",
  });
}

export function memoryStore(legacy: QqMailConfig | null = null) {
  let raw: string | null = null;
  const storage: AccountStateStorage = {
    read: async () => raw,
    compareAndSwap: async (expected, next) => {
      if (expected !== raw) throw new AccountStateError();
      raw = next;
    },
  };
  // Test-only reversible envelope; never injected by the production server.
  const protection = {
    protect: async (plain: string) => Buffer.from(plain),
    unprotect: async (cipher: Buffer) => cipher.toString(),
  };
  const options = { storage, protection, legacyConfig: async () => legacy };
  return { store: new AccountStore(options), storage, protection, restart: () => new AccountStore(options) };
}
