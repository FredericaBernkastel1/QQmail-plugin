import { describe, expect, it, vi } from "vitest";
import { createSettingsCallbacks } from "../src/settings/callbacks.js";
import { SettingsServer } from "../src/settings/server.js";
import type { SettingsApproval } from "../src/settings/approval.js";
import type { SettingsFormConfig, SettingsTestRequest } from "../src/settings/types.js";
import type { ImapGateway, SmtpGateway } from "../src/mail/types.js";
import { compileOutgoingMessage } from "../src/mail/gateways.js";
import { parseIncomingMessage } from "../src/mail/mime.js";
import type { OutgoingMessage } from "../src/mail/types.js";
import { openSafeDownloadFile, type DownloadFileSystem } from "../src/security.js";
import { createConfig, type QqMailConfig } from "../src/config.js";

const context = () => ({ signal: new AbortController().signal });
function form(): SettingsFormConfig {
  return {
    provider: "custom", email: "synthetic@example.test", displayName: "Synthetic",
    imap: { host: "unapproved.example.test", port: 993, security: "tls", rejectUnauthorized: true },
    smtp: { host: "unapproved.example.test", port: 465, security: "tls", rejectUnauthorized: true },
    folders: { inbox: "INBOX", sent: "Sent", trash: "Trash", drafts: "Drafts", spam: "Junk", archive: "Archive" },
    downloadDirectory: "D:\\Synthetic\\Downloads",
  };
}
function harness(settingsApproval?: SettingsApproval) {
  const credentialStore = {
    get: vi.fn(async () => "SYNTHETIC_SECRET_NOT_FOR_EXPORT"),
    set: vi.fn(async () => undefined), delete: vi.fn(async () => undefined),
  };
  const cfg = form();
  const configured = createConfig({ preset: "custom", email: cfg.email,
    imap: cfg.imap, smtp: cfg.smtp, downloadDirectory: cfg.downloadDirectory });
  const configStore = { load: vi.fn(async () => configured), save: vi.fn(async (_config: QqMailConfig) => "a".repeat(36)) };
  const accountStore = {
    snapshot: vi.fn(async () => ({
      config: configured, revision: "a".repeat(36), scope: "a".repeat(64),
      credentialStored: true, unlock: () => credentialStore.get(),
    })),
    saveConfig: configStore.save,
    setCredential: credentialStore.set,
    clearCredential: credentialStore.delete,
  };
  const imapGateway = { connect: vi.fn(async () => { throw Error("Synthetic rejection"); }) };
  const smtpGateway = { verify: vi.fn(async () => undefined), send: vi.fn() };
  const callbacks = createSettingsCallbacks({
    accountStore, imapGateway: imapGateway as ImapGateway,
    smtpGateway: smtpGateway as SmtpGateway,
    ...(settingsApproval ? { settingsApproval } : {}),
    defaultDownloadDirectory: "D:\\Synthetic\\Downloads",
  });
  return { callbacks, credentialStore, configStore, imapGateway, smtpGateway };
}

