import {
  CONFIG_VERSION,
  ConfigStorageError,
  DEFAULT_DOWNLOAD_BYTES,
  PRESETS,
  configSchema,
  getDefaultDownloadDirectory,
  type QqMailConfig,
} from "../config.js";
import { AccountStateError, accountIdentity, type AccountRepository, type AccountProfileRepository } from "../account-store.js";
import { DEFAULT_MAIL_FOLDERS as DEFAULT_FOLDERS, mapStoredConfig as accountFromStoredConfig, foldersFromStoredConfig } from "../mail/account-mapping.js";
import { denySettingsApproval, type SettingsApproval, type SettingsApprovalRequest } from "./approval.js";
import {
  ImapFlowGateway,
  NodemailerSmtpGateway,
  type ImapGateway,
  type ImapMailboxInfo,
  type MailAccountConfig,
  type MailFolderConfig,
  type SmtpGateway,
} from "../mail/index.js";
import type {
  ConnectionStatus,
  SettingsActionResult,
  SettingsCallbacks,
  SettingsFormConfig,
  SettingsPublicConfig,
  SettingsRequestContext,
  SettingsStatus,
  SettingsTestRequest,
} from "./types.js";

const UNKNOWN_IMAP: ConnectionStatus = Object.freeze({
  state: "unknown",
  message: "尚未测试 IMAP。",
});
const UNKNOWN_SMTP: ConnectionStatus = Object.freeze({
  state: "unknown",
  message: "尚未测试 SMTP。",
});
const UNKNOWN_FOLDERS: ConnectionStatus = Object.freeze({
  state: "unknown",
  message: "尚未检查邮箱目录。",
});

export interface SettingsCallbackOptions {
  accountStore: AccountRepository & Partial<AccountProfileRepository>;
  imapGateway?: ImapGateway;
  smtpGateway?: SmtpGateway;
  now?: () => number;
  defaultDownloadDirectory?: string;
  settingsApproval?: SettingsApproval;
}

