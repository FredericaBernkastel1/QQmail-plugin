import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { VERSION } from "../src/version.js";

declare global {
  interface Window {
    __QQ_MAIL_MCP_APP__?: App;
    __QQ_MAIL_MCP_APP_STATE__?: "standalone" | "connecting" | "connected" | "failed";
  }
}

async function connectToMcpHost(): Promise<void> {
  if (window.parent === window) {
    window.__QQ_MAIL_MCP_APP_STATE__ = "standalone";
    document.documentElement.dataset.mcpApp = "standalone";
    return;
  }

  window.__QQ_MAIL_MCP_APP_STATE__ = "connecting";
  document.documentElement.dataset.mcpApp = "connecting";
  const app = new App(
    { name: "qq-mail-settings", version: VERSION },
    {},
    { autoResize: true, strict: true },
  );

  try {
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    window.__QQ_MAIL_MCP_APP__ = app;
    window.__QQ_MAIL_MCP_APP_STATE__ = "connected";
    document.documentElement.dataset.mcpApp = "connected";
  } catch {
    window.__QQ_MAIL_MCP_APP_STATE__ = "failed";
    document.documentElement.dataset.mcpApp = "failed";
    await app.close().catch(() => undefined);
  }
}

void connectToMcpHost();
