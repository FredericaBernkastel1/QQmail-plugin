import { createServer } from "node:http";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { loadCloudConfig, cloudMailAccount } from "./config.js";
import { CloudAuthority } from "./authority.js";
import { createCloudTokenVerifier } from "./auth.js";
import { createCloudHttpHandler, CLOUD_HTTP_SERVER_OPTIONS } from "./http.js";
import { PortableDraftStorage, KeyFileDraftProtection } from "./storage.js";
import { CloudDelegationBudget } from "./delegation-budget.js";
import { DraftJournal } from "../draft-journal.js";
import { DraftStore } from "../drafts.js";
import { QqMailService, validateRestoredDraftRecord } from "../mail/service.js";
import { ImapFlowGateway, NodemailerSmtpGateway } from "../mail/gateways.js";
import { coreMessageReferenceCodec } from "../mail/adapters.js";
import type { OutgoingMessage } from "../mail/types.js";
import { createQqMailMcpServer } from "../mcp.js";
import { ToolFailure } from "../errors.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]!.startsWith("--config=")) throw new Error("Expected --config=/absolute/private/config.json");
  const config = await loadCloudConfig(args[0]!.slice("--config=".length));
  const master = Buffer.from(config.masterKeyBase64, "base64");
  const protection = new KeyFileDraftProtection(master);
  const account = cloudMailAccount(config);
  // Credential/config revision changes invalidate old references and restored drafts.
  const scope = createHmac("sha256", master).update(JSON.stringify({ account, secret: config.mailbox.authorizationCode,
    issuer: config.oauth.issuer, owner: config.oauth.ownerSubject, client: config.oauth.clientId })).digest("hex");
  const budget = config.delegation ? new CloudDelegationBudget(new PortableDraftStorage(path.join(config.stateDirectory, "delegation")), master, {
    consentId: config.delegation.consentId,
    policyDigest: createHash("sha256").update(JSON.stringify({ delegation: config.delegation, scope })).digest("hex"),
    maxOperations: config.delegation.maxOperations,
  }) : undefined;
  master.fill(0);
  await budget?.initialize();
  const authority = new CloudAuthority(config.delegation, async units => {
    if (!budget) throw new ToolFailure("OWNER_DELEGATION_REQUIRED", "Write delegation is disabled.");
    await budget.reserve(units);
  });
  const drafts = new DraftStore<OutgoingMessage, Record<string, unknown>>();
  const journal = new DraftJournal<OutgoingMessage, Record<string, unknown>>({
    storage: new PortableDraftStorage(path.join(config.stateDirectory, "drafts")), protection,
  });
  const unavailable = async (): Promise<never> => { throw new ToolFailure("CAPABILITY_DISABLED", "This capability is unavailable in the cloud connector."); };
  const service = Object.assign(new QqMailService({
    accountProvider: { getContext: async () => ({ account, scope, getAuthorizationCode: async () => config.mailbox.authorizationCode }) },
    referenceCodec: coreMessageReferenceCodec, draftStore: drafts,
    initializeDrafts: async () => { await journal.attach(drafts, { validateRecord: validateRestoredDraftRecord, hasAttachments: p => Boolean(p.attachmentIds?.length) }); },
    attachmentStorage: { save: unavailable },
    imapGateway: new ImapFlowGateway(), smtpGateway: new NodemailerSmtpGateway(),
    requireAuthorization: true, authorizationApprover: authority.approve, assertWriteAuthority: authority.assertWrite,
  }), { openSettings: unavailable, listAccounts: unavailable, switchAccount: unavailable });
  const verifyToken = createCloudTokenVerifier({ ...config.oauth, clientIds: [config.oauth.clientId], resource: config.publicUrl });
  const handler = createCloudHttpHandler({ publicUrl: config.publicUrl, issuer: config.oauth.issuer, verifyToken,
    allowedOrigins: ["https://chatgpt.com"], internalHosts: [`127.0.0.1:${config.listen.port}`, `localhost:${config.listen.port}`],
    runWithPrincipal: (principal, callback, signal) => authority.run(principal, callback, signal),
    createServer: () => createQqMailMcpServer(service, undefined, "authorized", authority.tools()),
  });
  const server = createServer(CLOUD_HTTP_SERVER_OPTIONS, handler);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const closed = new Promise<void>(resolve => server.once("close", resolve));
    server.close(); server.closeIdleConnections();
    // Do not interrupt an accepted SMTP delivery and then silently permit a retry.
    await closed;
    await handler.drain();
    await journal.close(); service.dispose(); await budget?.close(); protection.dispose();
  };
  process.once("SIGINT", () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void stop().catch(() => { process.exitCode = 1; }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.listen.port, config.listen.host, resolve); });
  console.error("QQ Mail cloud MCP started; TLS ingress and OAuth consent must be configured by the operator.");
}
void main().catch(() => { console.error("QQ Mail cloud MCP startup failed. Check private configuration and state permissions."); process.exitCode = 1; });
