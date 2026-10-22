import { Readable } from "node:stream";
import { SealedSettingsChannel, type SealedSettingsRequest } from "./sealed-request.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConnectionStatus,
  MailEndpointSettings,
  MailFolderSettings,
  MailProvider,
  SettingsActionResult,
  SettingsCallbacks,
  SettingsFormConfig,
  SettingsPublicConfig,
  SettingsRequestContext,
  SettingsSaveRequest,
  SettingsSession,
  SettingsSessionOptions,
  SettingsStatus,
  SettingsTestRequest,
  SettingsProfileRequest,
  SettingsProfiles,
  TransportSecurity,
} from "./types.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 250;
const MAX_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_CLOSE_GRACE_MS = 5_000;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const PROVIDERS = new Set<MailProvider>([
  "personal",
  "enterprise",
  "xinchuang",
  "custom",
]);
const SECURITY_MODES = new Set<TransportSecurity>(["tls", "starttls"]);
const CONNECTION_STATES = new Set(["unknown", "ok", "error"] as const);

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

interface InternalSession {
  expiresAt: number;
  allowOpaqueOrigin: boolean;
  requests: Set<string>;
}

export interface SettingsServerOptions {
  callbacks: SettingsCallbacks;
  html?: string;
  htmlPath?: string;
  sessionTtlMs?: number;
  maxBodyBytes?: number;
  maxCredentialBytes?: number;
  closeGraceMs?: number;
  now?: () => number;
  tokenFactory?: () => string;
}

export class SettingsServer {
  readonly #callbacks: SettingsCallbacks;
  readonly #providedHtml: string | undefined;
  readonly #htmlPath: string | undefined;
  readonly #sessionTtlMs: number;
  readonly #maxBodyBytes: number;
  readonly #maxCredentialBytes: number;
  readonly #closeGraceMs: number;
  readonly #now: () => number;
  readonly #tokenFactory: () => string;
  readonly #sessions = new Map<string, InternalSession>();
  readonly #requestControllers = new Set<AbortController>();
  readonly #sockets = new Set<Socket>();

  readonly #sealedChannel = new SealedSettingsChannel();
  #bridgeActive = 0;
  #server: Server | undefined;
  #template = "";
  #origin = "";
  #closing: Promise<void> | undefined;