export function createSettingsCallbacks(options: SettingsCallbackOptions): SettingsCallbacks {
  const imap = options.imapGateway ?? new ImapFlowGateway();
  const smtp = options.smtpGateway ?? new NodemailerSmtpGateway();
  const now = options.now ?? Date.now;
  let imapStatus = cloneStatus(UNKNOWN_IMAP);
  let smtpStatus = cloneStatus(UNKNOWN_SMTP);
  let foldersStatus = cloneStatus(UNKNOWN_FOLDERS);
  let imapScope: string | undefined;
  let smtpScope: string | undefined;
  let foldersScope: string | undefined;
  const approval = options.settingsApproval ?? denySettingsApproval;
  let mutationActive = false;
  async function approvedAction(
    request: SettingsApprovalRequest,
    context: SettingsRequestContext,
    operation: () => Promise<SettingsActionResult>,
  ): Promise<SettingsActionResult> {
    assertRequestActive(context);
    if (mutationActive) return { ok: false, message: "另一个设置操作正在等待确认，请稍后重试。" };
    mutationActive = true;
    try {
      // The approval provider receives a separate snapshot. It cannot change the
      // operation's parsed configuration while a user reviews the dialog.
      const allowed = await approval.confirm(structuredClone(request)).catch(() => false);
      assertRequestActive(context);
      if (!allowed) return { ok: false, message: "操作未获本机用户确认，未执行。" };
      return await operation();
    } finally {
      mutationActive = false;
    }
  }

  const resetConnectionStatus = (): void => {
    imapStatus = cloneStatus(UNKNOWN_IMAP);
    smtpStatus = cloneStatus(UNKNOWN_SMTP);
    foldersStatus = cloneStatus(UNKNOWN_FOLDERS);
    imapScope = smtpScope = foldersScope = undefined;
  };

  const currentScope = async (scope: string): Promise<boolean> => (await options.accountStore.snapshot()).scope === scope;
  const staleResult = (): SettingsActionResult => ({ ok: false, message: "账户已变更，旧连接测试结果已丢弃，请重新加载设置。" });

  return {
    async getProfiles(context) {
      assertRequestActive(context);
      if (!options.accountStore.listProfiles) throw new Error("Account profiles are unavailable");
      const profiles = await options.accountStore.listProfiles();
      assertRequestActive(context);
      return profiles;
    },

    async changeProfile(request, context) {
      assertRequestActive(context);
      const accounts = options.accountStore;
      if (!accounts.listProfiles || !accounts.createProfile || !accounts.switchProfile || !accounts.deleteProfile) {
        return { ok: false, message: "当前账户仓库不支持账户档案。" };
      }
      const profiles = await accounts.listProfiles();
      if (profiles.revision !== request.expectedRevision) return { ok: false, message: "账户档案已变更，请重新加载设置。" };
      let action: SettingsApprovalRequest;
      let config: QqMailConfig | undefined;
      if (request.action === "create") {
        config = storedConfigFromForm(request.config);
        action = { action: "create-profile", details: { name: request.name, config, effect: "Create and activate a new account profile. No credentials are copied." } };
      } else {
        const profile = profiles.profiles.find(value => value.id === request.profileId);
        if (!profile) return { ok: false, message: "账户档案不存在，请重新加载。" };
        const replacement = request.action === "delete" && request.replacementProfileId
          ? profiles.profiles.find(value => value.id === request.replacementProfileId) : undefined;
        action = { action: request.action === "switch" ? "switch-profile" : "delete-profile", details: {
          profile, deletingActiveProfile: request.action === "delete" && profiles.activeProfileId === profile.id,
          replacement: replacement ?? null,
          effect: request.action === "switch" ? "Activate this saved account and its own saved credential. Old mail references and drafts expire."
            : "Delete this saved profile and its credential. This does not delete messages on the mail server.",
        } };
      }
      return approvedAction(action, context, async () => {
        try {
          let accountRevision: string;
          if (request.action === "create") {
            accountRevision = (await accounts.createProfile!(request.name, config!, request.expectedRevision)).revision;
          } else if (request.action === "switch") {
            accountRevision = await accounts.switchProfile!(request.profileId, request.expectedRevision);
          } else {
            accountRevision = await accounts.deleteProfile!(request.profileId, request.expectedRevision, request.replacementProfileId);
          }
          resetConnectionStatus();
          assertRequestActive(context);
          return { ok: true, message: "账户档案已更新。", accountRevision };
        } catch (error) {
          assertRequestActive(context);
          return { ok: false, message: error instanceof AccountStateError ? error.message : "账户档案更新失败，请重新加载。" };
        }
      });
    },

    async getConfig(context) {
      assertRequestActive(context);
      const snapshot = await options.accountStore.snapshot();
      const { config: stored, credentialStored } = snapshot;
      assertRequestActive(context);
      const config = stored
        ? toPublicConfig(stored, credentialStored)
        : defaultPublicConfig(
            credentialStored,
            options.defaultDownloadDirectory ?? getDefaultDownloadDirectory(),
          );
      return { ...config, accountScope: snapshot.scope, accountRevision: snapshot.revision,
        ...(snapshot.profileId ? { profileId: snapshot.profileId } : {}) };
    },

    async getStatus(context) {
      assertRequestActive(context);
      const { config: stored, credentialStored, scope } = await options.accountStore.snapshot();
      assertRequestActive(context);
      const configured = stored !== null;
      const visibleImap = configured && credentialStored && imapScope === scope ? imapStatus : UNKNOWN_IMAP;
      const visibleSmtp = configured && credentialStored && smtpScope === scope ? smtpStatus : UNKNOWN_SMTP;
      const visibleFolders = configured && credentialStored && foldersScope === scope ? foldersStatus : UNKNOWN_FOLDERS;
      return {
        accountScope: scope,
        configured,
        credentialStored,
        imap: cloneStatus(visibleImap),
        smtp: cloneStatus(visibleSmtp),
        folders: cloneStatus(visibleFolders),
        message: statusMessage(configured, credentialStored, [
          visibleImap,
          visibleSmtp,
          visibleFolders,
        ]),
      } satisfies SettingsStatus;
    },

    async setCredential(authorizationCode, context, expectedRevision) {
      assertRequestActive(context);
      const credential = normalizeCredential(authorizationCode);
      const snapshot = await options.accountStore.snapshot();
      if (!snapshot.config || snapshot.revision !== expectedRevision) {
        return { ok: false, message: "账户已变更，请先重新保存设置，再保存授权码。" };
      }
      return approvedAction({ action: "store-credential", details: {
        storage: "Windows current-user DPAPI; authorization code is not displayed",
        email: snapshot.config.email, username: snapshot.config.username,
        imap: snapshot.config.imap, smtp: snapshot.config.smtp,
      } }, context, async () => {
      try {
        await options.accountStore.setCredential(credential, snapshot.revision);
        resetConnectionStatus();
        assertRequestActive(context);
        return { ok: true, message: "授权码已安全保存。" };
      } catch (error) {
        assertRequestActive(context);
        return { ok: false, message: error instanceof ConfigStorageError ? error.message : "授权码保存失败。" };
      }
      });
    },

    async test(request, context) {
      assertRequestActive(context);
      const target = request.target;
      let account: MailAccountConfig;
      let config: QqMailConfig;
      try {
        config = storedConfigFromForm(request.config);
        account = accountFromForm(request.config);
      } catch {
        return failedConfigurationTest(target, now());
      }

      const snapshot = await options.accountStore.snapshot();
      if ((request.expectedRevision !== undefined && request.expectedRevision !== snapshot.revision) ||
          !snapshot.config || accountIdentity(snapshot.config) !== accountIdentity(config)) {
        return { ok: false, message: "账户或服务器已变更，请先保存设置并为该账户保存授权码。" };
      }
      return approvedAction({
        action: target === "imap" ? "test-imap" : "test-smtp",
        details: {
          email: account.email,
          username: account.username,
          destination: structuredClone(target === "imap" ? account.imap : account.smtp),
          dataSent: "Login name and saved authorization code; IMAP also requests mailbox names",
        },
      }, context, async () => {
      let credential: string | undefined;
      try {
        if ((await options.accountStore.snapshot()).revision !== snapshot.revision) {
          return { ok: false, message: "账户已变更，请重新测试。" };
        }
        credential = await snapshot.unlock();
      } catch {
        credential = undefined;
      }
      assertRequestActive(context);
      if (!await currentScope(snapshot.scope)) return staleResult();
      if (!isUsableCredential(credential)) {
        const checkedAt = new Date(now()).toISOString();
        return target === "imap"
          ? updateFailedImap("请先保存授权码，再测试 IMAP。", checkedAt, snapshot.scope)
          : updateFailedSmtp("请先保存授权码，再测试 SMTP。", checkedAt, snapshot.scope);
      }

      return target === "imap"
        ? testImap(account, credential, context, snapshot.scope)
        : testSmtp(account, credential, context, snapshot.scope);
      });
    },

    async save(request, context) {
      assertRequestActive(context);
      try {
        const config = storedConfigFromForm(request.config);
        const snapshot = await options.accountStore.snapshot();
        if (request.expectedRevision !== undefined && request.expectedRevision !== snapshot.revision) {
          return { ok: false, message: "当前账户已变更，请重新加载后保存。" };
        }
        return await approvedAction({
          action: "save-settings",
          details: structuredClone(config),
        }, context, async () => {
        const accountRevision = await options.accountStore.saveConfig(config, snapshot.revision);
        resetConnectionStatus();
        assertRequestActive(context);
        return { ok: true, message: "QQ 邮箱设置已保存。账户或服务器改变后需重新保存授权码。", accountRevision };
        });
      } catch (error) {
        assertRequestActive(context);
        return { ok: false, message: error instanceof AccountStateError || error instanceof ConfigStorageError ? error.message : "QQ 邮箱设置保存失败。" };
      }
    },

    async clear(context) {
      assertRequestActive(context);
      const snapshot = await options.accountStore.snapshot();
      return approvedAction({ action: "clear-credential", details: {
        effect: "Delete the saved authorization code", email: snapshot.config?.email ?? "",
      } }, context, async () => {
      try {
        await options.accountStore.clearCredential(snapshot.revision);
        resetConnectionStatus();
        assertRequestActive(context);
        return { ok: true, message: "已清除保存的授权码。" };
      } catch {
        assertRequestActive(context);
        return { ok: false, message: "授权码清除失败。" };
      }
      });
    },
  };

  async function testImap(
    account: MailAccountConfig,
    credential: string,
    context: SettingsRequestContext,
    scope: string,
  ): Promise<SettingsActionResult> {
    const checkedAt = new Date(now()).toISOString();
    let session: Awaited<ReturnType<ImapGateway["connect"]>> | undefined;
    try {
      session = await imap.connect(account.imap, account.username, credential);
      assertRequestActive(context);
      const mailboxes = await session.listMailboxes(account.folders);
      assertRequestActive(context);
      if (!await currentScope(scope)) return staleResult();
      imapScope = foldersScope = scope;
      imapStatus = {
        state: "ok",
        message: "IMAP 连接成功。",
        checkedAt,
      };
      foldersStatus = folderDiscoveryStatus(mailboxes, account.folders, checkedAt);
      const foldersOk = foldersStatus.state === "ok";
      return {
        accountScope: scope,
        ok: foldersOk,
        message: foldersOk
          ? "IMAP 连接及邮箱目录检查成功。"
          : "IMAP 已连接，但部分配置目录未找到。",
        imap: cloneStatus(imapStatus),
        folders: cloneStatus(foldersStatus),
      };
    } catch {
      assertRequestActive(context);
      if (!await currentScope(scope)) return staleResult();
      return updateFailedImap("IMAP 连接失败。", checkedAt, scope);
    } finally {
      await session?.close().catch(() => undefined);
    }
  }

  async function testSmtp(
    account: MailAccountConfig,
    credential: string,
    context: SettingsRequestContext,
    scope: string,
  ): Promise<SettingsActionResult> {
    const checkedAt = new Date(now()).toISOString();
    try {
      await smtp.verify(account.smtp, account.username, credential);
      assertRequestActive(context);
      if (!await currentScope(scope)) return staleResult();
      smtpScope = scope;
      smtpStatus = {
        state: "ok",
        message: "SMTP 连接成功。",
        checkedAt,
      };
      return {
        accountScope: scope,
        ok: true,
        message: "SMTP 连接成功。",
        smtp: cloneStatus(smtpStatus),
      };
    } catch {
      assertRequestActive(context);
      if (!await currentScope(scope)) return staleResult();
      return updateFailedSmtp("SMTP 连接失败。", checkedAt, scope);
    }
  }

  function failedConfigurationTest(
    target: SettingsTestRequest["target"],
    checkedAtMs: number,
  ): SettingsActionResult {
    const checkedAt = new Date(checkedAtMs).toISOString();
    return target === "imap"
      ? updateFailedImap("IMAP 设置无效。", checkedAt)
      : updateFailedSmtp("SMTP 设置无效。", checkedAt);
  }

  function updateFailedImap(message: string, checkedAt: string, scope?: string): SettingsActionResult {
    imapScope = foldersScope = scope;
    imapStatus = { state: "error", message, checkedAt };
    foldersStatus = {
      state: "error",
      message: "无法检查邮箱目录。",
      checkedAt,
    };
    return {
      ...(scope ? { accountScope: scope } : {}),
      ok: false,
      message,
      imap: cloneStatus(imapStatus),
      folders: cloneStatus(foldersStatus),
    };
  }

  function updateFailedSmtp(message: string, checkedAt: string, scope?: string): SettingsActionResult {
    smtpScope = scope;
    smtpStatus = { state: "error", message, checkedAt };
    return {
      ...(scope ? { accountScope: scope } : {}),
      ok: false,
      message,
      smtp: cloneStatus(smtpStatus),
    };
  }
}

