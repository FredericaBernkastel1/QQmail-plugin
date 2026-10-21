import type { IncomingMessage, RequestListener, ServerOptions, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CloudPrincipal, TokenVerifier } from "./auth.js";
import { decorateCloudResponse } from "./tool-metadata.js";

export const CLOUD_HTTP_SERVER_OPTIONS = Object.freeze({
  maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 15_000,
  keepAliveTimeout: 5_000, connectionsCheckingInterval: 1_000,
} satisfies ServerOptions);

export const CLOUD_MAIL_SCOPES = Object.freeze([
  "mail.read", "mail.drafts.read", "mail.drafts.write", "mail.send", "mail.trash", "mail.flags.write", "mail.authorize",
]);

export interface CloudHttpOptions {
  /** Public HTTPS MCP endpoint, ending exactly in /mcp. TLS is terminated by the deployment. */
  publicUrl: string;
  issuer: string;
  verifyToken: TokenVerifier;
  createServer(principal: CloudPrincipal): McpServer | Promise<McpServer>;
  runWithPrincipal<T>(principal: CloudPrincipal, callback: () => Promise<T>, signal: AbortSignal): Promise<T>;
  allowedOrigins?: readonly string[];
  /** Exact Host values accepted from an explicitly configured reverse proxy. */
  internalHosts?: readonly string[];
}

export type CloudHttpHandler = RequestListener & {
  /** Stop admitting requests and wait for actual work, including disconnected requests and cleanup. */
  drain(): Promise<void>;
};

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 16;
const BODY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

// The SDK's HTTP class exposes accessor properties whose values include
// undefined; its Transport interface uses exact optional properties instead.
// Forward callbacks through an ordinary Transport without weakening TS checks.
function asTransport(http: StreamableHTTPServerTransport, metadataUrl: string): Transport {
  const transport: Transport = {
    start: () => http.start(),
    send: (message, options) => http.send(decorateCloudResponse(message, metadataUrl), options),
    close: () => http.close(),
  };
  http.onclose = () => transport.onclose?.();
  http.onerror = (error) => transport.onerror?.(error);
  http.onmessage = (message, extra) => transport.onmessage?.(message, extra);
  return transport;
}

function httpsUrl(value: string): URL {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\#]/u.test(value) || /^https:\/\/[^/]*@/iu.test(value)) throw new TypeError("Invalid public HTTPS URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new TypeError("Invalid public HTTPS URL.");
  return url;
}

function respond(response: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.shouldKeepAlive = false;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", Connection: "close", ...headers,
  });
  response.end(JSON.stringify(data));
}

function validateHeaders(request: IncomingMessage, hosts: ReadonlySet<string>, origins: ReadonlySet<string>): void {
  if (request.rawHeaders.length > 128 || request.rawHeaders.reduce((size, value) => size + Buffer.byteLength(value), 0) > 16 * 1024) {
    throw new HttpFailure(431, "headers_too_large");
  }
  const counts = new Map<string, number>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const name of ["host", "origin", "authorization", "content-type", "content-length"]) {
    if ((counts.get(name) ?? 0) > 1) throw new HttpFailure(400, "ambiguous_headers");
  }
  if (typeof request.headers.host !== "string" || !hosts.has(request.headers.host)) throw new HttpFailure(403, "host_not_allowed");
  const origin = request.headers.origin;
  if (origin !== undefined && (typeof origin !== "string" || !origins.has(origin))) throw new HttpFailure(403, "origin_not_allowed");
  if (!request.url || request.url.length > 2048 || !request.url.startsWith("/") || request.url.startsWith("//")) {
    throw new HttpFailure(400, "invalid_request_target");
  }
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) {
    return Promise.reject(new HttpFailure(413, "body_too_large"));
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => fail(new HttpFailure(408, "body_timeout")), BODY_TIMEOUT_MS);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData); request.off("end", onEnd);
      request.off("error", onError); request.off("aborted", onAborted);
      signal.removeEventListener("abort", onAborted);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const fail = (error: HttpFailure) => {
      if (settled) return;
      settled = true;
      request.pause();
      cleanup();
      reject(error);
    };
    const onError = () => fail(new HttpFailure(400, "body_read_failed"));
    const onAborted = () => fail(new HttpFailure(408, "request_aborted"));
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { fail(new HttpFailure(413, "body_too_large")); return; }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      if (settled) return;
      let body: unknown;
      const raw = Buffer.concat(chunks, bytes);
      try { body = JSON.parse(raw.toString("utf8")); }
      catch { raw.fill(0); fail(new HttpFailure(400, "invalid_json")); return; }
      raw.fill(0);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        fail(new HttpFailure(400, "single_jsonrpc_message_required")); return;
      }
      settled = true;
      cleanup();
      resolve(body);
    };
    request.on("data", onData); request.once("end", onEnd);
    request.once("error", onError); request.once("aborted", onAborted);
    signal.addEventListener("abort", onAborted, { once: true });
    if (signal.aborted || request.aborted || request.destroyed) onAborted();
  });
}

