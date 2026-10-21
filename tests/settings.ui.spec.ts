import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  startSettingsServer,
  type SettingsCallbacks,
  type SettingsFormConfig,
  type SettingsPublicConfig,
  type SettingsServer,
  type SettingsStatus,
} from "../src/settings/index.js";

const uiPath = resolve(import.meta.dirname, "../ui/settings.html");

function initialConfig(): SettingsPublicConfig {
  return {
    provider: "personal",
    email: "user@qq.com",
    displayName: "QQ User",
    imap: { host: "imap.qq.com", port: 993, security: "tls", rejectUnauthorized: true },
    smtp: { host: "smtp.qq.com", port: 465, security: "tls", rejectUnauthorized: true },
    folders: {
      inbox: "INBOX",
      sent: "Sent Messages",
      drafts: "Drafts",
      trash: "Deleted Messages",
      spam: "Junk",
      archive: "Archive",
    },
    downloadDirectory: "C:\\Downloads\\QQ Mail",
    credentialStored: true,
  };
}

function statusFor(config: SettingsPublicConfig): SettingsStatus {
  return {
    configured: Boolean(config.email),
    credentialStored: config.credentialStored,
    imap: { state: "unknown", message: "等待连接测试" },
    smtp: { state: "unknown", message: "等待连接测试" },
    folders: { state: "unknown", message: "等待目录检查" },
    message: config.credentialStored ? "已配置" : "需要授权码",
  };
}

interface UiHarness {
  server: SettingsServer;
  sessionUrl: string;
  appHtml: string;
  credentials: string[];
  saved: SettingsFormConfig[];
  tested: Array<{ target: "imap" | "smtp"; config: SettingsFormConfig }>;
}

async function createHarness(): Promise<UiHarness> {
  let config = initialConfig();
  let status = statusFor(config);
  const credentials: string[] = [];
  const saved: SettingsFormConfig[] = [];
  const tested: Array<{ target: "imap" | "smtp"; config: SettingsFormConfig }> = [];
  const callbacks: SettingsCallbacks = {
    getConfig: async () => config,
    getStatus: async () => status,
    setCredential: async (authorizationCode) => {
      credentials.push(authorizationCode);
      config = { ...config, credentialStored: true };
      status = statusFor(config);
      return { ok: true, message: "授权码已保存" };
    },
    test: async (request) => {
      tested.push(request);
      return {
        ok: true,
        message: `${request.target.toUpperCase()} 连接正常`,
        [request.target]: { state: "ok", message: "连接与认证均正常" },
      };
    },
    save: async ({ config: nextConfig }) => {
      saved.push(nextConfig);
      config = {
        ...nextConfig,
        credentialStored: config.credentialStored,
      };
      status = statusFor(config);
        return { ok: true, message: "设置已保存", accountRevision: "a".repeat(36) };
    },
    clear: async () => {
      config = { ...config, credentialStored: false };
      status = statusFor(config);
      return { ok: true, message: "授权码已清除" };
    },
  };
  const html = await readFile(uiPath, "utf8");
  const server = await startSettingsServer({ callbacks, html });
  const sessionUrl = server.createSession().browserUrl;
  const appHtml = await server.renderAppHtml(html);
  return { server, sessionUrl, appHtml, credentials, saved, tested };
}

async function openSettings(page: Page, harness: UiHarness): Promise<void> {
  await page.goto(harness.sessionUrl);
  await expect(page.getByRole("status", { name: "" }).first()).toBeAttached();
  await expect(page.locator("#overall-status")).toHaveText("已配置");
}

