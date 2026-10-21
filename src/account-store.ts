import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { ConfigStorageError, configSchema, getConfigPaths, loadConfig, writeFileAtomically,
  type ConfigStorageOptions, type QqMailConfig } from "./config.js";
import { protectSecret, unprotectSecret, type DpapiOptions } from "./dpapi.js";
import { restrictWindowsPathToCurrentUser } from "./windows-acl.js";
import { acquireOwnedFileLock, LocalLockError, type LockOwnerState } from "./local-lock.js";

export const MAX_ACCOUNT_PROFILES = 20;
const profileIdSchema = z.string().regex(/^profile_[a-f0-9]{32}$/u);
const profileNameSchema = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u);
const ciphertextSchema = z.string().min(1).max(128_000).nullable();
const legacyRecordSchema = z.strictObject({ version: z.literal(1), revision: z.uuid(), config: configSchema, ciphertext: ciphertextSchema });
const profileSchema = z.strictObject({ id: profileIdSchema, name: profileNameSchema, config: configSchema, ciphertext: ciphertextSchema });
const profilesSchema = z.strictObject({
  version: z.literal(2), revision: z.uuid(), activeProfileId: profileIdSchema.nullable(),
  profiles: z.array(profileSchema).max(MAX_ACCOUNT_PROFILES),
}).superRefine((value, context) => {
  const ids = new Set(value.profiles.map(profile => profile.id));
  if (ids.size !== value.profiles.length ||
      (value.profiles.length === 0 ? value.activeProfileId !== null : !value.activeProfileId || !ids.has(value.activeProfileId))) {
    context.addIssue({ code: "custom", message: "Invalid active account profile" });
  }
});
type Profile = z.infer<typeof profileSchema>;
type Profiles = z.infer<typeof profilesSchema>;

export interface AccountSnapshot {
  readonly config: QqMailConfig | null;
  readonly revision: string;
  readonly scope: string;
  readonly profileId?: string;
  readonly profileName?: string;
  readonly credentialStored: boolean;
  /** Unlocks only this snapshot. Never reads the current credential slot. */
  unlock(): Promise<string | undefined>;
}
export interface AccountProfileSummary { id: string; name: string; email: string; credentialStored: boolean }
export interface AccountProfileList { revision: string; activeProfileId: string | null; profiles: AccountProfileSummary[] }
export interface AccountRepository {
  snapshot(): Promise<AccountSnapshot>;
  saveConfig(config: QqMailConfig, expectedRevision: string): Promise<string>;
  setCredential(secret: string, expectedRevision: string): Promise<void>;
  clearCredential(expectedRevision: string): Promise<void>;
}
export interface AccountProfileRepository extends AccountRepository {
  listProfiles(): Promise<AccountProfileList>;
  createProfile(name: string, config: QqMailConfig, expectedRevision: string): Promise<{ profileId: string; revision: string }>;
  switchProfile(profileId: string, expectedRevision: string): Promise<string>;
  deleteProfile(profileId: string, expectedRevision: string, replacementProfileId?: string): Promise<string>;
}
export interface AccountStateStorage {
  read(): Promise<string | null>;
  compareAndSwap(expected: string | null, next: string): Promise<void>;
}
export class AccountStateError extends Error {
  constructor(readonly code = "ACCOUNT_STATE_CHANGED", message = "Account state changed, is busy, or could not be accessed. Reload settings and try again.") {
    super(message); this.name = "AccountStateError";
  }
}

