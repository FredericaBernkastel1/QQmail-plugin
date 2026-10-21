import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./version.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { registerQqMailTools, SETTINGS_RESOURCE_URI, type ToolServices } from "./tools.js";

export interface SettingsUiProvider {
  readonly origin: string;
  renderAppHtml(): Promise<string>;
}

export function createQqMailMcpServer(services: ToolServices, settingsUi: SettingsUiProvider): McpServer {
  const server = new McpServer({ name: "qq-mail", version: VERSION });

  registerQqMailTools(server, services);
  registerAppResource(
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
