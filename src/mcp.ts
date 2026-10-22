import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { sealedSettingsSchema, type SealedSettingsRequest } from "./settings/sealed-request.js";
import { VERSION } from "./version.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { registerQqMailTools, SETTINGS_RESOURCE_URI, type ToolServices } from "./tools.js";
import type { ToolProfile } from "./tool-profile.js";

export interface SettingsUiProvider {
  readonly origin: string;
  renderAppHtml(): Promise<string>;
  requestFromApp?(input: SealedSettingsRequest, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
}

export function createQqMailMcpServer(
  services: ToolServices,
  settingsUi: SettingsUiProvider | undefined,
  profile: ToolProfile = "interactive",
  allowedTools?: ReadonlySet<string>,
): McpServer {
  if (profile === "interactive" && !settingsUi) throw new TypeError("Interactive QQ Mail requires a settings UI provider.");
  const server = new McpServer({ name: "qq-mail", version: VERSION });

  registerQqMailTools(server, services, profile, allowedTools);
  const settingsToolsAllowed = !allowedTools || ["open_settings", "plugin_settings_read", "plugin_settings_update", "settings_request"]
    .every(name => allowedTools.has(name));
  if (profile === "interactive" && settingsUi && settingsToolsAllowed) {
    server.server.registerCapabilities({ experimental: {
      "openai/settings": { readTool: "plugin_settings_read", updateTool: "plugin_settings_update" },
    } });
    const values = {};
    server.registerTool("plugin_settings_read", {
      title: "QQ 邮箱插件设置", inputSchema: z.strictObject({}),
      outputSchema: z.object({ schema: z.object({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()) }),
        values: z.record(z.string(), z.unknown()), layout: z.array(z.unknown()) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    }, async () => ({ content: [], structuredContent: {
      schema: { type: "object" as const, properties: {} }, values,
      layout: [{ kind: "group", title: "账户与授权码", items: [{ kind: "tool", tool: "open_settings",
        description: "在插件内填写邮箱和授权码；保存时仅需在独立确认窗口确认，无需在该窗口填写。" }] }],
    } }));
    // All editable fields live in the bespoke form: primitive settings cannot represent a password.
    server.registerTool("plugin_settings_update", {
      title: "QQ 邮箱设置入口", inputSchema: z.strictObject({ set: z.strictObject({}) }),
      outputSchema: z.object({ values: z.record(z.string(), z.unknown()) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    }, async () => ({ content: [], structuredContent: { values } }));
    server.registerTool("settings_request", {
      title: "QQ 邮箱加密设置通道", inputSchema: sealedSettingsSchema,
      description: "Encrypted settings form transport. Does not grant approval or accept plaintext credentials, commands, paths or URLs.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    }, async (input, extra) => ({ content: [], _meta: { qqMailSettings: settingsUi.requestFromApp
      ? await settingsUi.requestFromApp(input, extra.signal)
      : { status: 503, body: { ok: false, message: "插件设置通道不可用，请重新加载插件。" } } } }));
  }
  if (profile === "interactive" && settingsUi) registerAppResource(
    server,
    "QQ Mail Settings",
    SETTINGS_RESOURCE_URI,
    {
      _meta: {
        ui: {
          csp: { connectDomains: [settingsUi.origin] },
          prefersBorder: false,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: SETTINGS_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await settingsUi.renderAppHtml(),
          _meta: {
            "openai/ui": { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen" },
            ui: {
              csp: { connectDomains: [settingsUi.origin] },
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );

  return server;
}
