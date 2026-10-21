export type Awaitable<T> = T | Promise<T>;

export type MailProvider = "personal" | "enterprise" | "xinchuang" | "custom";
export type TransportSecurity = "tls" | "starttls";
export type ConnectionState = "unknown" | "ok" | "error";

export interface MailEndpointSettings {
  host: string;
  port: number;
  security: TransportSecurity;
  rejectUnauthorized: true;
}

export interface MailFolderSettings {
  inbox: string;
  sent: string;
  drafts: string;
  trash: string;
  spam: string;
  archive: string;
}

/** Public, persisted settings. This type deliberately has no credential field. */
export interface SettingsPublicConfig {
  accountScope?: string;
  accountRevision?: string;
  profileId?: string;
  provider: MailProvider;
  email: string;
  displayName: string;
  imap: MailEndpointSettings;
  smtp: MailEndpointSettings;
  folders: MailFolderSettings;
  downloadDirectory: string;
  credentialStored: boolean;
  updatedAt?: string;
}

/** Mutable, non-secret form values. Credentials are never part of config JSON. */
export interface SettingsFormConfig {
  provider: MailProvider;
  email: string;
  displayName: string;
  imap: MailEndpointSettings;
  smtp: MailEndpointSettings;
  folders: MailFolderSettings;
  downloadDirectory: string;
}

export interface ConnectionStatus {
  state: ConnectionState;
  message: string;
  checkedAt?: string;
}

export interface SettingsStatus {
  accountScope?: string;
  configured: boolean;
  credentialStored: boolean;
  imap: ConnectionStatus;
  smtp: ConnectionStatus;
  folders: ConnectionStatus;
  message: string;
}

export interface SettingsActionResult {
  ok: boolean;
  message: string;
  accountRevision?: string;
  accountScope?: string;
  imap?: ConnectionStatus;
  smtp?: ConnectionStatus;
  folders?: ConnectionStatus;
}

export interface SettingsTestRequest {
  target: "imap" | "smtp";
  config: SettingsFormConfig;
  expectedRevision?: string;
}

export interface SettingsSaveRequest {
  config: SettingsFormConfig;
  expectedRevision?: string;
}

export interface SettingsProfiles {
  revision: string;
  activeProfileId: string | null;
  profiles: { id: string; name: string; email: string; credentialStored: boolean }[];
}
export type SettingsProfileRequest =
  | { action: "create"; name: string; config: SettingsFormConfig; expectedRevision: string }
  | { action: "switch"; profileId: string; expectedRevision: string }
  | { action: "delete"; profileId: string; expectedRevision: string; replacementProfileId?: string };

export interface SettingsRequestContext {
  signal: AbortSignal;
}

/**
 * Integration boundary for config storage and mail transports. Implementations must never
 * include credentials in returned values or error messages.
 */
export interface SettingsCallbacks {
  getProfiles?(context: SettingsRequestContext): Awaitable<SettingsProfiles>;
  changeProfile?(request: SettingsProfileRequest, context: SettingsRequestContext): Awaitable<SettingsActionResult>;
  getConfig(context: SettingsRequestContext): Awaitable<SettingsPublicConfig>;
  getStatus(context: SettingsRequestContext): Awaitable<SettingsStatus>;
  setCredential(
    authorizationCode: string,
    context: SettingsRequestContext,
    expectedRevision: string,
  ): Awaitable<SettingsActionResult>;
  test(
    request: SettingsTestRequest,
    context: SettingsRequestContext,
  ): Awaitable<SettingsActionResult>;
  save(
    request: SettingsSaveRequest,
    context: SettingsRequestContext,
  ): Awaitable<SettingsActionResult>;
  clear(context: SettingsRequestContext): Awaitable<SettingsActionResult>;
}

export interface SettingsSession {
  token: string;
  apiBase: string;
  browserUrl: string;
  expiresAt: string;
}

export interface SettingsSessionOptions {
  /** Permit the opaque Origin used by an MCP App iframe. Browser fallback leaves this false. */
  allowOpaqueOrigin?: boolean;
}
