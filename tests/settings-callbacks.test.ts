import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { QqMailConfig } from "../src/config.js";
import { memoryStore, syntheticConfig } from "./account-fixtures.js";
import type {
  ImapGateway,
  ImapSession,
  SmtpGateway,
} from "../src/mail/index.js";
import { createSettingsCallbacks } from "../src/settings/callbacks.js";
import type { SettingsFormConfig } from "../src/settings/types.js";

const context = { signal: new AbortController().signal };
const checkedAt = Date.parse("2026-07-24T00:00:00.000Z");

function form(overrides: Partial<SettingsFormConfig> = {}): SettingsFormConfig {
  return {
    provider: "personal",
    email: "user@qq.com",
    displayName: "QQ User",
    imap: {
      host: "imap.qq.com",
      port: 993,
      security: "tls",
      rejectUnauthorized: true,
    },
    smtp: {
      host: "smtp.qq.com",
      port: 465,
      security: "tls",
      rejectUnauthorized: true,
    },
    folders: {
      inbox: "INBOX",
      sent: "Sent Messages",
      drafts: "Drafts",
      trash: "Deleted Messages",
      spam: "Junk",
      archive: "Archive",
    },
    downloadDirectory: "C:\\Users\\QQ User\\Downloads\\QQ Mail",
    ...overrides,
  };
}

