import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SettingsServer,
  startSettingsServer,
  type SettingsCallbacks,
  type SettingsFormConfig,
  type SettingsPublicConfig,
  type SettingsStatus,
} from "../src/settings/index.js";

const htmlTemplate = `<!doctype html>
<style nonce="__QQ_MAIL_CSP_NONCE__"></style>
<script nonce="__QQ_MAIL_CSP_NONCE__">
globalThis.bootstrap = { apiBase: __QQ_MAIL_API_BASE__, token: __QQ_MAIL_SESSION_TOKEN__ };
</script>`;

const publicConfig: SettingsPublicConfig = {
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
  updatedAt: "2026-07-24T00:00:00.000Z",
};

const status: SettingsStatus = {
  configured: true,
  credentialStored: true,
  imap: { state: "ok", message: "IMAP 正常", checkedAt: "2026-07-24T00:00:00.000Z" },
  smtp: { state: "unknown", message: "尚未测试" },
  folders: { state: "ok", message: "文件夹映射正常" },
  message: "已配置",
};

const formConfig: SettingsFormConfig = {
  provider: "personal",
  email: "user@qq.com",
  displayName: "QQ User",
  imap: { host: "imap.qq.com", port: 993, security: "tls", rejectUnauthorized: true },
  smtp: { host: "smtp.qq.com", port: 465, security: "tls", rejectUnauthorized: true },
  folders: { ...publicConfig.folders },
  downloadDirectory: "C:\\Downloads\\QQ Mail",
};

function createCallbacks(overrides: Partial<SettingsCallbacks> = {}): SettingsCallbacks {
  return {
    getConfig: vi.fn(async () => publicConfig),
    getStatus: vi.fn(async () => status),
    setCredential: vi.fn(async () => ({ ok: true, message: "授权码已保存" })),
    test: vi.fn(async ({ target }) => ({
      ok: true,
      message: `${target.toUpperCase()} 正常`,
      [target]: { state: "ok", message: "连接正常" },
    })),
    save: vi.fn(async () => ({ ok: true, message: "设置已保存" })),
    clear: vi.fn(async () => ({ ok: true, message: "授权码已清除" })),
    ...overrides,
  };
}

function headers(server: SettingsServer, token: string, includeOrigin = true): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    ...(includeOrigin ? { Origin: server.origin } : {}),
  };
}

