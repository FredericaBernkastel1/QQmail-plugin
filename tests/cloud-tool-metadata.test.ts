import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decorateCloudResponse } from "../src/cloud/tool-metadata.js";
import * as profiles from "../src/tool-profile.js";

const metadataUrl = "https://mail.example.test/.well-known/oauth-protected-resource";
afterEach(() => { vi.restoreAllMocks(); });
function response(result: Record<string, unknown>): JSONRPCMessage { return { jsonrpc: "2.0", id: 7, result }; }
function result(message: JSONRPCMessage): Record<string, any> {
  if (!("result" in message)) throw new Error("Expected response");
  return message.result;
}
const expected: Record<string, string[]> = {
  get_account_status: ["mail.read"], list_mailboxes: ["mail.read"], search_emails: ["mail.read"],
  read_email: ["mail.read"], batch_read_emails: ["mail.read"], read_email_thread: ["mail.read"],
  list_drafts: ["mail.read", "mail.drafts.read"], get_draft: ["mail.read", "mail.drafts.read"],
  prepare_email: ["mail.read", "mail.authorize", "mail.drafts.write"],
  update_draft: ["mail.read", "mail.authorize", "mail.drafts.write"],
  cancel_draft: ["mail.read", "mail.authorize", "mail.drafts.write"],
  send_email: ["mail.read", "mail.authorize", "mail.send"],
  set_email_flags: ["mail.read", "mail.authorize", "mail.flags.write"],
  trash_emails: ["mail.read", "mail.authorize", "mail.trash"],
  request_mail_authorization: ["mail.read", "mail.authorize"],
  list_mail_authorizations: ["mail.read", "mail.authorize"],
  revoke_mail_authorization: ["mail.read", "mail.authorize"],
};

