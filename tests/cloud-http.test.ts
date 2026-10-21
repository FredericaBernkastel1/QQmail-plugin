import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createCloudTokenVerifier, type CloudAuthConfig, type CloudPrincipal, type TokenVerifier } from "../src/cloud/auth.js";
import { CLOUD_HTTP_SERVER_OPTIONS, CLOUD_MAIL_SCOPES, createCloudHttpHandler, type CloudHttpOptions } from "../src/cloud/http.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const publicUrl = "https://mail.example.test/mcp";
const issuer = "https://issuer.example.test";
const principal: CloudPrincipal = {
  subject: "synthetic-owner", clientId: "synthetic-client", scopes: ["mail.read"], expiresAt: 4_000_000_000_000,
};
const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(overrides: Partial<CloudHttpOptions> = {}) {
  const context = new AsyncLocalStorage<CloudPrincipal>();
  const closed = vi.fn();
  const called = vi.fn();
  const signals: AbortSignal[] = [];
  const verifyToken = vi.fn<TokenVerifier>(async () => principal);
  const factory = vi.fn((value: CloudPrincipal) => {
    expect(context.getStore()).toBe(value);
    const server = new McpServer({ name: "synthetic-cloud-mail", version: "1.0.0" });
    const close = server.close.bind(server);
    server.close = async () => { closed(); await close(); };
    server.registerTool("read_synthetic_mail", { inputSchema: z.strictObject({}) }, async () => {
      await Promise.resolve();
      const active = context.getStore();
      called(active);
      return { content: [{ type: "text", text: "Synthetic mail" }], structuredContent: { subject: active?.subject, clientId: active?.clientId } };
    });
    return server;
  });
  const options: CloudHttpOptions = {
    publicUrl, issuer, verifyToken, createServer: factory,
    runWithPrincipal: (value, callback, signal) => {
      signals.push(signal);
      return context.run(value, callback);
    },
    allowedOrigins: ["https://chatgpt.com"], internalHosts: ["internal.example.test"], ...overrides,
  };
  const handler = createCloudHttpHandler(options);
  const server = createServer(CLOUD_HTTP_SERVER_OPTIONS, handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic listener did not bind.");
  const port = address.port;
  const call = (input: {
    method?: string; path?: string; body?: string; headers?: Record<string, string>; incomplete?: boolean;
  } = {}) => new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string; data: any }>((resolve, reject) => {
    const client = request({ hostname: "127.0.0.1", port, path: input.path ?? "/mcp", method: input.method ?? "POST",
      headers: { Host: "mail.example.test", Authorization: "Bearer synthetic-token", "Content-Type": "application/json",
        Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26", ...input.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = undefined; }
        resolve({ status: response.statusCode!, headers: response.headers, text, data });
        if (input.incomplete) client.destroy();
      });
    });
    client.on("error", reject);
    client.setTimeout(4_000, () => { client.destroy(new Error("Synthetic HTTP request timed out.")); });
    if (input.incomplete) client.flushHeaders();
    else client.end(input.body ?? rpc("tools/list"));
  });
  return { call, verifyToken, factory, called, closed, signals, handler, server, port };
}