describe("authorization before credential egress", () => {
  for (const target of ["imap", "smtp"] as const) {
    it(`denies ${target} with no trusted approval before reading credentials or connecting`, async () => {
      const h = harness();
      expect(await h.callbacks.test({ target, config: form() }, context())).toMatchObject({ ok: false });
      expect(h.credentialStore.get).not.toHaveBeenCalled();
      expect(h.imapGateway.connect).not.toHaveBeenCalled();
      expect(h.smtpGateway.verify).not.toHaveBeenCalled();
    });
  }
  it("does not let a bearer token substitute for human approval through the real HTTP handler", async () => {
    const h = harness();
    const server = await new SettingsServer({ callbacks: h.callbacks, html: "<html>synthetic</html>" }).start();
    try {
      const session = server.createSession();
      const response = await fetch(`${server.origin}/api/test`, {
        method: "POST",
        headers: { Origin: server.origin, Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ target: "smtp", config: form(), approved: true }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false });
      expect(h.credentialStore.get).not.toHaveBeenCalled();
      expect(h.smtpGateway.verify).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it("requires approval for config persistence, credential replacement and deletion", async () => {
    const h = harness();
    expect(await h.callbacks.save({ config: form() }, context())).toMatchObject({ ok: false });
    expect(await h.callbacks.setCredential("synthetic-new", context(), "a".repeat(36))).toMatchObject({ ok: false });
    expect(await h.callbacks.clear(context())).toMatchObject({ ok: false });
    expect(h.configStore.save).not.toHaveBeenCalled();
    expect(h.credentialStore.set).not.toHaveBeenCalled();
    expect(h.credentialStore.delete).not.toHaveBeenCalled();
  });
  it("binds test approval to a snapshot of the exact destination and protocol", async () => {
    const request: SettingsTestRequest = { target: "smtp", config: form() };
    const confirm = vi.fn(async review => {
      expect(review.action).toBe("test-smtp");
      expect(review.details.destination).toEqual({ host: "unapproved.example.test", port: 465, security: "tls" });
      expect(JSON.stringify(review)).not.toContain("SYNTHETIC_SECRET");
      request.target = "imap";
      request.config.smtp.host = "changed.example.test";
      review.details.destination.host = "tampered.example.test";
      return true;
    });
    const h = harness({ confirm });
    expect(await h.callbacks.test(request, context())).toMatchObject({ ok: true });
    expect(h.smtpGateway.verify).toHaveBeenCalledExactlyOnceWith(
      { host: "unapproved.example.test", port: 465, security: "tls" },
      "synthetic@example.test", "SYNTHETIC_SECRET_NOT_FOR_EXPORT",
    );
    expect(h.imapGateway.connect).not.toHaveBeenCalled();
  });
  it("keeps the complete saved configuration stable while approval is pending", async () => {
    const config = form();
    const h = harness({ confirm: async review => {
      config.smtp.host = "changed.example.test";
      (review.details.smtp as { host: string }).host = "tampered.example.test";
      return true;
    } });
    expect(await h.callbacks.save({ config }, context())).toMatchObject({ ok: true });
    expect(h.configStore.save.mock.calls[0]![0].smtp.host).toBe("unapproved.example.test");
  });
  it("does not send secrets or persist changes after approval errors", async () => {
    const h = harness({ confirm: async () => { throw Error("Synthetic failure"); } });
    expect(await h.callbacks.test({ target: "smtp", config: form() }, context())).toMatchObject({ ok: false });
    expect(h.credentialStore.get).not.toHaveBeenCalled();
    expect(h.smtpGateway.verify).not.toHaveBeenCalled();
  });
  it("rejects concurrent settings mutations and resumes after cancellation", async () => {
    let decide!: (allow: boolean) => void;
    const h = harness({ confirm: () => new Promise(resolve => { decide = resolve; }) });
    const pending = h.callbacks.test({ target: "smtp", config: form() }, context());
    expect(await h.callbacks.clear(context())).toMatchObject({ ok: false });
    expect(h.credentialStore.delete).not.toHaveBeenCalled();
    decide(false);
    expect(await pending).toMatchObject({ ok: false });
    const next = h.callbacks.setCredential("synthetic-next", context(), "a".repeat(36));
    await Promise.resolve();
    decide(true);
    expect(await next).toMatchObject({ ok: true });
  });
  it("does not read credentials when the request is aborted during approval", async () => {
    const abort = new AbortController();
    const h = harness({ confirm: async () => { abort.abort(); return true; } });
    await expect(h.callbacks.test({ target: "smtp", config: form() }, { signal: abort.signal })).rejects.toThrow();
    expect(h.credentialStore.get).not.toHaveBeenCalled();
    expect(h.smtpGateway.verify).not.toHaveBeenCalled();
  });
});

describe("mail content is not a source of network or local-file reads", () => {
  for (const text of [{ path: "https://unapproved.example.test/tracker" }, { path: "D:\\Synthetic\\private.txt" }]) {
    it(`refuses compiler content descriptors: ${text.path}`, async () => {
      const message = {
        from: { address: "sender@example.test" }, to: [{ address: "receiver@example.test" }],
        cc: [], bcc: [], subject: "Synthetic", text,
      } as unknown as OutgoingMessage;
      await expect(compileOutgoingMessage(message)).rejects.toThrow(/access rejected/i);
    });
  }
  it("does not fetch remote images, styles or external entities while parsing hostile mail", async () => {
    const parsed = await parseIncomingMessage(Buffer.from(
      'From: sender@example.test\r\nTo: receiver@example.test\r\nContent-Type: text/html\r\n\r\n' +
      '<style>@import "https://unapproved.example.test/style"</style><img src="https://unapproved.example.test/pixel">' +
      '<iframe src="file:///D:/Synthetic/private.txt"></iframe><p>Safe synthetic text</p>',
    ));
    expect(parsed.text).toBe("Safe synthetic text");
  });
});

describe("download destinations cannot redirect to network shares", () => {
  function filesystem() {
    return {
      isLocalDrive: vi.fn(async () => true),
      mkdir: vi.fn(async () => undefined),
      lstat: vi.fn(async () => ({ isSymbolicLink: (): boolean => false })),
      realpath: vi.fn(async () => "D:\\Synthetic\\Downloads"),
      openExclusive: vi.fn(async () => ({ write: async () => ({ bytesWritten: 1 }), close: async () => undefined })),
      unlink: vi.fn(async () => undefined),
    } satisfies DownloadFileSystem;
  }
  it("rejects mapped network drives before probing any directory or creating files", async () => {
    const fs = filesystem();
    fs.isLocalDrive.mockResolvedValue(false);
    await expect(openSafeDownloadFile("Z:\\Mailbox\\Files", "synthetic.txt", { fileSystem: fs }))
      .rejects.toMatchObject({ code: "UNSAFE_DOWNLOAD_PATH" });
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.openExclusive).not.toHaveBeenCalled();
  });
  it("rejects a junction in a parent before recursive directory creation", async () => {
    const fs = filesystem();
    fs.lstat.mockResolvedValue({ isSymbolicLink: () => true });
    await expect(openSafeDownloadFile("D:\\Redirected\\New\\Downloads", "synthetic.txt", { fileSystem: fs }))
      .rejects.toMatchObject({ code: "UNSAFE_DOWNLOAD_PATH" });
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.openExclusive).not.toHaveBeenCalled();
  });
  it("also rejects a resolved UNC destination without writing attachment bytes", async () => {
    const fs = filesystem();
    fs.realpath.mockResolvedValue("\\\\synthetic.test\\share\\Downloads");
    await expect(openSafeDownloadFile("D:\\Synthetic\\Downloads", "synthetic.txt", { fileSystem: fs }))
      .rejects.toMatchObject({ code: "UNSAFE_DOWNLOAD_PATH" });
    expect(fs.openExclusive).not.toHaveBeenCalled();
  });
});
