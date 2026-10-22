import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { VERSION } from "../src/version.js";

declare global {
  interface Window {
    __QQ_MAIL_MCP_APP__?: App;
    __QQ_MAIL_MCP_APP_STATE__?: "standalone" | "connecting" | "connected" | "failed";
    __QQ_MAIL_SETTINGS_API__?: (path: string, options?: RequestInit) => Promise<unknown>;
  }
}

let connecting: Promise<App> | undefined;
function state(value: NonNullable<Window["__QQ_MAIL_MCP_APP_STATE__"]>) {
  window.__QQ_MAIL_MCP_APP_STATE__ = value;
  document.documentElement.dataset.mcpApp = value;
}
async function connect(): Promise<App> {
  if (window.__QQ_MAIL_MCP_APP__) return window.__QQ_MAIL_MCP_APP__;
  if (connecting) return connecting;
  connecting = (async () => {
    state("connecting");
    const app = new App({ name: "qq-mail-settings", version: VERSION }, {}, { autoResize: true, strict: true });
    try {
      await app.connect(new PostMessageTransport(window.parent, window.parent), { timeout: 10_000 });
      window.__QQ_MAIL_MCP_APP__ = app;
      state("connected");
      return app;
    } catch {
      state("failed");
      await app.close().catch(() => undefined);
      throw new Error("插件连接未就绪。请点击“重新连接”，或重新打开 QQ 邮箱插件设置。");
    } finally { connecting = undefined; }
  })();
  return connecting;
}
const base64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
if (window.parent === window) {
  state("standalone");
} else {
  // Only ciphertext passes through the host; never send form values via model context.
  window.__QQ_MAIL_SETTINGS_API__ = async (path, options = {}) => {
    const app = await connect();
    const bootstrap = JSON.parse(document.getElementById("qq-mail-bootstrap")!.textContent!);
    if (!bootstrap.bridgeKey || !bootstrap.token || !crypto.subtle) {
      throw new Error("当前页面不支持安全设置通道，请重新加载插件后打开设置。");
    }
    const key = await crypto.subtle.importKey("spki", Uint8Array.from(atob(bootstrap.bridgeKey), c => c.charCodeAt(0)),
      { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const aesBytes = crypto.getRandomValues(new Uint8Array(32));
    const aes = await crypto.subtle.importKey("raw", aesBytes, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const headers = new Headers(options.headers);
    if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    const body = options.body instanceof Uint8Array
      ? new TextDecoder("utf-8", { fatal: true }).decode(options.body) : options.body;
    if (body !== undefined && typeof body !== "string") throw new Error("不支持的设置请求。");
    const plain = new TextEncoder().encode(JSON.stringify({ token: bootstrap.token,
      requestId: crypto.randomUUID(), path, method: options.method || "GET",
      headers: Object.fromEntries(headers), ...(body === undefined ? {} : { body }) }));
    let ciphertext: ArrayBuffer, wrapped: ArrayBuffer;
    try {
      ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
        additionalData: new TextEncoder().encode("qq-mail-settings-v1") }, aes, plain);
      wrapped = await crypto.subtle.encrypt("RSA-OAEP", key, aesBytes);
    } finally { aesBytes.fill(0); plain.fill(0); }
    let result;
    try {
      result = await app.callServerTool({ name: "settings_request", arguments: {
        key: base64(new Uint8Array(wrapped!)), iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext!)),
      } }, { timeout: 180_000, maxTotalTimeout: 180_000 });
    } catch {
      throw new Error("插件设置请求未完成，请确认插件仍在运行。保存结果不明时请先重新读取，勿重复提交。");
    }
    const response = result._meta?.qqMailSettings as { status: number; body: { message?: string } } | undefined;
    if (!response || result.isError) throw new Error("插件设置通道不可用，请重新加载插件。");
    if (response.status !== 200) throw new Error(response.body?.message || "设置请求未完成。");
    return response.body;
  };
  void connect().catch(() => undefined);
}
