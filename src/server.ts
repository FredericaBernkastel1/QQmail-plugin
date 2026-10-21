import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AccountStore } from "./account-store.js";
import { DraftStore } from "./drafts.js";
import { DraftJournal } from "./draft-journal.js";
import { validateRestoredDraftRecord } from "./mail/service.js";
import { WindowsMailMutationApproval } from "./mail/mutation-approval.js";
import { createAccountProfileServices } from "./profile-service.js";
import { WindowsSendApproval, requestWindowsApprovalDetailed } from "./approval.js";
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
        if (!context || context.account.email !== request.accountEmail) return { status: "unavailable" };
        return requestWindowsApprovalDetailed({
          title: "QQ Mail - Authorize bounded mail automation",
          description: "Grant only a task you explicitly requested. Within these exact actions, targets, expiry and operation count, the agent can act without another popup. SEND permits agent-selected content to ALL listed To/Cc/Bcc recipients. Purpose text is descriptive, not an enforced content rule. Trash is not permanent deletion. This grant expires on process restart; it cannot undo work already dispatched. Do not let an agent click this approval for you.",
          confirmLabel: "Authorize this task",
          expiresAt: new Date(Math.min(request.expiresAt, Date.now() + 120_000)).toISOString(),
          preview: { ...request, expiresAt: new Date(request.expiresAt).toISOString(),
            deliveryAccount: { email: context.account.email, imap: context.account.imap, smtp: context.account.smtp },
            selectedMessages: request.messageRefs.map(ref => coreMessageReferenceCodec.decode(ref)),
          },
        });
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