/** The old account.json remains untouched when a version 1 account is migrated. */
export class FileAccountStateStorage implements AccountStateStorage {
  constructor(private readonly options: ConfigStorageOptions,
    private readonly ownerState?: (pid: number) => LockOwnerState) {}
  private get directory(): string { return getConfigPaths(this.options).directory; }
  private get file(): string { return path.join(this.directory, "account-profiles.json"); }
  async read(): Promise<string | null> {
    for (const file of [this.file, path.join(this.directory, "account.json")]) {
      try { return await readFile(file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AccountStateError(); }
    }
    return null;
  }
  async compareAndSwap(expected: string | null, next: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await restrictWindowsPathToCurrentUser(this.directory, "directory", this.options.acl);
    const lockPath = path.join(this.directory, "account.lock");
    let lock;
    try { lock = await acquireOwnedFileLock(lockPath, this.ownerState ? { ownerState: this.ownerState } : {}); }
    catch (error) { throw error instanceof LocalLockError ? new AccountStateError("ACCOUNT_" + error.code, error.message) : new AccountStateError(); }
    try {
      if (await this.read() !== expected) throw new AccountStateError();
      await writeFileAtomically(this.file, next, 0o600, this.options.acl);
    } finally { await lock.release(); }
  }
}
export function accountIdentity(config: QqMailConfig): string {
  return createHash("sha256").update(JSON.stringify({ email: config.email, username: config.username, imap: config.imap, smtp: config.smtp })).digest("hex");
}
function migratedProfile(config: QqMailConfig, revision: string, ciphertext: string | null): Profile {
  return { id: "profile_" + createHash("sha256").update(`${accountIdentity(config)}:${revision}`).digest("hex").slice(0, 32), name: "默认账户", config, ciphertext };
}
export class AccountStore implements AccountProfileRepository {
  readonly #storage: AccountStateStorage;
  readonly #legacy: () => Promise<QqMailConfig | null>;
  readonly #protect: (plain: string) => Promise<Buffer>;
  readonly #unprotect: (cipher: Buffer) => Promise<string>;
  constructor(options: ConfigStorageOptions & DpapiOptions & {
    storage?: AccountStateStorage; legacyConfig?: () => Promise<QqMailConfig | null>;
    protection?: { protect(plain: string): Promise<Buffer>; unprotect(cipher: Buffer): Promise<string> };
  } = {}) {
    this.#storage = options.storage ?? new FileAccountStateStorage(options);
    this.#legacy = options.legacyConfig ?? (() => loadConfig(options));
    this.#protect = options.protection?.protect ?? (plain => protectSecret(plain, options));
    this.#unprotect = options.protection?.unprotect ?? (cipher => unprotectSecret(cipher, options));
  }
  async #read() {
    try {
      const raw = await this.#storage.read();
      if (raw !== null) {
        const input: unknown = JSON.parse(raw);
        if ((input as { version?: unknown })?.version === 1) {
          const old = legacyRecordSchema.parse(input);
          const profile = migratedProfile(old.config, old.revision, old.ciphertext);
          return { raw, revision: old.revision, activeProfileId: profile.id, profiles: [profile] };
        }
        return { raw, ...profilesSchema.parse(input) };
      }
      // An older unbound secret.bin is never imported.
      const legacy = await this.#legacy();
      const config = legacy ? configSchema.parse(legacy) : null;
      const revision = createHash("sha256").update(JSON.stringify(config)).digest("hex");
      const profile = config ? migratedProfile(config, revision, null) : undefined;
      return { raw, revision, activeProfileId: profile?.id ?? null, profiles: profile ? [profile] : [] };
    } catch (error) { if (error instanceof AccountStateError || error instanceof ConfigStorageError) throw error; throw new AccountStateError(); }
  }
  async snapshot(): Promise<AccountSnapshot> {
    const state = await this.#read();
    const profile = state.profiles.find(value => value.id === state.activeProfileId);
    const config = profile?.config ?? null;
    const identity = config ? accountIdentity(config) : "";
    const scope = createHash("sha256").update(`${identity}:${profile?.id ?? ""}:${state.revision}`).digest("hex");
    const ciphertext = profile?.ciphertext;
    const unprotect = this.#unprotect;
    return Object.freeze({
      config: config ? freezeConfig(config) : null, revision: state.revision, scope,
      ...(profile ? { profileId: profile.id, profileName: profile.name } : {}), credentialStored: Boolean(ciphertext),
      async unlock() {
        if (!ciphertext) return undefined;
        try {
          const bytes = Buffer.from(ciphertext, "base64");
          if (bytes.toString("base64") !== ciphertext) throw new AccountStateError();
          return z.strictObject({ accountId: z.literal(identity), secret: z.string().min(1).max(1024) }).parse(JSON.parse(await unprotect(bytes))).secret;
        } catch { throw new AccountStateError(); }
      },
    });
  }
  async listProfiles(): Promise<AccountProfileList> {
    const state = await this.#read();
    return { revision: state.revision, activeProfileId: state.activeProfileId,
      profiles: state.profiles.map(profile => ({ id: profile.id, name: profile.name, email: profile.config.email, credentialStored: Boolean(profile.ciphertext) })) };
  }
  async #update(expectedRevision: string, change: (state: { activeProfileId: string | null; profiles: Profile[] }) => Promise<void>): Promise<string> {
    const before = await this.#read();
    if (before.revision !== expectedRevision) throw new AccountStateError();
    const state = { activeProfileId: before.activeProfileId, profiles: structuredClone(before.profiles) };
    await change(state);
    const next: Profiles = profilesSchema.parse({ version: 2, revision: randomUUID(), ...state });
    await this.#storage.compareAndSwap(before.raw, JSON.stringify(next) + "\n");
    return next.revision;
  }
  async saveConfig(config: QqMailConfig, expectedRevision: string): Promise<string> {
    const parsed = configSchema.parse(config);
    return this.#update(expectedRevision, async state => {
      const profile = state.profiles.find(value => value.id === state.activeProfileId);
      if (profile) {
        if (accountIdentity(profile.config) !== accountIdentity(parsed)) profile.ciphertext = null;
        profile.config = parsed;
      } else {
        const id = "profile_" + randomUUID().replaceAll("-", "");
        state.profiles.push({ id, name: "默认账户", config: parsed, ciphertext: null }); state.activeProfileId = id;
      }
    });
  }
  async setCredential(secret: string, expectedRevision: string): Promise<void> {
    if (!secret || secret.length > 1024 || /[\0\r\n]/u.test(secret)) throw new AccountStateError();
    await this.#update(expectedRevision, async state => {
      const profile = state.profiles.find(value => value.id === state.activeProfileId);
      if (!profile) throw new AccountStateError();
      profile.ciphertext = (await this.#protect(JSON.stringify({ accountId: accountIdentity(profile.config), secret }))).toString("base64");
    });
  }
  async clearCredential(expectedRevision: string): Promise<void> {
    await this.#update(expectedRevision, async state => {
      const profile = state.profiles.find(value => value.id === state.activeProfileId);
      if (!profile) throw new AccountStateError(); profile.ciphertext = null;
    });
  }
  async createProfile(name: string, config: QqMailConfig, expectedRevision: string): Promise<{ profileId: string; revision: string }> {
    const profile = profileSchema.parse({ id: "profile_" + randomUUID().replaceAll("-", ""), name, config, ciphertext: null });
    const revision = await this.#update(expectedRevision, async state => {
      if (state.profiles.length >= MAX_ACCOUNT_PROFILES) throw new AccountStateError("PROFILE_LIMIT", "At most 20 account profiles may be saved.");
      state.profiles.push(profile); state.activeProfileId = profile.id;
    });
    return { profileId: profile.id, revision };
  }
  async switchProfile(profileId: string, expectedRevision: string): Promise<string> {
    return this.#update(expectedRevision, async state => {
      if (!state.profiles.some(profile => profile.id === profileId)) throw new AccountStateError("PROFILE_NOT_FOUND", "The account profile no longer exists.");
      state.activeProfileId = profileId;
    });
  }
  async deleteProfile(profileId: string, expectedRevision: string, replacementProfileId?: string): Promise<string> {
    return this.#update(expectedRevision, async state => {
      if (!state.profiles.some(profile => profile.id === profileId)) throw new AccountStateError("PROFILE_NOT_FOUND", "The account profile no longer exists.");
      const remaining = state.profiles.filter(profile => profile.id !== profileId);
      if (state.activeProfileId === profileId) {
        if (remaining.length && !remaining.some(profile => profile.id === replacementProfileId)) throw new AccountStateError("PROFILE_REPLACEMENT_REQUIRED", "Choose the account to activate after deleting the current profile.");
        state.activeProfileId = remaining.length ? replacementProfileId! : null;
      } else if (replacementProfileId !== undefined) throw new AccountStateError("INVALID_PROFILE_REPLACEMENT", "Only deletion of the active profile may select a replacement.");
      state.profiles = remaining;
    });
  }
}
function freezeConfig(config: QqMailConfig): QqMailConfig {
  const copy = structuredClone(config); Object.freeze(copy.imap); Object.freeze(copy.smtp); return Object.freeze(copy);
}
