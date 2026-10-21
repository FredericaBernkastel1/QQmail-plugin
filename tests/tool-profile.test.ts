import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createQqMailMcpServer } from "../src/mcp.js";
import { parseToolProfile, type ToolProfile } from "../src/tool-profile.js";
import { SETTINGS_RESOURCE_URI, type ToolServices } from "../src/tools.js";

const connected: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.allSettled(connected.splice(0).map((item) => item.close()));
});

const readNames = [
  "get_account_status", "list_mailboxes", "search_emails", "read_email", "batch_read_emails", "read_email_thread",
];
const draftAndWriteNames = [
  "list_drafts", "get_draft", "prepare_email", "update_draft", "cancel_draft", "send_email", "set_email_flags", "trash_emails",
];
const interactiveOnlyNames = [
  "open_settings", "test_connection", "list_accounts", "switch_account", "select_attachments",
  "list_attachments", "remove_attachments", "download_attachment", "move_emails",
];
const authorizationNames = ["request_mail_authorization", "list_mail_authorizations", "revoke_mail_authorization"];
const writeNames = ["prepare_email", "update_draft", "cancel_draft", "send_email", "set_email_flags", "trash_emails"];
const profiles: ToolProfile[] = ["interactive", "read-only", "authorized"];
const expectedNames: Record<ToolProfile, string[]> = {
  interactive: [...readNames, ...draftAndWriteNames, ...interactiveOnlyNames, ...authorizationNames],
  "read-only": readNames,
  authorized: [...readNames, ...draftAndWriteNames, ...authorizationNames],
};

const grantRequest = {
  actions: ["edit_draft", "send", "trash", "flags"], recipients: ["recipient@example.test"],
  messageRefs: ["synthetic-message"], maxOperations: 10, expiresInSeconds: 300, purpose: "Synthetic authorized mail task",
};
const validArguments: Record<string, Record<string, unknown>> = {
  get_account_status: {}, list_mailboxes: {}, search_emails: {},
  read_email: { messageRef: "synthetic-message" },
  batch_read_emails: { messageRefs: ["synthetic-message"] },
  read_email_thread: { messageRef: "synthetic-message" },
  open_settings: {}, test_connection: {}, list_accounts: {}, switch_account: { profileId: "synthetic-profile" },
  select_attachments: {}, list_attachments: {}, remove_attachments: { attachmentIds: ["att_00000000-0000-4000-8000-000000000000"] },
  download_attachment: { messageRef: "synthetic-message", attachmentId: "1" },
  move_emails: { messageRefs: ["synthetic-message"], destination: "Archive" },
  list_drafts: {}, get_draft: { draftId: "synthetic-draft-0001" },
  prepare_email: { to: ["recipient@example.test"], text: "Synthetic body", authorizationId: "synthetic-grant" },
  update_draft: { draftId: "synthetic-draft-0001", to: ["recipient@example.test"], subject: "Synthetic", text: "Updated", authorizationId: "synthetic-grant" },
  cancel_draft: { draftId: "synthetic-draft-0001", authorizationId: "synthetic-grant" },
  send_email: { draftId: "synthetic-draft-0001", authorizationId: "synthetic-grant" },
  set_email_flags: { messageRefs: ["synthetic-message"], read: true, authorizationId: "synthetic-grant" },
  trash_emails: { messageRefs: ["synthetic-message"], authorizationId: "synthetic-grant" },
  request_mail_authorization: grantRequest,
  list_mail_authorizations: {}, revoke_mail_authorization: { authorizationId: "synthetic-grant" },
};

function fakeServices(): ToolServices {
  return {
    getAccountStatus: vi.fn(async () => ({ configured: false })),
    openSettings: vi.fn(async () => ({ url: "http://127.0.0.1:1234", expiresAt: "2026-10-21T12:00:00.000Z" })),
    testConnection: vi.fn(async () => ({})), listMailboxes: vi.fn(async () => []),
    searchEmails: vi.fn(async () => ({})), readEmail: vi.fn(async () => ({})),
    batchReadEmails: vi.fn(async () => []), readEmailThread: vi.fn(async () => []),
    selectAttachments: vi.fn(async () => ({})), listAttachments: vi.fn(async () => ({})),
    removeAttachments: vi.fn(async () => ({})), listDrafts: vi.fn(async () => ({})),
    getDraft: vi.fn(async () => ({})), updateDraft: vi.fn(async () => ({})),
    cancelDraft: vi.fn(async () => ({})), listAccounts: vi.fn(async () => ({})),
    switchAccount: vi.fn(async () => ({})), prepareEmail: vi.fn(async () => ({})),
    sendEmail: vi.fn(async () => ({})), setEmailFlags: vi.fn(async () => ({})),
    moveEmails: vi.fn(async () => ({})), trashEmails: vi.fn(async () => ({})),
    downloadAttachment: vi.fn(async () => ({})),
    requestMailAuthorization: vi.fn(async () => ({ authorizationId: "synthetic-grant" })),
    listMailAuthorizations: vi.fn(async () => ({ authorizations: [] })),
    revokeMailAuthorization: vi.fn(async () => ({ revoked: true })),
  };
}