function storedConfigFromForm(form: SettingsFormConfig): QqMailConfig {
  const archiveMailbox = form.folders.archive.trim();
  return configSchema.parse({
    version: CONFIG_VERSION,
    preset: form.provider,
    email: form.email,
    displayName: form.displayName,
    username: form.email,
    imap: form.imap,
    smtp: form.smtp,
    inboxMailbox: form.folders.inbox,
    sentMailbox: form.folders.sent,
    draftsMailbox: form.folders.drafts,
    trashMailbox: form.folders.trash,
    spamMailbox: form.folders.spam,
    ...(archiveMailbox ? { archiveMailbox } : {}),
    downloadDirectory: form.downloadDirectory,
    maxDownloadBytes: DEFAULT_DOWNLOAD_BYTES,
  });
}

function accountFromForm(form: SettingsFormConfig): MailAccountConfig {
  return accountFromStoredConfig(storedConfigFromForm(form));
}

function toPublicConfig(config: QqMailConfig, credentialStored: boolean): SettingsPublicConfig {
  const folders = foldersFromStoredConfig(config);
  return {
    provider: config.preset,
    email: config.email,
    displayName: config.displayName,
    imap: { ...config.imap, rejectUnauthorized: true },
    smtp: { ...config.smtp, rejectUnauthorized: true },
    folders: {
      inbox: folders.inbox,
      sent: folders.sent,
      drafts: folders.drafts ?? DEFAULT_FOLDERS.drafts,
      trash: folders.trash,
      spam: folders.spam ?? DEFAULT_FOLDERS.spam,
      archive: folders.archive ?? "",
    },
    downloadDirectory: config.downloadDirectory,
    credentialStored,
  };
}

