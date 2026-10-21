import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import {
  restrictWindowsPathToCurrentUser,
  type WindowsAclOptions,
} from "./windows-acl.js";

export const CONFIG_VERSION = 1 as const;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_BYTES = MAX_DOWNLOAD_BYTES;

export const mailPresetSchema = z.enum(["personal", "enterprise", "xinchuang", "custom"]);
export const transportSecuritySchema = z.enum(["tls", "starttls"]);

export type MailPreset = z.infer<typeof mailPresetSchema>;
export type TransportSecurity = z.infer<typeof transportSecuritySchema>;

export function isLocalAbsoluteWindowsPath(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    return false;
  }
  const root = path.win32.parse(normalized).root;
  return path.win32.isAbsolute(normalized) && /^[A-Za-z]:[\\/]$/u.test(root);
}

const endpointSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/, "Invalid mail server hostname")
      .transform((value) => value.toLowerCase()),
    port: z.number().int().min(1).max(65_535),
    security: transportSecuritySchema,
    rejectUnauthorized: z.literal(true).default(true),
  })
  .strict();

export type MailEndpoint = z.infer<typeof endpointSchema>;

const mailboxPathSchema = z.string().trim().min(1).max(1_024);

const tls993 = { port: 993, security: "tls", rejectUnauthorized: true } as const;
const tls465 = { port: 465, security: "tls", rejectUnauthorized: true } as const;

export const PRESETS = Object.freeze({
  personal: Object.freeze({
    label: "QQ Mail",
    imap: Object.freeze({ host: "imap.qq.com", ...tls993 }),
    smtp: Object.freeze({ host: "smtp.qq.com", ...tls465 }),
    smtpAlternatives: Object.freeze([
      Object.freeze({ host: "smtp.qq.com", ...tls465 }),
      Object.freeze({ host: "smtp.qq.com", port: 587, security: "starttls", rejectUnauthorized: true } as const),
    ]),
  }),
  enterprise: Object.freeze({
    label: "Tencent Exmail",
    imap: Object.freeze({ host: "imap.exmail.qq.com", ...tls993 }),
    smtp: Object.freeze({ host: "smtp.exmail.qq.com", ...tls465 }),
    smtpAlternatives: Object.freeze([Object.freeze({ host: "smtp.exmail.qq.com", ...tls465 })]),
  }),
  xinchuang: Object.freeze({
    label: "Tencent Exmail Xinchuang",
    imap: Object.freeze({ host: "xcimap.exmail.qq.com", ...tls993 }),
    smtp: Object.freeze({ host: "xcsmtp.exmail.qq.com", ...tls465 }),
    smtpAlternatives: Object.freeze([Object.freeze({ host: "xcsmtp.exmail.qq.com", ...tls465 })]),
  }),
  custom: Object.freeze({
    label: "Custom",
    imap: null,
    smtp: null,
    smtpAlternatives: Object.freeze([]),
  }),
} as const);

function endpointMatches(actual: MailEndpoint, expected: MailEndpoint): boolean {
  return (
    actual.host === expected.host &&
    actual.port === expected.port &&
    actual.security === expected.security &&
    actual.rejectUnauthorized === true
  );
}

export const configV1Schema = z
  .object({
    version: z.literal(CONFIG_VERSION),
    preset: mailPresetSchema,
    email: z.string().trim().email().max(320),
    displayName: z.string().trim().max(200).default(""),
    username: z.string().trim().min(1).max(320),
    imap: endpointSchema,
    smtp: endpointSchema,
    inboxMailbox: mailboxPathSchema.optional(),
    sentMailbox: mailboxPathSchema.optional(),
    draftsMailbox: mailboxPathSchema.optional(),
    trashMailbox: mailboxPathSchema.optional(),
    spamMailbox: mailboxPathSchema.optional(),
    archiveMailbox: mailboxPathSchema.optional(),
    downloadDirectory: z
      .string()
      .trim()
      .min(1)
      .max(32_767)
      .refine(
        isLocalAbsoluteWindowsPath,
        "The download directory must be an absolute path on a local drive",
      ),
    maxDownloadBytes: z.number().int().min(1).max(MAX_DOWNLOAD_BYTES).default(DEFAULT_DOWNLOAD_BYTES),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.preset === "custom") {
      return;
    }

    const preset = PRESETS[config.preset];
    if (!endpointMatches(config.imap, preset.imap)) {
      context.addIssue({
        code: "custom",
        path: ["imap"],
        message: `IMAP settings do not match the ${config.preset} preset`,
      });
    }

    if (!preset.smtpAlternatives.some((endpoint) => endpointMatches(config.smtp, endpoint))) {
      context.addIssue({
        code: "custom",
        path: ["smtp"],
        message: `SMTP settings do not match the ${config.preset} preset`,
      });
    }
  });

export const configSchema = configV1Schema;
export type QqMailConfig = z.infer<typeof configSchema>;
export type QqMailConfigInput = z.input<typeof configSchema>;

export interface ConfigPaths {
  readonly directory: string;
  readonly configPath: string;
  readonly secretPath: string;
}

export interface ConfigStorageOptions {
  readonly directory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly acl?: WindowsAclOptions;
}

export class ConfigStorageError extends Error {
  readonly code: "CONFIG_PATH_UNAVAILABLE" | "CONFIG_INVALID" | "CONFIG_IO_ERROR" | "CONFIG_LOCATION_CONFLICT" | "CONFIG_ATOMIC_REPLACE_UNAVAILABLE";

  constructor(code: ConfigStorageError["code"], message: string) {
    super(message);
    this.name = "ConfigStorageError";
    this.code = code;
  }
}

