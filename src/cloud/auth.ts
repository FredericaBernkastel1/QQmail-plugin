import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

export interface CloudAuthConfig {
  issuer: string;
  jwksUrl: string;
  resource: string;
  ownerSubject: string;
  clientIds: readonly string[];
}

export interface CloudPrincipal {
  readonly subject: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** Unix time in milliseconds, matching the service authorization clock. */
  readonly expiresAt: number;
}

export type TokenVerifier = (token: string) => Promise<CloudPrincipal>;

function httpsUrl(value: string): URL {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\#]/u.test(value) || /^https:\/\/[^/]*@/iu.test(value)) throw new TypeError("Invalid OAuth HTTPS URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new TypeError("OAuth endpoints must use HTTPS without credentials or fragments.");
  }
  return url;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/u.test(value);
}

/** Verifies externally issued access tokens; it never issues tokens or trusts token-supplied key URLs. */
export function createCloudTokenVerifier(config: CloudAuthConfig): TokenVerifier {
  const issuerUrl = httpsUrl(config.issuer);
  const jwksUrl = httpsUrl(config.jwksUrl);
  const resourceUrl = httpsUrl(config.resource);
  if (issuerUrl.search || resourceUrl.search || !identifier(config.ownerSubject) ||
      !Array.isArray(config.clientIds) || config.clientIds.length !== 1 ||
      !config.clientIds.every(identifier)) throw new TypeError("Invalid OAuth resource ownership or client configuration.");
  const issuer = config.issuer;
  const resource = config.resource;
  const ownerSubject = config.ownerSubject;
  const clientIds = new Set(config.clientIds);
  const keys = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
    [customFetch]: async (url, options) => {
      // The only network destination comes from trusted startup configuration.
      // Reject redirects and bound the identity provider's response as well.
      const response = await fetch(url, { ...options, redirect: "error" });
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (response.status !== 200 || declared > 1024 * 1024 || !response.body) {
        await response.body?.cancel();
        throw new Error("Invalid OAuth key response.");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error("OAuth key response is too large."); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      return new Response(Buffer.concat(chunks, bytes).toString("utf8"), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  return async (token) => {
    // Restrict compact signed JWTs before any remote key retrieval.
    if (typeof token !== "string" || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
      throw new Error("Invalid access token.");
    }
    const { payload, protectedHeader } = await jwtVerify(token, keys, {
      algorithms: ["RS256", "ES256"], issuer, audience: resource,
      requiredClaims: ["sub", "exp"], typ: "at+jwt", clockTolerance: 0,
    });
    // ID tokens normally use typ JWT. Require the configured access-token
    // profile even when their subject and audience happen to overlap.
    if (protectedHeader.typ !== "at+jwt" || payload.sub !== ownerSubject ||
        !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.exp! * 1000) || payload.exp! <= Math.floor(Date.now() / 1000)) {
      throw new Error("Invalid access token.");
    }
    const clientId = payload.client_id ?? payload.azp;
    if (!identifier(clientId) || !clientIds.has(clientId) ||
        (payload.client_id !== undefined && payload.client_id !== clientId) ||
        (payload.azp !== undefined && payload.azp !== clientId)) throw new Error("Invalid access token.");
    const scope = payload.scope === undefined ? "" : payload.scope;
    if (typeof scope !== "string" || scope.length > 2048 ||
        (scope !== "" && !/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/u.test(scope))) {
      throw new Error("Invalid access token.");
    }
    const scopes = Object.freeze([...new Set(scope ? scope.split(" ") : [])]);
    return Object.freeze({ subject: ownerSubject, clientId, scopes, expiresAt: payload.exp! * 1000 });
  };
}