function defaultPublicConfig(
  credentialStored: boolean,
  downloadDirectory: string,
): SettingsPublicConfig {
  return {
    provider: "personal",
    email: "",
    displayName: "",
    imap: { ...PRESETS.personal.imap },
    smtp: { ...PRESETS.personal.smtp },
    folders: { ...DEFAULT_FOLDERS },
    downloadDirectory,
    credentialStored,
  };
}

function folderDiscoveryStatus(
  mailboxes: readonly ImapMailboxInfo[],
  configured: MailFolderConfig,
  checkedAt: string,
): ConnectionStatus {
  const paths = new Set(mailboxes.map((mailbox) => mailbox.path.toLocaleLowerCase("en-US")));
  const roles = new Set(
    mailboxes
      .map((mailbox) => mailbox.specialUse?.toLocaleLowerCase("en-US"))
      .filter((role): role is string => Boolean(role)),
  );
  const checks = [
    folderWasFound(configured.inbox, undefined, paths, roles),
    folderWasFound(configured.sent, "\\sent", paths, roles),
    folderWasFound(configured.drafts, "\\drafts", paths, roles),
    folderWasFound(configured.trash, "\\trash", paths, roles),
    folderWasFound(configured.spam, "\\junk", paths, roles),
    folderWasFound(configured.archive, "\\archive", paths, roles),
  ];
  const missing = checks.filter((found) => !found).length;
  if (missing > 0) {
    return {
      state: "error",
      message: `共发现 ${mailboxes.length} 个邮箱目录，其中 ${missing} 个配置目录未找到。`,
      checkedAt,
    };
  }
  return {
    state: "ok",
    message: `共发现 ${mailboxes.length} 个邮箱目录，所有配置目录均可用。`,
    checkedAt,
  };
}