async function connect(profile: ToolProfile, services = fakeServices(), provideUi = true) {
  const renderAppHtml = vi.fn(async () => "<!doctype html><title>Should remain private</title>");
  const server = createQqMailMcpServer(services, provideUi ? { origin: "http://127.0.0.1:1234", renderAppHtml } : undefined, profile);
  const client = new Client({ name: "qq-mail-profile-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  connected.push(client, server);
  return { client, services, renderAppHtml };
}

describe("trusted QQ Mail profile selection", () => {
  it("defaults to interactive and accepts exactly one known profile argument", () => {
    expect(parseToolProfile([])).toBe("interactive");
    for (const profile of profiles) expect(parseToolProfile([`--profile=${profile}`])).toBe(profile);
  });

  it("rejects unknown profiles, alternate syntax, duplicate profiles and extra startup arguments", () => {
    for (const args of [
      ["--profile=unknown"], ["--profile="], ["--profile=Authorized"], ["--profile", "read-only"],
      ["authorized"], ["--approved"], ["--profile=read-only", "--profile=interactive"],
      ["--profile=authorized", "--profile=authorized"], ["--profile=authorized", "--approved=true"], [""],
    ]) expect(() => parseToolProfile(args)).toThrow(TypeError);
  });

  it("fails closed if an untyped caller supplies an invalid profile", () => {
    expect(() => createQqMailMcpServer(fakeServices(), undefined, "unknown" as ToolProfile)).toThrow(TypeError);
    expect(() => createQqMailMcpServer(fakeServices(), undefined)).toThrow(TypeError);
  });
});

describe("MCP tool exposure profiles", () => {
  it.each(profiles)("registers only the explicit %s tool surface with strict schemas", async (profile) => {
    const { client } = await connect(profile);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength({ interactive: 26, authorized: 17, "read-only": 6 }[profile]);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...expectedNames[profile]].sort());
    for (const tool of tools) expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
  });

  it.each(profiles)("rejects direct calls to every tool excluded by %s before any service executes", async (profile) => {
    const { client, services } = await connect(profile);
    for (const [name, args] of Object.entries(validArguments)) {
      if (expectedNames[profile].includes(name)) continue;
      expect((await client.callTool({ name, arguments: args })).isError, name).toBe(true);
    }
    for (const service of Object.values(services)) expect(service).not.toHaveBeenCalled();
  });

  it.each(["read-only", "authorized"] as const)("provides no settings resource or UI capability in %s", async (profile) => {
    const { client, renderAppHtml, services } = await connect(profile);
    expect(client.getServerCapabilities()).not.toHaveProperty("resources");
    await expect(client.readResource({ uri: SETTINGS_RESOURCE_URI })).rejects.toThrow();
    await expect(client.listResources()).rejects.toThrow();
    expect(renderAppHtml).not.toHaveBeenCalled();
    expect(services.openSettings).not.toHaveBeenCalled();
    expect((await client.listTools()).tools.every((tool) => tool._meta?.ui === undefined)).toBe(true);
  });

  it.each(["read-only", "authorized"] as const)("initializes %s without constructing a settings provider", async (profile) => {
    const { client } = await connect(profile, fakeServices(), false);
    expect((await client.listTools()).tools).toHaveLength(expectedNames[profile].length);
  });

  it("keeps all six read operations usable in read-only mode", async () => {
    const { client, services } = await connect("read-only");
    for (const name of readNames) expect((await client.callTool({ name, arguments: validArguments[name]! })).isError, name).not.toBe(true);
    for (const name of ["getAccountStatus", "listMailboxes", "searchEmails", "readEmail", "batchReadEmails", "readEmailThread"] as const) {
      expect(services[name]).toHaveBeenCalledOnce();
    }
  });

  it("marks draft creation and attachment snapshot import as writes", async () => {
    const { client } = await connect("interactive");
    const { tools } = await client.listTools();
    for (const name of ["prepare_email", "select_attachments"]) {
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
    }
  });

  it.each(profiles)("cannot change %s or assert approval through undeclared tool arguments", async (profile) => {
    const { client, services } = await connect(profile);
    for (const name of expectedNames[profile]) {
      for (const extra of [{ profile: "interactive" }, { approved: true }, { confirmationRequired: false }]) {
        expect((await client.callTool({ name, arguments: { ...validArguments[name], ...extra } })).isError, name).toBe(true);
      }
    }
    for (const service of Object.values(services)) expect(service).not.toHaveBeenCalled();
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...expectedNames[profile]].sort());
  });
});

