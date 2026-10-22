import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AccountStore } from "./account-store.js";
import { DraftStore } from "./drafts.js";
import { DraftJournal } from "./draft-journal.js";
import { validateRestoredDraftRecord } from "./mail/service.js";
import { WindowsMailMutationApproval } from "./mail/mutation-approval.js";
import { createAccountProfileServices } from "./profile-service.js";
import { WindowsSendApproval, requestWindowsApprovalDetailed } from "./approval.js";
import { createLocalMailAuthorizationRequest } from "./local-authorization.js";
import { parseToolProfile } from "./tool-profile.js";
import { WindowsAttachmentPicker } from "./attachment-picker.js";
import {
  ImapFlowGateway,
  NodemailerSmtpGateway,
  QqMailService,
  SafeLocalAttachmentStorage,
  coreMessageReferenceCodec,
  createStoredMailAccountProvider,
  type OutgoingMessage,
} from "./mail/index.js";
import { createQqMailMcpServer } from "./mcp.js";
import { createSettingsCallbacks } from "./settings/callbacks.js";
import { SettingsServer } from "./settings/server.js";
import { WindowsSettingsApproval } from "./settings/approval.js";

let settingsServer: SettingsServer | undefined;
let mcpServer: ReturnType<typeof createQqMailMcpServer> | undefined;
let shutdownPromise: Promise<void> | undefined;
let startupPromise: Promise<void> | undefined;
let activeService: QqMailService | undefined;
let draftJournal: DraftJournal<OutgoingMessage, Record<string, unknown>> | undefined;

async function main(): Promise<void> {
  const profile = parseToolProfile(process.argv.slice(2));
  const accountStore = new AccountStore();
  const imapGateway = new ImapFlowGateway();
  const smtpGateway = new NodemailerSmtpGateway();
  const settingsApproval = new WindowsSettingsApproval();
  const draftStore = new DraftStore<OutgoingMessage, Record<string, unknown>>();
  draftJournal = new DraftJournal<OutgoingMessage, Record<string, unknown>>();
  // Read-only startup does not require a draft lock, DPAPI or file ACL work.
  // The service awaits this barrier before the first draft operation.
  const journal = draftJournal;

  if (profile === "interactive") settingsServer = new SettingsServer({
    callbacks: createSettingsCallbacks({
      accountStore,
      imapGateway,
      smtpGateway,
      settingsApproval,
    }),
  });
  await settingsServer?.start();

  const accountProvider = createStoredMailAccountProvider(accountStore);
  const service = Object.assign(
    new QqMailService({
      accountProvider,
      referenceCodec: coreMessageReferenceCodec,
      draftStore,
      initializeDrafts: async () => {
        await journal.attach(draftStore, { validateRecord: validateRestoredDraftRecord, hasAttachments: message => Boolean(message.attachmentIds?.length) });
      },
      attachmentStorage: new SafeLocalAttachmentStorage(),
      sendApproval: new WindowsSendApproval(),
      requireAuthorization: profile === "authorized",
      authorizationApprover: async request => {
        const context = await accountProvider.getContext();
        const presentation = createLocalMailAuthorizationRequest(request, context, coreMessageReferenceCodec);
        return presentation ? requestWindowsApprovalDetailed(presentation) : { status: "unavailable" };
      },
      mutationApproval: new WindowsMailMutationApproval(),
      attachmentPicker: new WindowsAttachmentPicker(),
      imapGateway,
      smtpGateway,
    }),
    {
      openSettings: async () => {
        if (!settingsServer) throw new Error("Settings are disabled for this profile");
        const session = settingsServer.createSession();
        return { url: session.browserUrl, expiresAt: session.expiresAt };
      },
    },
    createAccountProfileServices({ accounts: accountStore, approval: settingsApproval }),
  );
  activeService = service;

  mcpServer = createQqMailMcpServer(service, settingsServer, profile);
  mcpServer.server.onclose = () => {
    void shutdown();
  };
  await mcpServer.connect(new StdioServerTransport());
}

function shutdown(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  shutdownPromise = (async () => {
    const activeMcpServer = mcpServer;
    const activeSettingsServer = settingsServer;
    mcpServer = undefined;
    settingsServer = undefined;

    if (activeMcpServer) {
      delete activeMcpServer.server.onclose;
      await activeMcpServer.close().catch(() => undefined);
    }
    await activeSettingsServer?.close().catch(() => undefined);
    await draftJournal?.close().catch(() => undefined);
    draftJournal = undefined;
    activeService?.dispose();
    activeService = undefined;
  })();
  return shutdownPromise;
}

function handleSignal(exitCode: number): void {
  process.exitCode = exitCode;
  void (startupPromise ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => shutdown());
}

process.once("SIGINT", () => handleSignal(130));
process.once("SIGTERM", () => handleSignal(143));

startupPromise = main();
void startupPromise.catch(async () => {
  process.exitCode = 1;
  await shutdown();
  console.error("QQ Mail MCP server could not start.");
});