/** Attach with http.createServer(CLOUD_HTTP_SERVER_OPTIONS, handler) behind trusted HTTPS ingress. */
export function createCloudHttpHandler(options: CloudHttpOptions): CloudHttpHandler {
  const publicUrl = httpsUrl(options.publicUrl);
  if (publicUrl.pathname !== "/mcp") throw new TypeError("The public MCP URL must end in /mcp.");
  httpsUrl(options.issuer);
  const hosts = new Set([publicUrl.host]);
  for (const host of options.internalHosts ?? []) {
    if (!host || /[\s\\\/?#@]/u.test(host) || new URL(`http://${host}`).host !== host) throw new TypeError("Invalid internal Host allowlist.");
    hosts.add(host);
  }
  const origins = new Set<string>();
  for (const origin of options.allowedOrigins ?? []) {
    if (httpsUrl(origin).origin !== origin) throw new TypeError("Allowed origins must be exact HTTPS origins.");
    origins.add(origin);
  }
  const metadataUrl = `${publicUrl.origin}/.well-known/oauth-protected-resource`;
  const challenge = `Bearer resource_metadata="${metadataUrl}"`;
  const metadata = Object.freeze({ resource: options.publicUrl, authorization_servers: [options.issuer], scopes_supported: CLOUD_MAIL_SCOPES });
  // Capture trusted dependencies once; changing an options object cannot swap a
  // verifier or account context while requests are in flight.
  const { verifyToken, createServer, runWithPrincipal } = options;
  let activeRequests = 0;
  let draining = false;
  let drainPromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    validateHeaders(request, hosts, origins);
    if (request.url === "/healthz" && request.method === "GET") { respond(response, 200, { ok: true }); return; }
    if (request.url === "/.well-known/oauth-protected-resource" && request.method === "GET") { respond(response, 200, metadata); return; }
    if (request.url !== "/mcp") { respond(response, 404, { error: "not_found" }); return; }
    if (request.method !== "POST") { respond(response, 405, { error: "method_not_allowed" }, { Allow: "POST" }); return; }
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) { respond(response, 503, { error: "server_busy" }, { "Retry-After": "1" }); return; }
    activeRequests++;
    const abort = new AbortController();
    let server: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      if (!server && !transport) return Promise.resolve();
      cleanupPromise ??= Promise.allSettled([server?.close(), transport?.close()]).then(() => undefined);
      return cleanupPromise;
    };
    const cancel = (error: HttpFailure) => {
      if (abort.signal.aborted) return;
      abort.abort();
      // Closing the transport does not await the SDK's tool handlers. Keep its
      // response mapping and concurrency slot until that work actually settles.
      respond(response, error.status, { error: error.code });
    };
    const onClose = () => { if (!response.writableFinished) cancel(new HttpFailure(408, "request_aborted")); };
    response.once("close", onClose);
    const timer = setTimeout(() => cancel(new HttpFailure(504, "request_timeout")), REQUEST_TIMEOUT_MS);
    timer.unref();
    const ensureActive = () => {
      if (abort.signal.aborted || response.destroyed) throw new HttpFailure(408, "request_aborted");
    };
    const process = async () => {
      const authorization = request.headers.authorization;
      const match = typeof authorization === "string" && /^Bearer ([A-Za-z0-9._~-]{1,8192})$/iu.exec(authorization);
      if (!match) { respond(response, 401, { error: "unauthorized" }, { "WWW-Authenticate": challenge }); return; }
      let principal: CloudPrincipal;
      try {
        principal = await verifyToken(match[1]!);
        if (!Number.isSafeInteger(principal.expiresAt) || principal.expiresAt <= Date.now()) throw new Error("Expired access token.");
      } catch {
        ensureActive();
        respond(response, 401, { error: "unauthorized" }, { "WWW-Authenticate": `${challenge}, error="invalid_token"` }); return;
      }
      ensureActive();
      if (!principal.scopes.includes("mail.read")) {
        respond(response, 403, { error: "insufficient_scope" }, { "WWW-Authenticate": `${challenge}, error="insufficient_scope", scope="mail.read"` }); return;
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "")) {
        respond(response, 415, { error: "unsupported_media_type" }); return;
      }
      if (request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity") {
        respond(response, 415, { error: "unsupported_content_encoding" }); return;
      }
      const body = await readBody(request, abort.signal);
      ensureActive();
      await runWithPrincipal(principal, async () => {
        ensureActive();
        server = await createServer(principal);
        if (abort.signal.aborted) { await cleanup(); ensureActive(); }
        transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
        await server.connect(asTransport(transport, new URL("/.well-known/oauth-protected-resource", publicUrl).href));
        ensureActive();
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        await transport.handleRequest(request, response, body);
      }, abort.signal);
    };
    try { await process(); }
    finally {
      clearTimeout(timer);
      response.off("close", onClose);
      abort.abort();
      await cleanup();
      activeRequests--;
    }
  };

  const listener: RequestListener = (request, response) => {
    if (draining) { respond(response, 503, { error: "server_draining" }); return; }
    const work = handle(request, response).catch((error: unknown) => {
      const status = error instanceof HttpFailure ? error.status : 500;
      const code = error instanceof HttpFailure ? error.code : "internal_error";
      respond(response, status, { error: code });
    });
    inFlight.add(work);
    const settled = () => { inFlight.delete(work); };
    void work.then(settled, settled);
  };
  return Object.assign(listener, {
    drain: (): Promise<void> => {
      draining = true;
      // No new work is admitted after the synchronous flag change, so this
      // snapshot covers all outstanding handlers and their final cleanup.
      drainPromise ??= Promise.allSettled([...inFlight]).then(() => undefined);
      return drainPromise;
    },
  });
}