export function getDefaultDownloadDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const profile = environment.USERPROFILE;
  if (!profile) {
    throw new ConfigStorageError("CONFIG_PATH_UNAVAILABLE", "The Windows user profile directory is unavailable.");
  }
  return path.join(profile, "Downloads", "QQ Mail");
}

export function getConfigPaths(options: ConfigStorageOptions = {}): ConfigPaths {
  const environment = options.environment ?? process.env;
  const localAppData = environment.LOCALAPPDATA ?? environment.LocalAppData;
  const legacy = localAppData ? path.join(localAppData, "Codex", "plugins", "qq-mail") : undefined;
  const preferred = environment.USERPROFILE ? path.join(environment.USERPROFILE, ".qq-mail") : undefined;
  let directory = options.directory;
  if (!directory) {
    // Fresh installations avoid host-owned AppData storage, where Windows
    // application encryption can reject even same-directory rename with EXDEV.
    // Never silently abandon an existing account, credential, draft or lock.
    const hasLegacy = legacy ? hasStoredState(legacy) : false;
    const hasPreferred = preferred ? hasStoredState(preferred) : false;
    if (hasLegacy && hasPreferred) {
      throw new ConfigStorageError("CONFIG_LOCATION_CONFLICT", "QQmail 检测到两个存储位置都有账户或草稿数据，请先确认使用哪个位置；未移动或删除任何数据。");
    }
    directory = hasLegacy ? legacy : preferred ?? legacy;
  }

  if (!directory) {
    throw new ConfigStorageError("CONFIG_PATH_UNAVAILABLE", "Windows user storage is unavailable; QQ Mail settings cannot be stored.");
  }

  return {
    directory,
    configPath: path.join(directory, "config.json"),
    secretPath: path.join(directory, "secret.bin"),
  };
}

const STORED_STATE_NAMES = ["config.json", "secret.bin", "account.json", "account-profiles.json",
  "drafts.enc.json", "account.lock", "account.lock.recovery", "drafts.lock", "drafts.lock.recovery"];
function hasStoredState(directory: string): boolean {
  try {
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Invalid storage directory");
    const expected = path.join(realpathSync.native(path.dirname(directory)), path.basename(directory));
    if (realpathSync.native(directory).toLowerCase() !== expected.toLowerCase()) throw new Error("Redirected storage directory");
    let present = false;
    for (const name of STORED_STATE_NAMES) {
      try {
        const entry = lstatSync(path.join(directory, name));
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Invalid storage entry");
        present = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return present;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ConfigStorageError("CONFIG_IO_ERROR", "QQmail 无法安全检查已有账户存储，未切换到其他目录。");
  }
}

export function createConfig(
  input: Omit<QqMailConfigInput, "version" | "imap" | "smtp" | "username" | "downloadDirectory"> &
    Partial<Pick<QqMailConfigInput, "imap" | "smtp" | "username" | "downloadDirectory">>,
  environment: NodeJS.ProcessEnv = process.env,
): QqMailConfig {
  const preset = input.preset;
  const presetDefinition = PRESETS[preset];
  const imap = input.imap ?? presetDefinition.imap;
  const smtp = input.smtp ?? presetDefinition.smtp;

  if (!imap || !smtp) {
    throw new ConfigStorageError("CONFIG_INVALID", "Custom IMAP and SMTP settings are required.");
  }

  return configSchema.parse({
    ...input,
    version: CONFIG_VERSION,
    username: input.username ?? input.email,
    downloadDirectory: input.downloadDirectory ?? getDefaultDownloadDirectory(environment),
    imap,
    smtp,
  });
}

export async function writeFileAtomically(
  targetPath: string,
  data: string | Uint8Array,
  mode = 0o600,
  aclOptions: WindowsAclOptions = {},
): Promise<void> {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true });
  await restrictWindowsPathToCurrentUser(directory, "directory", aclOptions);
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, data, { mode, flag: "wx" });
    await restrictWindowsPathToCurrentUser(temporaryPath, "file", aclOptions);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      throw new ConfigStorageError("CONFIG_ATOMIC_REPLACE_UNAVAILABLE", "当前本地存储位置不支持原子保存，已有设置未被覆盖。请检查存储位置后重试。");
    }
    throw error;
  }
}

export async function loadConfig(options: ConfigStorageOptions = {}): Promise<QqMailConfig | null> {
  const { configPath } = getConfigPaths(options);
  let contents: string;

  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new ConfigStorageError("CONFIG_IO_ERROR", "QQ Mail settings could not be read.");
  }

  try {
    return configSchema.parse(JSON.parse(contents) as unknown);
  } catch {
    throw new ConfigStorageError("CONFIG_INVALID", "The saved QQ Mail settings are invalid.");
  }
}

export async function saveConfig(config: QqMailConfigInput, options: ConfigStorageOptions = {}): Promise<QqMailConfig> {
  const parsed = configSchema.parse(config);
  const { configPath } = getConfigPaths(options);

  try {
    await writeFileAtomically(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 0o600, options.acl);
  } catch (error) {
    if (error instanceof ConfigStorageError) throw error;
    throw new ConfigStorageError("CONFIG_IO_ERROR", "QQ Mail settings could not be saved.");
  }

  return parsed;
}

export class ConfigStore {
  private readonly options: ConfigStorageOptions;

  constructor(options: ConfigStorageOptions = {}) {
    this.options = options;
  }

  get paths(): ConfigPaths {
    return getConfigPaths(this.options);
  }

  load(): Promise<QqMailConfig | null> {
    return loadConfig(this.options);
  }

  save(config: QqMailConfig): Promise<QqMailConfig> {
    return saveConfig(config, this.options);
  }
}