describe("authorized mail tool contracts", () => {
  it("requires a bounded nonempty authorization ID on every write before service dispatch", async () => {
    const { client, services } = await connect("authorized");
    const { tools } = await client.listTools();
    for (const name of writeNames) {
      expect(tools.find((tool) => tool.name === name)?.inputSchema.required).toContain("authorizationId");
      const { authorizationId: _ignored, ...args } = validArguments[name]!;
      expect((await client.callTool({ name, arguments: args })).isError, name).toBe(true);
      for (const authorizationId of ["", "x".repeat(257), null, true]) {
        expect((await client.callTool({ name, arguments: { ...args, authorizationId } })).isError, name).toBe(true);
      }
    }
    for (const service of Object.values(services)) expect(service).not.toHaveBeenCalled();
  });

  it.each(["interactive", "authorized"] as const)("passes the authorization reference to the matching service on every %s write", async (profile) => {
    const { client, services } = await connect(profile);
    const mapping = {
      prepare_email: "prepareEmail", update_draft: "updateDraft", cancel_draft: "cancelDraft",
      send_email: "sendEmail", set_email_flags: "setEmailFlags", trash_emails: "trashEmails",
    } as const;
    for (const [name, service] of Object.entries(mapping)) {
      const result = await client.callTool({ name, arguments: validArguments[name]! });
      expect(result.isError, name).not.toBe(true);
      expect(services[service]).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(validArguments[name]!));
    }
  });

  it("preserves interactive write schemas without requiring a grant", async () => {
    const { client } = await connect("interactive");
    const { tools } = await client.listTools();
    for (const name of writeNames) {
      expect(tools.find((tool) => tool.name === name)?.inputSchema.required ?? []).not.toContain("authorizationId");
      const { authorizationId: _ignored, ...args } = validArguments[name]!;
      expect((await client.callTool({ name, arguments: args })).isError, name).not.toBe(true);
    }
  });

  it("preserves draft body and source-reference validation after adding required authorization", async () => {
    const { client, services } = await connect("authorized");
    for (const args of [
      { authorizationId: "synthetic-grant" },
      { authorizationId: "synthetic-grant", mode: "reply", text: "Missing source" },
    ]) expect((await client.callTool({ name: "prepare_email", arguments: args })).isError).toBe(true);
    expect(services.prepareEmail).not.toHaveBeenCalled();
  });

  it.each(["interactive", "authorized"] as const)("dispatches %s authorization management and defaults recipients to an empty list", async (profile) => {
    const { client, services } = await connect(profile);
    const { recipients: _ignored, ...request } = grantRequest;
    const requested = await client.callTool({ name: "request_mail_authorization", arguments: request });
    expect(requested.structuredContent).toMatchObject({ ok: true, data: { authorizationId: "synthetic-grant" } });
    expect(services.requestMailAuthorization).toHaveBeenCalledExactlyOnceWith({ ...request, recipients: [] });
    expect((await client.callTool({ name: "list_mail_authorizations", arguments: {} })).isError).not.toBe(true);
    expect(services.listMailAuthorizations).toHaveBeenCalledOnce();
    expect((await client.callTool({ name: "revoke_mail_authorization", arguments: { authorizationId: "synthetic-grant" } })).isError).not.toBe(true);
    expect(services.revokeMailAuthorization).toHaveBeenCalledExactlyOnceWith({ authorizationId: "synthetic-grant" });
  });

  it("rejects authorization requests outside the fixed schema bounds", async () => {
    const { client, services } = await connect("authorized");
    const invalid: Array<Record<string, unknown>> = [
      { actions: [] }, { actions: ["move"] }, { actions: Array(5).fill("send") },
      { recipients: ["not-an-email"] }, { recipients: Array(21).fill("recipient@example.test") },
      { messageRefs: [] }, { messageRefs: Array(101).fill("synthetic-message") },
      { maxOperations: 0 }, { maxOperations: 101 }, { maxOperations: 1.5 },
      { expiresInSeconds: 59 }, { expiresInSeconds: 86_401 }, { expiresInSeconds: 60.5 },
      { purpose: "" }, { purpose: "   " }, { purpose: "x".repeat(301) },
      { approved: true }, { command: "SYNTHETIC_DO_NOT_EXECUTE" }, { profile: "interactive" },
    ];
    for (const invalidFields of invalid) {
      expect((await client.callTool({ name: "request_mail_authorization", arguments: { ...grantRequest, ...invalidFields } })).isError).toBe(true);
    }
    for (const authorizationId of ["", "x".repeat(257), null]) {
      expect((await client.callTool({ name: "revoke_mail_authorization", arguments: { authorizationId } })).isError).toBe(true);
    }
    expect((await client.callTool({ name: "revoke_mail_authorization", arguments: {} })).isError).toBe(true);
    for (const service of Object.values(services)) expect(service).not.toHaveBeenCalled();
  });

  it("fails safely when legacy services do not implement authorization management", async () => {
    const services = fakeServices();
    delete services.requestMailAuthorization;
    delete services.listMailAuthorizations;
    delete services.revokeMailAuthorization;
    const { client } = await connect("authorized", services);
    for (const name of authorizationNames) {
      const response = await client.callTool({ name, arguments: validArguments[name]! });
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({ ok: false, error: { code: "AUTHORIZATION_UNAVAILABLE" } });
    }
    for (const service of Object.values(services)) expect(service).not.toHaveBeenCalled();
  });
});