  constructor(options: SettingsServerOptions) {
    this.#callbacks = options.callbacks;
    this.#providedHtml = options.html;
    this.#htmlPath = options.htmlPath;
    this.#sessionTtlMs = clampInteger(
      options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      1,
      MAX_SESSION_TTL_MS,
    );
    this.#maxBodyBytes = clampInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      1024,
      1024 * 1024,
    );
    this.#maxCredentialBytes = clampInteger(options.maxCredentialBytes ?? 2048, 64, 8192);
    this.#closeGraceMs = clampInteger(
      options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS,
      1,
      MAX_CLOSE_GRACE_MS,
    );
    this.#now = options.now ?? Date.now;
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  get origin(): string {
    if (!this.#origin) {
      throw new Error("SettingsServer has not been started");
    }
    return this.#origin;
  }

  get running(): boolean {
    return this.#server !== undefined;
  }

  async start(): Promise<this> {
    if (this.#server) {
      return this;
    }

    this.#template = await this.#loadTemplate();
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.headersTimeout = 5_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 1_000;
    server.maxRequestsPerSocket = 50;
    server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });

    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error): void => rejectStart(error);
      server.once("error", onError);
      server.listen(0, LOOPBACK_HOST, () => {
        server.off("error", onError);
        resolveStart();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
      await closeServer(server, this.#sockets, this.#closeGraceMs);
      throw new Error("SettingsServer did not bind to the IPv4 loopback interface");
    }

    this.#server = server;
    this.#origin = `http://${LOOPBACK_HOST}:${address.port}`;
    return this;
  }

  createSession(options: SettingsSessionOptions = {}): SettingsSession {
    const apiBase = this.origin;
    this.#removeExpiredSessions();

    let token = this.#tokenFactory();
    for (let attempt = 0; this.#sessions.has(token) && attempt < 4; attempt += 1) {
      token = this.#tokenFactory();
    }
    if (!token || token.length < 16 || this.#sessions.has(token)) {
      throw new Error("Could not create a unique settings session");
    }

    if (this.#sessions.size >= 64) throw new Error("Too many settings sessions; close old settings and retry later");
    const expiresAtMs = this.#now() + this.#sessionTtlMs;
    this.#sessions.set(token, {
      requests: new Set(),
      expiresAt: expiresAtMs,
      allowOpaqueOrigin: options.allowOpaqueOrigin === true,
    });
    const fragment = new URLSearchParams({ session: token }).toString();
    return Object.freeze({
      token,
      apiBase,
      browserUrl: `${apiBase}/settings#${fragment}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  /** Renders an MCP ui:// resource with a loopback API base and an in-memory bearer token. */
  async renderAppHtml(
    template: string = this.#template,
    session: SettingsSession = this.createSession({ allowOpaqueOrigin: true }),
  ): Promise<string> {
    const internalSession = this.#findActiveSession(session.token);
    if (session.apiBase !== this.origin || !internalSession) {
      throw new Error("Settings session does not belong to this server or has expired");
    }
    internalSession.allowOpaqueOrigin = true;
    return renderTemplate(template, session.apiBase, session.token, createNonce())
      .replaceAll("__QQ_MAIL_BRIDGE_KEY__", jsonLiteral(await this.#sealedChannel.publicKey()));
  }

  async close(): Promise<void> {
    if (this.#closing) {
      return this.#closing;
    }
    const server = this.#server;
    this.#server = undefined;
    this.#origin = "";
    this.#sessions.clear();
    for (const controller of this.#requestControllers) {
      controller.abort();
    }
    this.#requestControllers.clear();
    if (!server) {
      return;
    }
    this.#closing = closeServer(server, this.#sockets, this.#closeGraceMs).finally(() => {
      this.#sockets.clear();
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #loadTemplate(): Promise<string> {
    if (this.#providedHtml !== undefined) {
      return this.#providedHtml;
    }
    if (this.#htmlPath) {
      return readFile(this.#htmlPath, "utf8");
    }

    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(moduleDirectory, "ui", "settings.html"),
      resolve(moduleDirectory, "../../ui/settings.html"),
    ];
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        return await readFile(candidate, "utf8");
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("Could not load ui/settings.html", { cause: lastError });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setNoStoreHeaders(response);
    try {
      this.#validateHost(request);
      const requestUrl = new URL(request.url ?? "/", this.origin);
      const method = request.method ?? "GET";

      if ((requestUrl.pathname === "/" || requestUrl.pathname === "/settings") && method === "GET") {
        this.#validateOptionalOrigin(request);
        const nonce = createNonce();
        const html = renderTemplate(this.#template, this.origin, "", nonce)
          .replaceAll("__QQ_MAIL_BRIDGE_KEY__", jsonLiteral(""));
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Content-Security-Policy", htmlContentSecurityPolicy(this.origin, nonce));
        response.end(html);
        return;
      }

      if (!requestUrl.pathname.startsWith("/api/")) {
        throw new HttpError(404, "Not found");
      }

      if (method === "OPTIONS") {
        this.#handlePreflight(request, response);
        return;
      }

      const context = this.#authorizeApiRequest(request, response, method);
      sendJson(response, 200, await this.#dispatch(request, requestUrl.pathname, method, context));
    } catch (error) {
      if (response.headersSent || response.writableEnded) {
        response.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { ok: false, message: error.publicMessage });
        return;
      }
      // Callback errors can contain server responses or credentials, so never echo them.
      sendJson(response, 500, { ok: false, message: "操作失败，请检查设置后重试。" });
    }
  }

  async #dispatch(request: IncomingMessage, path: string, method: string, context: SettingsRequestContext): Promise<unknown> {
      if (method === "GET" && path === "/api/profiles") {
        if (!this.#callbacks.getProfiles) throw new HttpError(404, "Account profiles are unavailable");
        const value = await this.#callbacks.getProfiles(context);
        return sanitizeProfiles(value);
      }
      if (method === "POST" && path === "/api/profiles") {
        if (!this.#callbacks.changeProfile) throw new HttpError(404, "Account profiles are unavailable");
        const body = await readJsonObject(request, this.#maxBodyBytes);
        rejectCredentialFields(body);
        const result = await this.#callbacks.changeProfile(parseProfileRequest(body), context);
        return sanitizeActionResult(result);
      }
      if (method === "GET" && path === "/api/config") {
        const config = await this.#callbacks.getConfig(context);
        return sanitizePublicConfig(config);
      }
      if (method === "GET" && path === "/api/status") {
        const status = await this.#callbacks.getStatus(context);
        return sanitizeStatus(status);
      }
      if (method === "POST" && path === "/api/credential") {
        const authorizationCode = await readCredential(request, this.#maxCredentialBytes);
        const revision = readString(request.headers["x-qq-mail-account-revision"], 64, "accountRevision");
        if (!/^[a-f0-9-]{36,64}$/u.test(revision)) throw new HttpError(400, "Invalid account revision");
        const result = await this.#callbacks.setCredential(authorizationCode, context, revision);
        return sanitizeCredentialResult(result);
      }
      if (method === "POST" && path === "/api/test") {
        const body = await readJsonObject(request, this.#maxBodyBytes);
        rejectCredentialFields(body);
        const testRequest = parseTestRequest(body);
        const result = await this.#callbacks.test(testRequest, context);
        return sanitizeActionResult(result);
      }
      if (method === "POST" && path === "/api/save") {
        const body = await readJsonObject(request, this.#maxBodyBytes);
        rejectCredentialFields(body);
        const saveRequest: SettingsSaveRequest = { config: parseFormConfig(body.config),
          ...(body.expectedRevision === undefined ? {} : { expectedRevision: readRevision(body.expectedRevision) }) };
        const result = await this.#callbacks.save(saveRequest, context);
        return sanitizeActionResult(result);
      }
      if (method === "POST" && path === "/api/clear") {
        const body = await readJsonObject(request, this.#maxBodyBytes);
        rejectCredentialFields(body);
        const result = await this.#callbacks.clear(context);
        return sanitizeActionResult(result);
      }


    throw new HttpError(405, "Method not allowed");
  }

  /** UI-only sealed transport; shared validators and native approvals also apply here. */
  async requestFromApp(envelope: SealedSettingsRequest, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
    if (this.#bridgeActive >= 4 || signal.aborted || !this.#server) {
      return { status: 409, body: { ok: false, message: "设置请求已取消或正在处理中，请稍后重试。" } };
    }
    this.#bridgeActive++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.#requestControllers.add(controller);
    try {
      let input;
      try { input = await this.#sealedChannel.open(envelope); }
      catch { throw new HttpError(400, "无法验证加密设置请求，请重新打开插件设置。"); }
      if (signal.aborted || controller.signal.aborted) throw new HttpError(409, "设置请求已取消。");
      const session = this.#findActiveSession(input.token);
      if (!session?.allowOpaqueOrigin) throw new HttpError(401, "设置会话已过期，请重新打开插件设置。");
      if (session.requests.has(input.requestId) || session.requests.size >= 512) {
        throw new HttpError(409, "设置请求已使用或会话请求上限已到，请重新打开插件设置。");
      }
      session.requests.add(input.requestId); // Consume before dispatch, including cancelled writes.
      const request = Readable.from(input.body === undefined ? [] : [Buffer.from(input.body)]) as IncomingMessage;
      request.headers = input.headers;
      try { return { status: 200, body: await this.#dispatch(request, input.path, input.method, { signal: controller.signal }) }; }
      finally { request.destroy(); }
    } catch (error) {
      return { status: error instanceof HttpError ? error.status : 500,
        body: { ok: false, message: error instanceof HttpError ? error.publicMessage : "操作失败，请检查设置后重试。" } };
    } finally {
      this.#bridgeActive--;
      signal.removeEventListener("abort", abort);
      this.#requestControllers.delete(controller);
    }
  }

  #validateHost(request: IncomingMessage): void {
    const expectedHost = new URL(this.origin).host;
    if (request.headers.host !== expectedHost) {
      throw new HttpError(403, "Invalid host");
    }
  }

  #validateOptionalOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== this.origin) {
      throw new HttpError(403, "Invalid origin");
    }
  }

  #authorizeApiRequest(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
  ): SettingsRequestContext {
    if (request.headers.origin === "null") {
      setCorsResponseHeaders(response, "null");
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new HttpError(401, "Settings session is missing or expired");
    }
    const token = authorization.slice("Bearer ".length);
    const session = this.#findActiveSession(token);
    if (!session) {
      throw new HttpError(401, "Settings session is missing or expired");
    }

    const origin = request.headers.origin;
    const sameOrigin = origin === this.origin;
    const opaqueAppOrigin = origin === "null" && session.allowOpaqueOrigin;
    const originMayBeOmitted = method === "GET" && origin === undefined;
    if (!sameOrigin && !opaqueAppOrigin && !originMayBeOmitted) {
      throw new HttpError(403, "Invalid origin");
    }
    if (opaqueAppOrigin) {
      setCorsResponseHeaders(response, "null");
    }

    const controller = new AbortController();
    const release = (): void => {
      request.off("aborted", abort);
      response.off("close", abort);
      response.off("finish", release);
      controller.signal.removeEventListener("abort", release);
      this.#requestControllers.delete(controller);
    };
    const abort = (): void => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    response.once("finish", release);
    controller.signal.addEventListener("abort", release, { once: true });
    this.#requestControllers.add(controller);
    return { signal: controller.signal };
  }

  #findActiveSession(candidate: string): InternalSession | undefined {
    if (!candidate) {
      return undefined;
    }
    const candidateBuffer = Buffer.from(candidate);
    for (const [token, session] of this.#sessions) {
      if (session.expiresAt <= this.#now()) {
        this.#sessions.delete(token);
        continue;
      }
      const tokenBuffer = Buffer.from(token);
      if (
        tokenBuffer.length === candidateBuffer.length &&
        timingSafeEqual(tokenBuffer, candidateBuffer)
      ) {
        return session;
      }
    }
    return undefined;
  }

  #handlePreflight(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (origin !== "null" && origin !== this.origin) {
      throw new HttpError(403, "Invalid origin");
    }
    const requestedMethod = request.headers["access-control-request-method"]?.toUpperCase();
    if (requestedMethod !== "GET" && requestedMethod !== "POST") {
      throw new HttpError(405, "CORS method is not allowed");
    }
    const requestedHeaders = (request.headers["access-control-request-headers"] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (
      !requestedHeaders.includes("authorization") ||
      requestedHeaders.some((value) => value !== "authorization" && value !== "content-type")
    ) {
      throw new HttpError(403, "CORS headers are not allowed");
    }
    const allowedOrigin = origin === "null" ? "null" : this.origin;
    setCorsResponseHeaders(response, allowedOrigin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Max-Age", "60");
    if (
      origin === "null" &&
      request.headers["access-control-request-private-network"] === "true"
    ) {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    response.statusCode = 204;
    response.end();
  }

  #removeExpiredSessions(): void {
    const now = this.#now();
    for (const [token, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(token);
      }
    }
  }
}

export async function startSettingsServer(options: SettingsServerOptions): Promise<SettingsServer> {
  return new SettingsServer(options).start();
}

function renderTemplate(template: string, apiBase: string, token: string, nonce: string): string {
  return template
    .replaceAll("__QQ_MAIL_API_BASE__", jsonLiteral(apiBase))
    .replaceAll("__QQ_MAIL_SESSION_TOKEN__", jsonLiteral(token))
    .replaceAll("__QQ_MAIL_CSP_NONCE__", nonce);
}

function jsonLiteral(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function createNonce(): string {
  return randomBytes(18).toString("base64url");
}

function htmlContentSecurityPolicy(origin: string, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src data:",
    `connect-src ${origin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

function setNoStoreHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
}

function setCorsResponseHeaders(response: ServerResponse, origin: string): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", JSON_CONTENT_TYPE);
  response.end(JSON.stringify(value));
}

async function readJsonObject(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    request.resume();
    throw new HttpError(413, "Request body is too large");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      request.resume();
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
  return asRecord(parsed, "Request body");
}

function parseTestRequest(body: Record<string, unknown>): SettingsTestRequest {
  if (body.target !== "imap" && body.target !== "smtp") {
    throw new HttpError(400, "Connection target must be imap or smtp");
  }
  return { target: body.target, config: parseFormConfig(body.config),
    ...(body.expectedRevision === undefined ? {} : { expectedRevision: readRevision(body.expectedRevision) }) };
}

function readRevision(value: unknown): string {
  const revision = readString(value, 64, "expectedRevision");
  if (!/^[a-f0-9-]{36,64}$/u.test(revision)) throw new HttpError(400, "Invalid account revision");
  return revision;
}

function readProfileId(value: unknown): string {
  const id = readString(value, 40, "profileId");
  if (!/^profile_[a-f0-9]{32}$/u.test(id)) throw new HttpError(400, "Invalid account profile");
  return id;
}

function parseProfileRequest(body: Record<string, unknown>): SettingsProfileRequest {
  const action = body.action;
  const keys = action === "create" ? ["action", "name", "config", "expectedRevision"]
    : action === "switch" ? ["action", "profileId", "expectedRevision"]
    : action === "delete" ? ["action", "profileId", "expectedRevision", "replacementProfileId"] : [];
  if (!keys.length || Object.keys(body).some(key => !keys.includes(key))) throw new HttpError(400, "Invalid profile action fields");
  const expectedRevision = readRevision(body.expectedRevision);
  if (action === "create") return { action, expectedRevision, name: readString(body.name, 80, "name"), config: parseFormConfig(body.config) };
  const profileId = readProfileId(body.profileId);
  if (action === "switch") return { action, profileId, expectedRevision };
  return { action: "delete", profileId, expectedRevision,
    ...(body.replacementProfileId === undefined ? {} : { replacementProfileId: readProfileId(body.replacementProfileId) }) };
}

function sanitizeProfiles(value: SettingsProfiles): SettingsProfiles {
  if (!Array.isArray(value.profiles) || value.profiles.length > 20) throw new HttpError(500, "Invalid account profiles");
  return { revision: readRevision(value.revision), activeProfileId: value.activeProfileId === null ? null : readProfileId(value.activeProfileId),
    profiles: value.profiles.map(profile => ({ id: readProfileId(profile.id), name: readString(profile.name, 80, "name"),
      email: readString(profile.email, 320, "email"), credentialStored: readBoolean(profile.credentialStored, "credentialStored") })) };
}

function scopeFields(source: Record<string, unknown>): { accountScope?: string } {
  if (source.accountScope === undefined) return {};
  const accountScope = readString(source.accountScope, 64, "accountScope");
  if (!/^[a-f0-9]{64}$/u.test(accountScope)) throw new HttpError(500, "Invalid account scope");
  return { accountScope };
}

function parseFormConfig(value: unknown): SettingsFormConfig {
  const source = asRecord(value, "config");
  const provider = readEnum(source.provider, PROVIDERS, "provider");
  const config: SettingsFormConfig = {
    provider,
    email: readString(source.email, 320, "email"),
    displayName: readString(source.displayName, 200, "displayName", true),
    imap: parseEndpoint(source.imap, "imap"),
    smtp: parseEndpoint(source.smtp, "smtp"),
    folders: parseFolders(source.folders),
    downloadDirectory: readString(source.downloadDirectory, 4096, "downloadDirectory"),
  };
  return config;
}

function parseEndpoint(value: unknown, name: string): MailEndpointSettings {
  const source = asRecord(value, name);
  return {
    host: readHostname(source.host, `${name}.host`),
    port: readPort(source.port, `${name}.port`),
    security: readEnum(source.security, SECURITY_MODES, `${name}.security`),
    rejectUnauthorized: readTrue(source.rejectUnauthorized, `${name}.rejectUnauthorized`),
  };
}

function parseFolders(value: unknown): MailFolderSettings {
  const source = asRecord(value, "folders");
  return {
    inbox: readString(source.inbox, 1024, "folders.inbox"),
    sent: readString(source.sent, 1024, "folders.sent"),
    drafts: readString(source.drafts, 1024, "folders.drafts"),
    trash: readString(source.trash, 1024, "folders.trash"),
    spam: readString(source.spam, 1024, "folders.spam"),
    archive: readString(source.archive, 1024, "folders.archive", true),
  };
}

function sanitizePublicConfig(value: SettingsPublicConfig): SettingsPublicConfig {
  const source = asRecord(value, "config");
  const updatedAt = readOptionalString(source.updatedAt, 100, "updatedAt");
  const config: SettingsPublicConfig = {
    ...scopeFields(source),
    ...(source.accountRevision === undefined ? {} : { accountRevision: readRevision(source.accountRevision) }),
    ...(source.profileId === undefined ? {} : { profileId: readProfileId(source.profileId) }),
    provider: readEnum(source.provider, PROVIDERS, "provider"),
    email: readString(source.email, 320, "email", true),
    displayName: readString(source.displayName, 200, "displayName", true),
    imap: parseEndpoint(source.imap, "imap"),
    smtp: parseEndpoint(source.smtp, "smtp"),
    folders: parseFolders(source.folders),
    downloadDirectory: readString(source.downloadDirectory, 4096, "downloadDirectory"),
    credentialStored: readBoolean(source.credentialStored, "credentialStored"),
  };
  if (updatedAt !== undefined) {
    config.updatedAt = updatedAt;
  }
  return config;
}

function sanitizeStatus(value: SettingsStatus): SettingsStatus {
  const source = asRecord(value, "status");
  return {
    ...scopeFields(source),
    configured: readBoolean(source.configured, "configured"),
    credentialStored: readBoolean(source.credentialStored, "credentialStored"),
    imap: sanitizeConnectionStatus(source.imap, "imap"),
    smtp: sanitizeConnectionStatus(source.smtp, "smtp"),
    folders: sanitizeConnectionStatus(source.folders, "folders"),
    message: readString(source.message, 500, "message", true),
  };
}

function sanitizeActionResult(value: SettingsActionResult): SettingsActionResult {
  const source = asRecord(value, "result");
  const result: SettingsActionResult = {
    ...scopeFields(source),
    ok: readBoolean(source.ok, "ok"),
    message: readString(source.message, 500, "message", true),
  };
  if (source.accountRevision !== undefined) {
    result.accountRevision = readString(source.accountRevision, 64, "accountRevision");
  }
  if (source.imap !== undefined) {
    result.imap = sanitizeConnectionStatus(source.imap, "imap");
  }
  if (source.smtp !== undefined) {
    result.smtp = sanitizeConnectionStatus(source.smtp, "smtp");
  }
  if (source.folders !== undefined) {
    result.folders = sanitizeConnectionStatus(source.folders, "folders");
  }
  return result;
}

function sanitizeCredentialResult(value: SettingsActionResult): SettingsActionResult {
  const source = asRecord(value, "result");
  const ok = readBoolean(source.ok, "ok");
  return {
    ok,
    message: ok ? "授权码已安全保存" : "授权码保存失败",
  };
}

function sanitizeConnectionStatus(value: unknown, name: string): ConnectionStatus {
  const source = asRecord(value, name);
  const checkedAt = readOptionalString(source.checkedAt, 100, `${name}.checkedAt`);
  const state = readEnum(source.state, CONNECTION_STATES, `${name}.state`);
  const status: ConnectionStatus = {
    state,
    message: readString(source.message, 500, `${name}.message`, true),
  };
  if (checkedAt !== undefined) {
    status.checkedAt = checkedAt;
  }
  return status;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, maxLength: number, name: string, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${name} must be a string`);
  }
  const normalized = value.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maxLength) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return normalized;
}

function readOptionalString(value: unknown, maxLength: number, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return value;
}

function readHostname(value: unknown, name: string): string {
  const hostname = readString(value, 253, name).toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.startsWith("[") ||
    /[\s/:?#@]/u.test(hostname)
  ) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return hostname;
}

function readPort(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new HttpError(400, `${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new HttpError(400, `${name} must be a boolean`);
  }
  return value;
}

function readTrue(value: unknown, name: string): true {
  if (value !== true) {
    throw new HttpError(400, `${name} must be true`);
  }
  return true;
}

function rejectCredentialFields(value: unknown): void {
  const sensitiveNames = new Set([
    "authorizationcode",
    "authcode",
    "credential",
    "credentials",
    "password",
    "secret",
  ]);
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (typeof current !== "object" || current === null) {
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (sensitiveNames.has(key.toLowerCase())) {
        throw new HttpError(400, "Credentials must use the dedicated credential endpoint");
      }
      pending.push(child);
    }
  }
}

async function readCredential(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/octet-stream") {
    throw new HttpError(415, "Credential Content-Type must be application/octet-stream");
  }
  const bytes = await readBody(request, maxBodyBytes);
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new HttpError(400, "Credential is not valid UTF-8");
  }
  if (!value || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(400, "Credential is invalid");
  }
  return value;
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    request.resume();
    throw new HttpError(413, "Request body is too large");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      request.resume();
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function readEnum<T extends string>(value: unknown, values: ReadonlySet<T>, name: string): T {
  if (typeof value !== "string" || !values.has(value as T)) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return value as T;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

async function closeServer(
  server: Server,
  sockets: ReadonlySet<Socket>,
  graceMs: number,
): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    let settled = false;
    const forceCloseTimer = setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.closeAllConnections();
    }, graceMs);
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(forceCloseTimer);
      if (error) {
        rejectClose(error);
      } else {
        resolveClose();
      }
    };
    server.close((error) => finish(error));
    server.closeIdleConnections();
  });
}