describe("remote MCP HTTP authentication and request boundaries", () => {
  it("publishes OAuth tool declarations and reauthorization challenges on the actual HTTP wire", async () => {
    const h = await harness({ createServer: () => {
      const server = new McpServer({ name: "synthetic-mail-scopes", version: "1.0.0" });
      server.registerTool("send_email", { inputSchema: z.strictObject({}) }, async () => ({
        isError: true, content: [{ type: "text", text: "Synthetic expired token" }],
        structuredContent: { ok: false, error: { code: "OAUTH_SCOPE_REQUIRED", message: "Synthetic expired token" } },
      }));
      return server;
    } });
    const listed = await h.call();
    expect(listed.data.result.tools[0].securitySchemes).toEqual([{ type: "oauth2", scopes: ["mail.read", "mail.authorize", "mail.send"] }]);
    const result = await h.call({ body: rpc("tools/call", { name: "send_email", arguments: {} }) });
    expect(result.data.result._meta["mcp/www_authenticate"][0]).toContain('error="insufficient_scope"');
  });
  it("serves only public OAuth metadata and a minimal health result without authentication", async () => {
    const h = await harness();
    const metadata = await h.call({ method: "GET", path: "/.well-known/oauth-protected-resource", headers: { Authorization: "" } });
    expect(metadata.status).toBe(200);
    expect(metadata.data).toEqual({ resource: publicUrl, authorization_servers: [issuer], scopes_supported: [...CLOUD_MAIL_SCOPES] });
    const health = await h.call({ method: "GET", path: "/healthz", headers: { Authorization: "" } });
    expect(health.data).toEqual({ ok: true });
    expect(h.verifyToken).not.toHaveBeenCalled();
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated incomplete POST before reading its body or creating MCP", async () => {
    const h = await harness();
    const response = await h.call({ headers: { Authorization: "", "Content-Length": "100000" }, incomplete: true });
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe('Bearer resource_metadata="https://mail.example.test/.well-known/oauth-protected-resource"');
    expect(h.verifyToken).not.toHaveBeenCalled();
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.called).not.toHaveBeenCalled();
  });

  it("maps invalid audience and owner verification failures to sanitized 401 results", async () => {
    const verifyToken = vi.fn<TokenVerifier>(async (token) => { throw new Error(`PRIVATE_FAILURE:${token}`); });
    const h = await harness({ verifyToken });
    for (const token of ["wrong-audience", "wrong-owner"]) {
      const response = await h.call({ headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toContain('error="invalid_token"');
      expect(response.text).not.toContain(token);
      expect(response.text).not.toContain("PRIVATE_FAILURE");
    }
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("requires mail.read and an unexpired principal before parsing or dispatching mail", async () => {
    for (const value of [{ ...principal, scopes: ["mail.send"] }, { ...principal, expiresAt: 1 }]) {
      const h = await harness({ verifyToken: async () => value });
      const response = await h.call({ body: "invalid JSON" });
      expect(response.status).toBe(value.expiresAt === 1 ? 401 : 403);
      expect(h.factory).not.toHaveBeenCalled();
    }
  });

  it("rejects unlisted Origin and Host headers without trusting forwarded host values", async () => {
    const h = await harness();
    for (const headers of [
      { Origin: "https://attacker.example.test" }, { Origin: "null" }, { Origin: "https://chatgpt.com/" },
      { Host: "attacker.example.test", "X-Forwarded-Host": "mail.example.test" },
    ] as Array<Record<string, string>>) {
      expect((await h.call({ headers })).status).toBe(403);
    }
    expect(h.verifyToken).not.toHaveBeenCalled();
    expect(h.factory).not.toHaveBeenCalled();
    expect((await h.call({ headers: { Host: "internal.example.test", Origin: "https://chatgpt.com" } })).status).toBe(200);
  });

  it("does not expose SSE, session deletion, generic CORS or token issuer endpoints", async () => {
    const h = await harness();
    for (const method of ["GET", "DELETE", "OPTIONS"]) {
      const response = await h.call({ method });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe("POST");
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    for (const path of ["/authorize", "/token", "/register", "/settings"]) expect((await h.call({ path })).status).toBe(404);
    expect(h.verifyToken).not.toHaveBeenCalled();
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("bounds declared and streamed bodies and rejects JSON batch requests before MCP creation", async () => {
    const h = await harness();
    expect((await h.call({ headers: { "Content-Length": String(1024 * 1024 + 1) }, incomplete: true })).status).toBe(413);
    expect((await h.call({ body: "x".repeat(1024 * 1024 + 1), headers: { "Transfer-Encoding": "chunked" } })).status).toBe(413);
    for (const body of ["[]", `[${rpc("tools/list")}]`, "null", "invalid JSON"]) expect((await h.call({ body })).status).toBe(400);
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("rejects unexpected content types and compressed request bodies before MCP creation", async () => {
    const h = await harness();
    for (const headers of [{ "Content-Type": "text/plain" }, { "Content-Encoding": "gzip" }] as Array<Record<string, string>>) {
      expect((await h.call({ headers })).status).toBe(415);
    }
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("serves real SDK initialize, tools/list and tools/call with new authenticated transports and cleanup", async () => {
    const h = await harness();
    const initialized = await h.call({ body: rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "synthetic", version: "1.0" } }) });
    expect(initialized.status).toBe(200);
    expect(initialized.data.result.serverInfo.name).toBe("synthetic-cloud-mail");
    const listed = await h.call();
    expect(listed.status).toBe(200);
    expect(listed.data.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["read_synthetic_mail"]);
    const called = await h.call({ body: rpc("tools/call", { name: "read_synthetic_mail", arguments: {} }) });
    expect(called.status).toBe(200);
    expect(called.data.result.structuredContent).toEqual({ subject: principal.subject, clientId: principal.clientId });
    for (const response of [initialized, listed, called]) {
      expect(response.headers["mcp-session-id"]).toBeUndefined();
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.verifyToken).toHaveBeenCalledTimes(3);
    expect(h.factory).toHaveBeenCalledTimes(3);
    expect(h.closed).toHaveBeenCalledTimes(3);
    expect(h.called).toHaveBeenCalledExactlyOnceWith(principal);
    expect(h.signals).toHaveLength(3);
    expect(h.signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("does not treat a session identifier or a prior successful request as authentication", async () => {
    const h = await harness();
    expect((await h.call()).status).toBe(200);
    expect((await h.call({ headers: { Authorization: "", "MCP-Session-Id": "synthetic-prior-session" } })).status).toBe(401);
    expect(h.verifyToken).toHaveBeenCalledOnce();
    expect(h.factory).toHaveBeenCalledOnce();
  });

  it("keeps concurrent request principals isolated in the injected asynchronous context", async () => {
    const verifyToken: TokenVerifier = async (token) => ({ ...principal, clientId: token });
    const h = await harness({ verifyToken });
    const responses = await Promise.all(["client-one", "client-two"].map((token) => h.call({
      headers: { Authorization: `Bearer ${token}` }, body: rpc("tools/call", { name: "read_synthetic_mail", arguments: {} }),
    })));
    expect(responses.map((response) => response.data.result.structuredContent.clientId)).toEqual(["client-one", "client-two"]);
  });

  it("limits in-flight requests to sixteen and releases capacity after cleanup", async () => {
    const full = deferred();
    const release = deferred();
    let entered = 0;
    const verifyToken: TokenVerifier = async () => {
      if (++entered === 16) full.resolve();
      await release.promise;
      return principal;
    };
    const h = await harness({ verifyToken });
    const active = Array.from({ length: 16 }, () => h.call());
    await full.promise;
    expect((await h.call()).status).toBe(503);
    release.resolve();
    expect((await Promise.all(active)).every((response) => response.status === 200)).toBe(true);
    expect((await h.call()).status).toBe(200);
  });

  it("rejects oversized headers at the Node server and hides unexpected factory errors", async () => {
    const h = await harness({ createServer: () => { throw new Error("PRIVATE_FACTORY_DETAILS"); } });
    expect((await h.call({ headers: { "X-Oversized": "x".repeat(20_000) } })).status).toBe(431);
    const response = await h.call();
    expect(response.status).toBe(500);
    expect(response.data).toEqual({ error: "internal_error" });
    expect(response.text).not.toContain("PRIVATE_FACTORY_DETAILS");
  });

  it("closes a late-created MCP server after the client disconnects without dispatching tools", async () => {
    const entered = deferred();
    const release = deferred();
    const disconnected = deferred();
    const closed = deferred();
    const invoked = vi.fn();
    const h = await harness({ createServer: async () => {
      entered.resolve();
      await release.promise;
      const server = new McpServer({ name: "synthetic-late", version: "1.0.0" });
      server.registerTool("read_synthetic_mail", { inputSchema: z.strictObject({}) }, async () => {
        invoked(); return { content: [{ type: "text", text: "Never dispatched" }] };
      });
      const originalClose = server.close.bind(server);
      server.close = async () => { await originalClose(); closed.resolve(); };
      return server;
    } });
    h.server.once("request", (_request, response) => response.once("close", disconnected.resolve));
    const client = request({ hostname: "127.0.0.1", port: h.port, path: "/mcp", method: "POST", headers: {
      Host: "mail.example.test", Authorization: "Bearer synthetic-token", "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    } });
    client.on("error", () => undefined);
    client.end(rpc("tools/call", { name: "read_synthetic_mail", arguments: {} }));
    await entered.promise;
    client.destroy();
    await disconnected.promise;
    release.resolve();
    await closed.promise;
    expect(invoked).not.toHaveBeenCalled();
  });

  it("aborts disconnected tool contexts while holding all sixteen work slots until handlers finish", async () => {
    const entered = deferred();
    const disconnected = deferred();
    const release = deferred();
    const cleaned = deferred();
    const activeSignal = new AsyncLocalStorage<AbortSignal>();
    const signals: AbortSignal[] = [];
    const mutate = vi.fn();
    let startedCount = 0;
    let closedResponses = 0;
    let settledCount = 0;
    let cleanedCount = 0;
    const h = await harness({
      runWithPrincipal: (_value, callback, signal) => {
        signals.push(signal);
        return activeSignal.run(signal, callback);
      },
      createServer: () => {
        const server = new McpServer({ name: "synthetic-cancelled-work", version: "1.0.0" });
        const close = server.close.bind(server);
        server.close = async () => {
          await close();
          cleanedCount++;
          if (cleanedCount === 16) cleaned.resolve();
        };
        server.registerTool("delayed_mutation", { inputSchema: z.strictObject({}) }, async () => {
          if (++startedCount === 16) entered.resolve();
          await release.promise;
          const signal = activeSignal.getStore();
          if (!signal?.aborted) mutate();
          settledCount++;
          return { isError: Boolean(signal?.aborted), content: [{ type: "text", text: "Synthetic work settled" }] };
        });
        return server;
      },
    });
    h.server.on("request", (incoming, response) => {
      if (incoming.headers["x-synthetic-work"] !== "pending") return;
      response.once("close", () => { if (++closedResponses === 16) disconnected.resolve(); });
    });
    const clients = Array.from({ length: 16 }, () => {
      const client = request({ hostname: "127.0.0.1", port: h.port, path: "/mcp", method: "POST", headers: {
        Host: "mail.example.test", Authorization: "Bearer synthetic-token", "Content-Type": "application/json",
        Accept: "application/json, text/event-stream", "X-Synthetic-Work": "pending",
      } });
      client.on("error", () => undefined);
      client.end(rpc("tools/call", { name: "delayed_mutation", arguments: {} }));
      return client;
    });
    await entered.promise;
    for (const client of clients) client.destroy();
    await disconnected.promise;
    expect(signals).toHaveLength(16);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(settledCount).toBe(0);
    expect(cleanedCount).toBe(0);
    expect((await h.call()).status).toBe(503);
    release.resolve();
    await cleaned.promise;
    expect(settledCount).toBe(16);
    expect(mutate).not.toHaveBeenCalled();
    expect((await h.call()).status).toBe(200);
  });

  it("drains disconnected background work and cleanup before allowing shutdown to finish", async () => {
    const entered = deferred();
    const disconnected = deferred();
    const release = deferred();
    let workFinished = false;
    let serverClosed = false;
    let drainFinished = false;
    const h = await harness({ createServer: () => {
      const server = new McpServer({ name: "synthetic-drain", version: "1.0.0" });
      const close = server.close.bind(server);
      server.close = async () => { await close(); serverClosed = true; };
      server.registerTool("pending_delivery", { inputSchema: z.strictObject({}) }, async () => {
        entered.resolve();
        await release.promise;
        workFinished = true;
        return { content: [{ type: "text", text: "Synthetic delivery settled" }] };
      });
      return server;
    } });
    h.server.once("request", (_incoming, response) => response.once("close", disconnected.resolve));
    const client = request({ hostname: "127.0.0.1", port: h.port, path: "/mcp", method: "POST", headers: {
      Host: "mail.example.test", Authorization: "Bearer synthetic-token", "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    } });
    client.on("error", () => undefined);
    client.end(rpc("tools/call", { name: "pending_delivery", arguments: {} }));
    await entered.promise;
    client.destroy();
    await disconnected.promise;
    const drained = h.handler.drain();
    expect(h.handler.drain()).toBe(drained);
    void drained.then(() => { drainFinished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drainFinished).toBe(false);
    expect(workFinished).toBe(false);
    expect(serverClosed).toBe(false);
    expect((await h.call()).status).toBe(503);
    expect(h.verifyToken).toHaveBeenCalledOnce();
    release.resolve();
    await drained;
    expect(workFinished).toBe(true);
    expect(serverClosed).toBe(true);
    expect(drainFinished).toBe(true);
    expect((await h.call()).data).toEqual({ error: "server_draining" });
  });
});

describe("fixed issuer access-token verification", () => {
  let key: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwks: { keys: unknown[] };
  const config: CloudAuthConfig = {
    issuer, jwksUrl: `${issuer}/.well-known/jwks.json`, resource: publicUrl,
    ownerSubject: principal.subject, clientIds: [principal.clientId],
  };
  beforeAll(async () => {
    key = await generateKeyPair("ES256");
    jwks = { keys: [{ ...await exportJWK(key.publicKey), alg: "ES256", use: "sig", kid: "synthetic-key" }] };
  });
  const sign = (claims: JWTPayload = {}, header: Record<string, unknown> = {}) => new SignJWT({
    iss: issuer, aud: publicUrl, sub: principal.subject, client_id: principal.clientId,
    exp: Math.floor(Date.now() / 1000) + 300, scope: "mail.read mail.send", ...claims,
  }).setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "synthetic-key", ...header }).sign(key.privateKey);
  const serveKeys = () => {
    const fetchKeys = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(jwks), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchKeys);
    return fetchKeys;
  };

  it("verifies a signed access token with fixed issuer, audience, owner and OAuth client", async () => {
    const fetchKeys = serveKeys();
    const verify = createCloudTokenVerifier(config);
    const result = await verify(await sign());
    expect(result).toMatchObject({ subject: principal.subject, clientId: principal.clientId, scopes: ["mail.read", "mail.send"] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scopes)).toBe(true);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.expiresAt).toBeLessThan(Date.now() + 301_000);
    expect(fetchKeys).toHaveBeenCalledOnce();
    expect(fetchKeys.mock.calls[0]?.[0]).toBe(config.jwksUrl);
  });

  it("rejects wrong issuer, audience, owner, expiry, client and conflicting client claims", async () => {
    serveKeys();
    const verify = createCloudTokenVerifier(config);
    for (const claims of [
      { iss: "https://other.example.test" }, { aud: "https://other.example.test/mcp" }, { sub: "another-owner" },
      { exp: 1 }, { client_id: "another-client" }, { azp: "another-client" }, { scope: ["mail.read"] },
      { scope: "mail.read\nmail.send" },
    ]) await expect(verify(await sign(claims))).rejects.toThrow();
  });

  it("requires exp and sub, and accepts an allowed azp only when client_id is absent", async () => {
    serveKeys();
    const verify = createCloudTokenVerifier(config);
    for (const field of ["exp", "sub", "client_id"]) {
      const claims: JWTPayload = { iss: issuer, aud: publicUrl, sub: principal.subject, exp: Math.floor(Date.now() / 1000) + 300, client_id: principal.clientId };
      delete claims[field];
      const token = await new SignJWT(claims).setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "synthetic-key" }).sign(key.privateKey);
      await expect(verify(token)).rejects.toThrow();
    }
    const token = await new SignJWT({ iss: issuer, aud: publicUrl, sub: principal.subject, exp: Math.floor(Date.now() / 1000) + 300, azp: principal.clientId, scope: "mail.read" })
      .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "synthetic-key" }).sign(key.privateKey);
    await expect(verify(token)).resolves.toMatchObject({ clientId: principal.clientId });
  });

  it("rejects ID-token types and unsigned or unsupported-algorithm tokens", async () => {
    serveKeys();
    const verify = createCloudTokenVerifier(config);
    await expect(verify(await sign({}, { typ: "JWT" }))).rejects.toThrow();
    const unsigned = `${Buffer.from('{"alg":"none","typ":"at+jwt"}').toString("base64url")}.${Buffer.from('{}').toString("base64url")}.`;
    await expect(verify(unsigned)).rejects.toThrow();
    const hsToken = await new SignJWT({ sub: principal.subject, exp: Math.floor(Date.now() / 1000) + 300 })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).sign(new Uint8Array(32).fill(1));
    await expect(verify(hsToken)).rejects.toThrow();
    const wrongKey = await generateKeyPair("ES256");
    const forged = await new SignJWT({ iss: issuer, aud: publicUrl, sub: principal.subject, exp: Math.floor(Date.now() / 1000) + 300, client_id: principal.clientId })
      .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "synthetic-key" }).sign(wrongKey.privateKey);
    await expect(verify(forged)).rejects.toThrow();
  });

  it("ignores token key URLs and only retrieves the configured JWKS with redirects disabled", async () => {
    const fetchKeys = serveKeys();
    const verify = createCloudTokenVerifier(config);
    await verify(await sign({}, { jku: "https://attacker.example.test/keys", x5u: "https://attacker.example.test/cert" }));
    expect(fetchKeys).toHaveBeenCalledExactlyOnceWith(config.jwksUrl, expect.objectContaining({ redirect: "error", method: "GET" }));
  });

  it("rejects oversized JWKS responses and unsafe endpoint configuration", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 })));
    await expect(createCloudTokenVerifier(config)(await sign())).rejects.toThrow(/too large/u);
    for (const value of ["http://issuer.example.test", "https://user:secret@issuer.example.test", "https://issuer.example.test/#fragment"]) {
      for (const field of ["issuer", "jwksUrl", "resource"]) expect(() => createCloudTokenVerifier({ ...config, [field]: value })).toThrow();
    }
    expect(() => createCloudTokenVerifier({ ...config, ownerSubject: "" })).toThrow();
    expect(() => createCloudTokenVerifier({ ...config, clientIds: [] })).toThrow();
    expect(() => createCloudTokenVerifier({ ...config, clientIds: ["one", "two"] })).toThrow();
  });
});