function folderWasFound(
  configuredPath: string | undefined,
  specialUse: string | undefined,
  paths: ReadonlySet<string>,
  roles: ReadonlySet<string>,
): boolean {
  if (!configuredPath) {
    return true;
  }
  return (
    paths.has(configuredPath.toLocaleLowerCase("en-US")) ||
    (specialUse !== undefined && roles.has(specialUse))
  );
}

function isUsableCredential(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function normalizeCredential(value: string): string {
  const normalized = value.trim();
  if (!isUsableCredential(normalized) || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("Authorization code is invalid.");
  }
  return normalized;
}

function cloneStatus(status: ConnectionStatus): ConnectionStatus {
  return status.checkedAt === undefined
    ? { state: status.state, message: status.message }
    : { state: status.state, message: status.message, checkedAt: status.checkedAt };
}

function statusMessage(
  configured: boolean,
  credentialStored: boolean,
  statuses: readonly ConnectionStatus[],
): string {
  if (!configured) {
    return "尚未保存 QQ 邮箱设置。";
  }
  if (!credentialStored) {
    return "请保存授权码以连接 QQ 邮箱。";
  }
  if (statuses.some((status) => status.state === "error")) {
    return "一项或多项连接检查失败。";
  }
  if (statuses.every((status) => status.state === "ok")) {
    return "QQ 邮箱已就绪。";
  }
  return "设置已保存，等待连接检查。";
}

function assertRequestActive(context: SettingsRequestContext): void {
  if (!context.signal.aborted) {
    return;
  }
  const error = new Error("Settings request was aborted.");
  error.name = "AbortError";
  throw error;
}