describe("cloud OAuth wire metadata", () => {
  it("advertises exact OAuth scope requirements at both supported descriptor locations", () => {
    const names = profiles.getToolNamesForProfile("authorized");
    expect(names).toHaveLength(17);
    expect([...names].sort()).toEqual(Object.keys(expected).sort());
    const tools = names.map(name => ({ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: name === "read_email" }, _meta: { "synthetic/preserved": true } }));
    const original = response({ tools, nextCursor: "synthetic-next", _meta: { "synthetic/result": true } });
    const before = structuredClone(original);
    const decorated = result(decorateCloudResponse(original, metadataUrl));
    for (const tool of decorated.tools) {
      const scheme = [{ type: "oauth2", scopes: expected[tool.name] }];
      expect(tool.securitySchemes).toEqual(scheme);
      expect(tool._meta.securitySchemes).toEqual(scheme);
      expect(tool._meta["synthetic/preserved"]).toBe(true);
      expect(tool.inputSchema).toEqual({ type: "object" });
      expect(tool.annotations).toEqual({ readOnlyHint: tool.name === "read_email" });
    }
    expect(decorated.nextCursor).toBe("synthetic-next");
    expect(decorated._meta).toEqual({ "synthetic/result": true });
    expect(original).toEqual(before);
  });

  it("replaces stale no-auth declarations with the reviewed requirements", () => {
    const original = response({ tools: [{ name: "send_email", securitySchemes: [{ type: "noauth" }], _meta: { securitySchemes: [{ type: "noauth" }], extra: 4 } }] });
    const tool = result(decorateCloudResponse(original, metadataUrl)).tools[0];
    expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: expected.send_email }]);
    expect(tool._meta).toEqual({ extra: 4, securitySchemes: tool.securitySchemes });
    expect(result(original).tools[0].securitySchemes).toEqual([{ type: "noauth" }]);
  });

  it("does not invent OAuth policy for unknown tools", () => {
    const unknown = { name: "future_unknown_tool", description: "Unreviewed", _meta: { keep: true } };
    const dangerousName = { name: "__proto__", description: "Unknown" };
    const decorated = result(decorateCloudResponse(response({ tools: [unknown, dangerousName] }), metadataUrl));
    expect(decorated.tools).toEqual([unknown, dangerousName]);
    expect(decorated.tools[0]).not.toHaveProperty("securitySchemes");
    expect(decorated.tools[1]).not.toHaveProperty("securitySchemes");
  });

  it("fails closed if an allowed profile tool lacks a reviewed scope mapping", () => {
    const names = profiles.getToolNamesForProfile("authorized");
    vi.spyOn(profiles, "getToolNamesForProfile").mockReturnValue([...names, "newly_allowed_tool"]);
    expect(() => decorateCloudResponse(response({ tools: [{ name: "newly_allowed_tool" }] }), metadataUrl))
      .toThrow("no reviewed OAuth scope mapping");
  });

  it("rejects malformed known descriptors instead of silently losing existing metadata", () => {
    expect(() => decorateCloudResponse(response({ tools: [{ name: "send_email", _meta: "wrong" }] }), metadataUrl)).toThrow();
    expect(() => decorateCloudResponse(response({ tools: [null] }), metadataUrl)).toThrow();
  });

  it("describes cloud delegation without requesting a Windows confirmation or unavailable attachments", () => {
    const decorated = result(decorateCloudResponse(response({ tools: [
      { name: "request_mail_authorization", description: "Show a Windows confirmation" },
      { name: "send_email", description: "Show a Windows confirmation" },
      { name: "prepare_email", description: "Select attachments from the desktop" },
      { name: "trash_emails", description: "Show a Windows confirmation" },
    ] }), metadataUrl));
    expect(decorated.tools.map((tool: { description: string }) => tool.description).join(" ")).not.toMatch(/Windows|desktop/u);
    expect(decorated.tools[0].description).toContain("persistent total budget");
    expect(decorated.tools[0].description).toContain("does not obtain new human consent");
    expect(decorated.tools[2].description).toContain("Cloud attachments are unavailable");
  });

  it("adds the OAuth linking challenge only to a structured scope error while preserving its result", () => {
    const original = response({
      isError: true, content: [{ type: "text", text: "Sanitized scope error" }],
      structuredContent: { ok: false, error: { code: "OAUTH_SCOPE_REQUIRED", message: "Do not reflect this into headers" } },
      _meta: { "synthetic/keep": { value: 1 } },
    });
    const before = structuredClone(original);
    const decorated = result(decorateCloudResponse(original, metadataUrl));
    expect(decorated.content).toEqual(result(original).content);
    expect(decorated.structuredContent).toEqual(result(original).structuredContent);
    expect(decorated._meta["synthetic/keep"]).toEqual({ value: 1 });
    expect(decorated._meta["mcp/www_authenticate"]).toEqual([
      `Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", error_description="A current access token with the required mail permissions is necessary."`,
    ]);
    expect(original).toEqual(before);
  });

  it("does not challenge ordinary failures, successful content or unrelated protocol messages", () => {
    const messages: JSONRPCMessage[] = [
      response({ isError: true, structuredContent: { error: { code: "DRAFT_APPROVAL_REQUIRED" } } }),
      response({ isError: false, structuredContent: { error: { code: "OAUTH_SCOPE_REQUIRED" } } }),
      response({ isError: true, content: [{ type: "text", text: "OAUTH_SCOPE_REQUIRED" }] }),
      { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Unknown method" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    for (const message of messages) expect(decorateCloudResponse(message, metadataUrl)).toBe(message);
  });

  for (const url of ["http://mail.example.test/metadata", "https://user:secret@mail.example.test/metadata", "https://mail.example.test/metadata#fragment", "https://mail.example.test/metadata?token=secret", 'https://mail.example.test/"header', "https://mail.example.test/\r\nheader"]) {
    it(`rejects an unsafe challenge metadata URL ${JSON.stringify(url)}`, () => {
      expect(() => decorateCloudResponse(response({ isError: true, structuredContent: { error: { code: "OAUTH_SCOPE_REQUIRED" } } }), url)).toThrow();
    });
  }
});