function fakeSession(): ImapSession {
  return {
    listMailboxes: vi.fn(async () => [
      { path: "INBOX", delimiter: "/", flags: [], subscribed: true },
      { path: "Sent Messages", delimiter: "/", specialUse: "\\Sent", flags: [], subscribed: true },
      { path: "Drafts", delimiter: "/", specialUse: "\\Drafts", flags: [], subscribed: true },
      { path: "Deleted Messages", delimiter: "/", specialUse: "\\Trash", flags: [], subscribed: true },
      { path: "Junk", delimiter: "/", specialUse: "\\Junk", flags: [], subscribed: true },
      { path: "Archive", delimiter: "/", specialUse: "\\Archive", flags: [], subscribed: true },
    ]),
    selectMailbox: vi.fn(async (path: string) => ({
      path,
      uidValidity: "1",
      exists: 0,
      readOnly: false,
    })),
    search: vi.fn(async () => []),
    fetchMessages: vi.fn(async () => []),
    addFlags: vi.fn(async () => undefined),
    removeFlags: vi.fn(async () => undefined),
    moveMessages: vi.fn(async () => undefined),
    downloadPart: vi.fn(async () => ({
      expectedSize: 0,
      contentType: "application/octet-stream",
      content: Readable.from([]),
    })),
    appendMessage: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

async function harness(options: { stored?: QqMailConfig | null; credential?: string | null } = {}) {
  const { store: accountStore } = memoryStore(options.stored ?? null);
  if (options.stored && options.credential) {
    await accountStore.setCredential(options.credential, (await accountStore.snapshot()).revision);
  }
  const saveConfig = vi.spyOn(accountStore, "saveConfig");
  const configStore = { save: saveConfig };
  const credentialStore = {
    set: vi.spyOn(accountStore, "setCredential"),
    delete: vi.spyOn(accountStore, "clearCredential"),
  };
  const session = fakeSession();
  const imapGateway: ImapGateway = {
    connect: vi.fn(async () => session),
  };
  const smtpGateway: SmtpGateway = {
    verify: vi.fn(async () => undefined),
    send: vi.fn(async () => ({
      messageId: "<test@example.com>",
      accepted: [],
      rejected: [],
      rawMessage: Buffer.alloc(0),
    })),
  };
  const callbacks = createSettingsCallbacks({
    accountStore,
    imapGateway,
    smtpGateway,
    now: () => checkedAt,
    defaultDownloadDirectory: "C:\\Users\\QQ User\\Downloads\\QQ Mail",
    settingsApproval: { confirm: async () => true },
  });
  return {
    callbacks,
    accountStore,
    configStore,
    credentialStore,
    imapGateway,
    smtpGateway,
    session,
    saveConfig,
  };
}

describe("settings callbacks", () => {
  it("discards a delayed connection result after an external active-profile change", async () => {
    const h = await harness({ stored: syntheticConfig(), credential: "SYNTHETIC_A" });
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(h.smtpGateway.verify).mockImplementationOnce(async () => pending);
    const testing = h.callbacks.test({ target: "smtp", config: form() }, context);
    await vi.waitFor(() => expect(h.smtpGateway.verify).toHaveBeenCalledOnce());
    const b = await h.accountStore.createProfile("Work", syntheticConfig("work@qq.com"), (await h.accountStore.snapshot()).revision);
    await h.accountStore.setCredential("SYNTHETIC_B", b.revision);
    finish();
    expect(await testing).toMatchObject({ ok: false });
    const status = await h.callbacks.getStatus(context);
    expect(status).toMatchObject({ imap: { state: "unknown" }, smtp: { state: "unknown" }, folders: { state: "unknown" } });
    expect(status.accountScope).toBe((await h.accountStore.snapshot()).scope);
  });

  it("hides prior connection success after a credential revision changes", async () => {
    const h = await harness({ stored: syntheticConfig(), credential: "SYNTHETIC_A" });
    expect(await h.callbacks.test({ target: "smtp", config: form() }, context)).toMatchObject({ ok: true });
    expect(await h.callbacks.getStatus(context)).toMatchObject({ smtp: { state: "ok" } });
    await h.accountStore.setCredential("SYNTHETIC_B", (await h.accountStore.snapshot()).revision);
    expect(await h.callbacks.getStatus(context)).toMatchObject({ smtp: { state: "unknown" } });
  });

  it("rejects saving an old form revision before requesting approval", async () => {
    const h = await harness({ stored: syntheticConfig(), credential: "SYNTHETIC_A" });
    const previous = (await h.accountStore.snapshot()).revision;
    await h.accountStore.createProfile("Work", syntheticConfig("work@qq.com"), previous);
    expect(await h.callbacks.save({ config: form(), expectedRevision: previous }, context)).toMatchObject({ ok: false });
    expect(h.saveConfig).not.toHaveBeenCalled();
    expect((await h.accountStore.snapshot()).config?.email).toBe("work@qq.com");
  });

  it("requires native approval to create, switch and delete a profile without copying a credential", async () => {
    const h = await harness({ stored: syntheticConfig(), credential: "SYNTHETIC_A" });
    const confirm = vi.fn(async () => false);
    const callbacks = createSettingsCallbacks({ accountStore: h.accountStore, settingsApproval: { confirm } });
    const original = await h.accountStore.listProfiles();
    const request = { action: "create" as const, name: "Work", config: form({ email: "work@qq.com" }), expectedRevision: original.revision };
    expect(await callbacks.changeProfile!(request, context)).toMatchObject({ ok: false });
    expect((await h.accountStore.listProfiles()).profiles).toHaveLength(1);
    confirm.mockResolvedValue(true);
    expect(await callbacks.changeProfile!(request, context)).toMatchObject({ ok: true });
    const created = await h.accountStore.snapshot();
    expect(created.credentialStored).toBe(false);
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ action: "create-profile" }));
    expect(await callbacks.changeProfile!({ action: "delete", profileId: created.profileId!, replacementProfileId: original.activeProfileId!, expectedRevision: created.revision }, context)).toMatchObject({ ok: true });
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ action: "delete-profile", details: expect.objectContaining({ deletingActiveProfile: true }) }));
    expect(await (await h.accountStore.snapshot()).unlock()).toBe("SYNTHETIC_A");
  });

  it("rejects a credential submission for a form revision that was replaced", async () => {
    const h = await harness({ stored: syntheticConfig() });
    const oldRevision = (await h.accountStore.snapshot()).revision;
    await h.accountStore.saveConfig(syntheticConfig("other@qq.com"), oldRevision);
    expect(await h.callbacks.setCredential("SYNTHETIC", context, oldRevision)).toMatchObject({ ok: false });
    expect(h.credentialStore.set).not.toHaveBeenCalled();
  });

  it("returns useful fresh defaults without exposing the stored credential", async () => {
    const secret = "authorization-code-secret";
    const { callbacks } = await harness({ credential: secret });

    const config = await callbacks.getConfig(context);
    const status = await callbacks.getStatus(context);

    expect(config).toMatchObject({
      provider: "personal",
      email: "",
      credentialStored: false,
      imap: { host: "imap.qq.com", rejectUnauthorized: true },
      smtp: { host: "smtp.qq.com", rejectUnauthorized: true },
    });
    expect(status).toMatchObject({ configured: false, credentialStored: false });
    expect(JSON.stringify({ config, status })).not.toContain(secret);
  });

  it("maps all six folder fields into config storage without writing credentials", async () => {
    const { callbacks, configStore, credentialStore, saveConfig } = await harness();

    const result = await callbacks.save({ config: form() }, context);

    expect(result.ok).toBe(true);
    expect(configStore.save).toHaveBeenCalledWith(expect.objectContaining({
      preset: "personal",
      email: "user@qq.com",
      username: "user@qq.com",
      inboxMailbox: "INBOX",
      sentMailbox: "Sent Messages",
      draftsMailbox: "Drafts",
      trashMailbox: "Deleted Messages",
      spamMailbox: "Junk",
      archiveMailbox: "Archive",
    }), expect.any(String));
    expect(credentialStore.set).not.toHaveBeenCalled();
    expect(JSON.stringify(saveConfig.mock.calls[0]?.[0]))
      .not.toMatch(/authorization|credential|password|secret/iu);
  });

  it("rejects saving non-local download directory paths", async () => {
    for (const downloadDirectory of [
      "Downloads\\QQ Mail",
      "\\\\server\\share\\QQ Mail",
      "\\\\?\\C:\\Downloads\\QQ Mail",
    ]) {
      const { callbacks, configStore } = await harness();
      await expect(callbacks.save({ config: form({ downloadDirectory }) }, context))
        .resolves.toMatchObject({ ok: false });
      expect(configStore.save).not.toHaveBeenCalled();
    }
  });

  it("stores and clears only the credential", async () => {
    const { callbacks, accountStore, configStore, credentialStore } = await harness({ stored: syntheticConfig() });
    const revision = (await accountStore.snapshot()).revision;

    await expect(callbacks.setCredential("  replacement-code  ", context, revision))
      .resolves.toMatchObject({ ok: true });
    expect(credentialStore.set).toHaveBeenCalledWith("replacement-code", revision);

    await expect(callbacks.clear(context)).resolves.toMatchObject({ ok: true });
    expect(credentialStore.delete).toHaveBeenCalledOnce();
    expect(configStore.save).not.toHaveBeenCalled();
  });

  it("rejects unbound endpoints and tests only the saved account", async () => {
    const secret = "authorization-code-secret";
    const { callbacks, accountStore, imapGateway, smtpGateway, session } = await harness({ stored: syntheticConfig(), credential: secret });
    const unsaved = form({
      provider: "custom",
      email: "unsaved@example.com",
      imap: {
        host: "imap.example.com",
        port: 993,
        security: "tls",
        rejectUnauthorized: true,
      },
      smtp: {
        host: "smtp.example.com",
        port: 587,
        security: "starttls",
        rejectUnauthorized: true,
      },
    });

    expect(await callbacks.test({ target: "imap", config: unsaved }, context)).toMatchObject({ ok: false });
    expect(imapGateway.connect).not.toHaveBeenCalled();
    const saved = await callbacks.save({ config: unsaved }, context);
    expect(saved.ok).toBe(true);
    expect((await accountStore.snapshot()).credentialStored).toBe(false);
    await callbacks.setCredential(secret, context, saved.accountRevision!);
    const imapResult = await callbacks.test({ target: "imap", config: unsaved }, context);
    const smtpResult = await callbacks.test({ target: "smtp", config: unsaved }, context);

    expect(imapGateway.connect).toHaveBeenCalledWith(
      { host: "imap.example.com", port: 993, security: "tls" },
      "unsaved@example.com",
      secret,
    );
    expect(smtpGateway.verify).toHaveBeenCalledWith(
      { host: "smtp.example.com", port: 587, security: "starttls" },
      "unsaved@example.com",
      secret,
    );
    expect(imapResult).toMatchObject({
      ok: true,
      imap: { state: "ok" },
      folders: { state: "ok" },
    });
    expect(smtpResult).toMatchObject({ ok: true, smtp: { state: "ok" } });
    expect(session.close).toHaveBeenCalledOnce();
    expect(JSON.stringify({ imapResult, smtpResult })).not.toContain(secret);
  });
});