async function postJson(
  server: SettingsServer,
  token: string,
  path: string,
  body: unknown,
  includeOrigin = true,
): Promise<Response> {
  return fetch(`${server.origin}${path}`, {
    method: "POST",
    headers: {
      ...headers(server, token, includeOrigin),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function postCredential(
  server: SettingsServer,
  token: string,
  authorizationCode: string,
  contentType = "application/octet-stream",
): Promise<Response> {
  return fetch(`${server.origin}/api/credential`, {
    method: "POST",
    headers: {
      ...headers(server, token),
      "Content-Type": contentType,
      "X-QQ-Mail-Account-Revision": "a".repeat(36),
    },
    body: Buffer.from(authorizationCode, "utf8"),
  });
}

const runningServers = new Set<SettingsServer>();

afterEach(async () => {
  await Promise.all([...runningServers].map((server) => server.close()));
  runningServers.clear();
});

describe("SettingsServer", () => {
  it("exposes only sanitized profile summaries and rejects undeclared profile mutation fields", async () => {
    const profileId = "profile_" + "a".repeat(32);
    const revision = "12345678-1234-4234-8234-123456789abc";
    const changeProfile = vi.fn(async () => ({ ok: true, message: "updated", accountRevision: revision }));
    const server = await startSettingsServer({ callbacks: createCallbacks({
      getProfiles: async () => ({ revision, activeProfileId: profileId,
        profiles: [{ id: profileId, name: "Work", email: "work@qq.com", credentialStored: true, ciphertext: "DO_NOT_RETURN" }] }),
      changeProfile,
    }), html: htmlTemplate });
    runningServers.add(server);
    const session = server.createSession();
    const response = await fetch(`${server.origin}/api/profiles`, { headers: headers(server, session.token) });
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary.profiles[0]).toEqual({ id: profileId, name: "Work", email: "work@qq.com", credentialStored: true });
    const invalid = await postJson(server, session.token, "/api/profiles", {
      action: "switch", profileId, expectedRevision: revision, approved: true,
    });
    expect(invalid.status).toBe(400);
    expect(changeProfile).not.toHaveBeenCalled();
    const valid = await postJson(server, session.token, "/api/profiles", { action: "switch", profileId, expectedRevision: revision });
    expect(valid.status).toBe(200);
    expect(changeProfile).toHaveBeenCalledWith({ action: "switch", profileId, expectedRevision: revision }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("binds only to a random IPv4 loopback port and keeps the session token in the fragment", async () => {
    const server = await startSettingsServer({ callbacks: createCallbacks(), html: htmlTemplate });
    runningServers.add(server);
    const session = server.createSession();

    const origin = new URL(server.origin);
    const browserUrl = new URL(session.browserUrl);
    expect(origin.hostname).toBe("127.0.0.1");
    expect(Number(origin.port)).toBeGreaterThan(0);
    expect(browserUrl.search).toBe("");
    expect(browserUrl.hash).toContain("session=");
    expect(browserUrl.hash).toContain(encodeURIComponent(session.token));
    expect(browserUrl.pathname).toBe("/settings");

    const appHtml = await server.renderAppHtml(htmlTemplate, session);
    expect(appHtml).toContain(JSON.stringify(server.origin));
    expect(appHtml).toContain(JSON.stringify(session.token));
    expect(appHtml).not.toContain("__QQ_MAIL_API_BASE__");
    expect(appHtml).not.toContain("__QQ_MAIL_SESSION_TOKEN__");

    const response = await fetch(session.browserUrl);
    const fallbackHtml = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain(`connect-src ${server.origin}`);
    expect(fallbackHtml).toContain('token: ""');
    expect(fallbackHtml).not.toContain(session.token);
  });

  it("aborts active callbacks and force-closes their sockets during shutdown", async () => {
    let activeSignal: AbortSignal | undefined;
    let resolveCallbackStarted!: () => void;
    const callbackStarted = new Promise<void>((resolve) => {
      resolveCallbackStarted = resolve;
    });
    const callbacks = createCallbacks({
      getConfig: vi.fn((context) => {
        activeSignal = context.signal;
        resolveCallbackStarted();
        return new Promise<SettingsPublicConfig>(() => undefined);
      }),
    });
    const server = await startSettingsServer({
      callbacks,
      html: htmlTemplate,
      closeGraceMs: 20,
    });
    runningServers.add(server);
    const session = server.createSession();
    const requestUrl = new URL(`${server.origin}/api/config`);
    const requestTerminated = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const request = httpRequest(
        {
          hostname: requestUrl.hostname,
          port: requestUrl.port,
          path: requestUrl.pathname,
          method: "GET",
          headers: {
            Host: requestUrl.host,
            Origin: server.origin,
            Authorization: `Bearer ${session.token}`,
          },
        },
        (response) => {
          response.once("aborted", finish);
          response.once("close", finish);
          response.resume();
        },
      );
      request.once("error", finish);
      request.end();
    });

    await callbackStarted;
    let closeTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const boundedClose = new Promise<void>((resolve, reject) => {
        closeTimeout = setTimeout(() => reject(new Error("SettingsServer.close() timed out")), 500);
        void server.close().then(resolve, reject);
      });
      await expect(boundedClose).resolves.toBeUndefined();
    } finally {
      if (closeTimeout) {
        clearTimeout(closeTimeout);
      }
    }

    expect(activeSignal?.aborted).toBe(true);
    await expect(requestTerminated).resolves.toBeUndefined();
  });

  it("requires a live bearer session and rejects foreign origins and hosts", async () => {
    const server = await startSettingsServer({ callbacks: createCallbacks(), html: htmlTemplate });
    runningServers.add(server);
    const session = server.createSession();

    const missingBearer = await fetch(`${server.origin}/api/config`, {
      headers: { Origin: server.origin },
    });
    expect(missingBearer.status).toBe(401);

    const foreignOrigin = await fetch(`${server.origin}/api/config`, {
      headers: { Authorization: `Bearer ${session.token}`, Origin: "https://example.invalid" },
    });
    expect(foreignOrigin.status).toBe(403);

    const missingPostOrigin = await postJson(
      server,
      session.token,
      "/api/clear",
      {},
      false,
    );
    expect(missingPostOrigin.status).toBe(403);

    const wrongHostStatus = await new Promise<number>((resolveStatus, rejectStatus) => {
      const url = new URL(`${server.origin}/api/config`);
      const request = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "GET",
          headers: {
            Host: `localhost:${url.port}`,
            Origin: server.origin,
            Authorization: `Bearer ${session.token}`,
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolveStatus(response.statusCode ?? 0));
        },
      );
      request.on("error", rejectStatus);
      request.end();
    });
    expect(wrongHostStatus).toBe(403);
  });

  it("allows opaque MCP App requests only for app sessions", async () => {
    const server = await startSettingsServer({ callbacks: createCallbacks(), html: htmlTemplate });
    runningServers.add(server);
    const appSession = server.createSession({ allowOpaqueOrigin: true });

    const preflight = await fetch(`${server.origin}/api/config`, {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");

    const appResponse = await fetch(`${server.origin}/api/config`, {
      headers: {
        Authorization: `Bearer ${appSession.token}`,
        Origin: "null",
      },
    });
    expect(appResponse.status).toBe(200);
    expect(appResponse.headers.get("access-control-allow-origin")).toBe("null");

    const browserSession = server.createSession();
    const browserResponse = await fetch(`${server.origin}/api/config`, {
      headers: {
        Authorization: `Bearer ${browserSession.token}`,
        Origin: "null",
      },
    });
    expect(browserResponse.status).toBe(403);
  });

  it("returns only whitelisted public config and status fields", async () => {
    const callbacks = createCallbacks({
      getConfig: vi.fn(async () => ({
        ...publicConfig,
        authorizationCode: "must-not-leak",
        password: "must-not-leak",
      }) as SettingsPublicConfig),
      getStatus: vi.fn(async () => ({ ...status, token: "must-not-leak" }) as SettingsStatus),
    });
    const server = await startSettingsServer({ callbacks, html: htmlTemplate });
    runningServers.add(server);
    const session = server.createSession();

    const configResponse = await fetch(`${server.origin}/api/config`, {
      headers: headers(server, session.token),
    });
    const configText = await configResponse.text();
    expect(configResponse.status).toBe(200);
    expect(configResponse.headers.get("cache-control")).toContain("no-store");
    expect(configText).not.toContain("must-not-leak");
    expect(JSON.parse(configText)).toEqual(publicConfig);

    const statusResponse = await fetch(`${server.origin}/api/status`, {
      headers: headers(server, session.token),
    });
    const statusText = await statusResponse.text();
    expect(statusText).not.toContain("must-not-leak");
    expect(JSON.parse(statusText)).toEqual(status);
  });

  it("returns an empty email address for a first-run unconfigured account", async () => {
    const firstRunConfig: SettingsPublicConfig = {
      ...publicConfig,
      email: "",
      credentialStored: false,
    };
    delete firstRunConfig.updatedAt;
    const server = await startSettingsServer({
      callbacks: createCallbacks({ getConfig: vi.fn(async () => firstRunConfig) }),
      html: htmlTemplate,
    });
    runningServers.add(server);
    const session = server.createSession();

    const response = await fetch(`${server.origin}/api/config`, {
      headers: headers(server, session.token),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(firstRunConfig);
  });

  it("accepts credentials only as octet-stream and sanitizes the callback result", async () => {
    const authorizationCode = "sensitive-auth-code";
    const callbacks = createCallbacks({
      setCredential: vi.fn(async () => ({
        ok: true,
        message: `stored ${authorizationCode}`,
      })),
    });
    const server = await startSettingsServer({ callbacks, html: htmlTemplate });
    runningServers.add(server);
    const session = server.createSession();

    const response = await postCredential(
      server,
      session.token,
      `  ${authorizationCode}  `,
    );
    const responseText = await response.text();
    expect(response.status).toBe(200);
    expect(responseText).not.toContain(authorizationCode);
    expect(JSON.parse(responseText)).toEqual({
      ok: true,
      message: expect.any(String),
    });
    expect(callbacks.setCredential).toHaveBeenCalledWith(
      authorizationCode,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      "a".repeat(36),
    );
  });

  it("rejects a credential body without a saved account revision", async () => {
    const callbacks = createCallbacks();
    const server = await startSettingsServer({ callbacks, html: htmlTemplate });
    runningServers.add(server);
    const session = server.createSession();
    const response = await fetch(`${server.origin}/api/credential`, {
      method: "POST",
      headers: { ...headers(server, session.token), "Content-Type": "application/octet-stream" },
      body: "SYNTHETIC",
    });
    expect(response.status).toBe(400);
    expect(callbacks.setCredential).not.toHaveBeenCalled();
  });

  it("rejects JSON and text credential payloads", async () => {
    const callbacks = createCallbacks();
    const server = await startSettingsServer({ callbacks, html: htmlTemplate });
    runningServers.add(server);
    const session = server.createSession();

    const jsonResponse = await postJson(server, session.token, "/api/credential", {
      authorizationCode: "sensitive-auth-code",
    });
    expect(jsonResponse.status).toBe(415);

    const textResponse = await postCredential(
      server,
      session.token,
      "sensitive-auth-code",
      "text/plain",
    );
    expect(textResponse.status).toBe(415);
    expect(callbacks.setCredential).not.toHaveBeenCalled();
  });

  it("rejects credential-like fields from every JSON action", async () => {
    const callbacks = createCallbacks();
    const server = await startSettingsServer({ callbacks, html: htmlTemplate });
    runningServers.add(server);
    const session = server.createSession();
    const authorizationCode = "sensitive-auth-code";

    const testResponse = await postJson(server, session.token, "/api/test", {
      target: "imap",
      config: { ...formConfig, authorizationCode },
    });
    expect(testResponse.status).toBe(400);
    expect(await testResponse.text()).not.toContain(authorizationCode);
    expect(callbacks.test).not.toHaveBeenCalled();

    const saveResponse = await postJson(server, session.token, "/api/save", {
      config: { ...formConfig, metadata: { password: authorizationCode } },
    });
    expect(saveResponse.status).toBe(400);
    expect(await saveResponse.text()).not.toContain(authorizationCode);
    expect(callbacks.save).not.toHaveBeenCalled();

    const clearResponse = await postJson(server, session.token, "/api/clear", {
      payload: { secret: authorizationCode },
    });
    expect(clearResponse.status).toBe(400);
    expect(await clearResponse.text()).not.toContain(authorizationCode);
    expect(callbacks.clear).not.toHaveBeenCalled();
  });

  it("passes only non-secret form config into test/save/clear callbacks", async () => {
    const callbacks = createCallbacks();
    const server = await startSettingsServer({ callbacks, html: htmlTemplate });
    runningServers.add(server);
    const session = server.createSession();

    const testResponse = await postJson(server, session.token, "/api/test", {
      target: "imap",
      config: formConfig,
    });
    expect(testResponse.status).toBe(200);
    expect(callbacks.test).toHaveBeenCalledWith(
      { target: "imap", config: formConfig },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const saveResponse = await postJson(server, session.token, "/api/save", {
      config: formConfig,
    });
    expect(saveResponse.status).toBe(200);
    expect(callbacks.save).toHaveBeenCalledWith(
      { config: formConfig },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const clearResponse = await postJson(server, session.token, "/api/clear", {});
    expect(clearResponse.status).toBe(200);
    expect(callbacks.clear).toHaveBeenCalledOnce();
  });

  it("limits JSON bodies and rejects invalid or weakened TLS settings", async () => {
    const callbacks = createCallbacks();
    const server = await startSettingsServer({
      callbacks,
      html: htmlTemplate,
      maxBodyBytes: 1024,
    });
    runningServers.add(server);
    const session = server.createSession();

    const oversized = await postJson(server, session.token, "/api/clear", {
      padding: "x".repeat(1100),
    });
    expect(oversized.status).toBe(413);

    const invalid = await postJson(server, session.token, "/api/save", {
      config: { ...formConfig, imap: { ...formConfig.imap, port: 70000 } },
    });
    expect(invalid.status).toBe(400);

    const plaintext = await postJson(server, session.token, "/api/save", {
      config: { ...formConfig, imap: { ...formConfig.imap, security: "plain" } },
    });
    expect(plaintext.status).toBe(400);

    const insecureTls = await postJson(server, session.token, "/api/save", {
      config: {
        ...formConfig,
        smtp: { ...formConfig.smtp, rejectUnauthorized: false },
      },
    });
    expect(insecureTls.status).toBe(400);
    expect(callbacks.save).not.toHaveBeenCalled();

    const wrongContentType = await fetch(`${server.origin}/api/clear`, {
      method: "POST",
      headers: headers(server, session.token),
      body: "{}",
    });
    expect(wrongContentType.status).toBe(415);
  });

  it("expires sessions without exposing callback errors", async () => {
    let now = Date.parse("2026-07-24T00:00:00.000Z");
    const callbacks = createCallbacks({
      getConfig: vi.fn(async () => {
        throw new Error("authorizationCode=sensitive-auth-code");
      }),
    });
    const server = await startSettingsServer({
      callbacks,
      html: htmlTemplate,
      now: () => now,
      sessionTtlMs: 100,
      tokenFactory: () => "test-session-token-1234567890",
    });
    runningServers.add(server);
    const session = server.createSession();

    const callbackFailure = await fetch(`${server.origin}/api/config`, {
      headers: headers(server, session.token),
    });
    const failureText = await callbackFailure.text();
    expect(callbackFailure.status).toBe(500);
    expect(failureText).not.toContain("sensitive-auth-code");

    now += 101;
    const expired = await fetch(`${server.origin}/api/status`, {
      headers: headers(server, session.token),
    });
    expect(expired.status).toBe(401);
  });
});
