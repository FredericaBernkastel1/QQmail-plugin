import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { MailAccountConfig } from "../mail/types.js";
import { normalizeMailAuthorizationAddress } from "../mail-authorization.js";

const https = z.string().url().refine(value => {
  const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search;
});
const server = z.strictObject({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535), security: z.literal("tls") });
export const cloudConfigSchema = z.strictObject({
  schemaVersion: z.literal(1), publicUrl: https,
  listen: z.strictObject({ host: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"), port: z.number().int().min(1024).max(65535).default(8787) }).default({ host: "127.0.0.1", port: 8787 }),
  oauth: z.strictObject({ issuer: https, jwksUrl: https, ownerSubject: z.string().min(1).max(256), clientId: z.string().min(1).max(256) }),
  mailbox: z.strictObject({ email: z.string().email(), displayName: z.string().max(200).default(""),
    authorizationCode: z.string().min(1).max(1024).refine(v => !/[\r\n\0]/u.test(v)), imap: server, smtp: server,
    folders: z.strictObject({ inbox: z.string().min(1).max(1024), sent: z.string().min(1).max(1024), trash: z.string().min(1).max(1024) }),
  }),
  stateDirectory: z.string().refine(value => path.isAbsolute(value)),
  masterKeyBase64: z.string().refine(value => { const key = Buffer.from(value, "base64"); return key.length === 32 && key.toString("base64") === value; }),
  delegation: z.strictObject({ consentId: z.string().min(16).max(128), expiresAt: z.string().datetime(),
    actions: z.array(z.enum(["edit_draft", "send", "trash", "flags"])).min(1).max(4),
    recipients: z.array(z.string().email().max(320)).max(20).default([]).transform(values => [...new Set(values.map(normalizeMailAuthorizationAddress))]), maxOperations: z.number().int().min(1).max(100),
  }).optional(),
});
export type CloudConfig = z.infer<typeof cloudConfigSchema>;

/** Operator-mounted secret only. Never accepts configuration through MCP input. */
export async function loadCloudConfig(file: string): Promise<CloudConfig> {
  if (!path.isAbsolute(file)) throw new Error("Cloud secret path must be absolute");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 ||
      (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("Cloud configuration must be a private regular file");
  const bytes = await readFile(file);
  try {
    const result = cloudConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (new URL(result.publicUrl).pathname !== "/mcp") throw new Error("Cloud endpoint must use /mcp");
    if (result.delegation?.actions.includes("send") && !result.delegation.recipients.length) throw new Error("Send delegation needs exact allowed recipients");
    return result;
  } finally { bytes.fill(0); }
}

export function cloudMailAccount(config: CloudConfig): MailAccountConfig {
  return { email: config.mailbox.email, username: config.mailbox.email, displayName: config.mailbox.displayName,
    imap: { ...config.mailbox.imap }, smtp: { ...config.mailbox.smtp }, folders: { ...config.mailbox.folders },
    attachmentsDisabled: true, downloadDirectory: "", downloadLimitBytes: 100 * 1024 * 1024 };
}