async function openMcpAppInFakeHost(page: Page, harness: UiHarness): Promise<void> {
  await page.setContent(
    '<iframe id="mcp-app" title="QQ 邮箱 MCP App" sandbox="allow-scripts" style="width: 720px; height: 640px"></iframe>',
  );
  await page.evaluate((appHtml) => {
    type JsonRpcMessage = {
      jsonrpc: "2.0";
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
    };
    const hostWindow = window as typeof window & { __mcpMessages?: JsonRpcMessage[] };
    const iframe = document.querySelector<HTMLIFrameElement>("#mcp-app");
    if (!iframe) throw new Error("MCP App iframe was not created");

    hostWindow.__mcpMessages = [];
    window.addEventListener("message", (event) => {
      if (event.source !== iframe.contentWindow) return;
      const message = event.data as JsonRpcMessage;
      if (!message || message.jsonrpc !== "2.0") return;
      hostWindow.__mcpMessages?.push(message);
      if (message.method === "ui/initialize" && message.id !== undefined) {
        iframe.contentWindow?.postMessage(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2026-01-26",
              hostInfo: { name: "playwright-fake-host", version: "1.0.0" },
              hostCapabilities: {},
              hostContext: { locale: "zh-CN", platform: "desktop" },
            },
          },
          "*",
        );
      }
    });
    iframe.srcdoc = appHtml;
  }, harness.appHtml);

  await expect(page.frameLocator("#mcp-app").locator("html")).toHaveAttribute(
    "data-mcp-app",
    "connected",
  );
}

test.describe("QQ Mail settings UI", () => {
  let harness: UiHarness;

  test.beforeEach(async () => {
    harness = await createHarness();
  });

  test.afterEach(async () => {
    await harness.server.close();
  });

  test("loads public settings, clears the fragment, and never refills the authorization code", async ({ page }) => {
    await openSettings(page, harness);

    expect(page.url()).toBe(`${harness.server.origin}/settings`);
    await expect(page.getByLabel("邮箱地址")).toHaveValue("user@qq.com");
    const credentialInput = page.getByLabel("邮箱授权码");
    await expect(credentialInput).toHaveValue("");
    await expect(credentialInput).not.toHaveAttribute("name");
    await expect(page.locator("#credential-state")).toContainText("授权码已安全保存");
    await expect(page.getByRole("radio", { name: "个人邮箱" })).toHaveAttribute("aria-checked", "true");

    await page.getByRole("radio", { name: "企业邮箱" }).click();
    await page.locator("#advanced-settings").click();
    await expect(page.locator("#imap-host")).toHaveValue("imap.exmail.qq.com");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("tests, saves, and clears credentials through the loopback API", async ({ page }) => {
    await openSettings(page, harness);

    await page.getByLabel("邮箱授权码").fill("test-sensitive-code");
    await page.getByRole("button", { name: "测试 IMAP" }).click();
    await expect(page.locator("#imap-status")).toHaveAttribute("data-state", "ok");
    expect(harness.credentials).toEqual(["test-sensitive-code"]);
    expect(harness.tested).toHaveLength(1);
    expect(harness.tested[0]?.config).not.toHaveProperty("authorizationCode");

    await page.getByLabel("邮箱授权码").fill("new-sensitive-code");
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(page.locator("#toast")).toContainText("设置已保存");
    await expect(page.getByLabel("邮箱授权码")).toHaveValue("");
    expect(harness.credentials).toEqual(["test-sensitive-code", "new-sensitive-code"]);
      expect(harness.saved).toHaveLength(2);
    expect(harness.saved[0]).not.toHaveProperty("authorizationCode");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "清除授权码" }).click();
    await expect(page.locator("#credential-state")).toContainText("尚未保存授权码");
  });

  test("connects to an MCP host and reports initialization and size", async ({ page }) => {
    await openMcpAppInFakeHost(page, harness);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const messages = (
            window as typeof window & { __mcpMessages?: Array<{ method?: string }> }
          ).__mcpMessages;
          return messages?.map((message) => message.method) ?? [];
        }),
      )
      .toContain("ui/notifications/initialized");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const messages = (
            window as typeof window & {
              __mcpMessages?: Array<{ method?: string; params?: Record<string, unknown> }>;
            }
          ).__mcpMessages;
          return messages?.find((message) => message.method === "ui/notifications/size-changed")
            ?.params;
        }),
      )
      .toEqual({ width: 720, height: expect.any(Number) });
  });
});
