import { testContext } from "./account-fixtures.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { DraftStore } from "../src/drafts.js";
import { QqMailService, SafeLocalAttachmentStorage, coreMessageReferenceCodec, type OutgoingMessage } from "../src/mail/index.js";
import { createQqMailMcpServer } from "../src/mcp.js";

describe("actual MCP approval enforcement", () => {
  it("rejects unapproved send even when the client claims approval in extra arguments", async () => {
    const send = vi.fn(async () => { throw Error("Must never reach SMTP"); });
    const service = Object.assign(new QqMailService({
      accountProvider: {
        getContext: async () => testContext({
          email: "synthetic@qq.com", username: "synthetic@qq.com", displayName: "Synthetic",
          imap: { host: "imap.qq.com", port: 993, security: "tls" as const },
          smtp: { host: "smtp.qq.com", port: 465, security: "tls" as const },
          folders: { inbox: "INBOX", sent: "Sent", trash: "Trash" },
          downloadDirectory: "C:\\Synthetic", downloadLimitBytes: 1024,
        }, "SYNTHETIC_ONLY"),
      },
      draftStore: new DraftStore<OutgoingMessage, Record<string, unknown>>(),
      referenceCodec: coreMessageReferenceCodec,
      attachmentStorage: new SafeLocalAttachmentStorage(),
      smtpGateway: { verify: async () => undefined, send },
    }), { openSettings: async () => ({ url: "http://127.0.0.1", expiresAt: new Date().toISOString() }), listAccounts: async () => ({profiles: []}), switchAccount: async () => ({switched:false}) });
    const server = createQqMailMcpServer(service, { origin: "http://127.0.0.1", renderAppHtml: async () => "<html></html>" });
    const client = new Client({ name: "synthetic-approval-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const prepared = await client.callTool({
        name: "prepare_email",
        arguments: { to: ["synthetic@example.com"], subject: "Synthetic", text: "Not sent" },
      });
      const encoded = JSON.stringify(prepared);
      const match = encoded.match(/draft_[0-9a-f-]{36}/);
      expect(match).not.toBeNull();
      const response = await client.callTool({
        name: "send_email", arguments: { draftId: match![0], approved: true, confirmationRequired: false },
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toMatch(/unrecognized|invalid/i);
      const withoutFakeApproval = await client.callTool({
        name: "send_email", arguments: { draftId: match![0] },
      });
      expect(withoutFakeApproval.isError).toBe(true);
      expect(JSON.stringify(withoutFakeApproval)).toContain("DRAFT_APPROVAL_UNAVAILABLE");
      expect(send).not.toHaveBeenCalled();
      expect((await client.listTools()).tools.map(t => t.name)).not.toContain("approve_send");
    } finally { await client.close(); await server.close(); }
  });
});
