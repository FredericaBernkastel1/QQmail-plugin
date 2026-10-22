import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AccountStore } from "../src/account-store.js";
import { DraftStore } from "../src/drafts.js";
import { QqMailService, createStoredMailAccountProvider, coreMessageReferenceCodec, type ImapSession,
  type MailAccountProvider, type OutgoingMessage } from "../src/mail/index.js";
import { memoryStore, syntheticConfig } from "./account-fixtures.js";

async function configured() {
  const result = memoryStore(syntheticConfig());
  await result.store.setCredential("SYNTHETIC_A", (await result.store.snapshot()).revision);
  return result;
}
function harness(provider: MailAccountProvider, approve: () => Promise<boolean> = async () => true) {
  const session: ImapSession = {
    listMailboxes: vi.fn(async () => ["INBOX", "Sent Messages", "Deleted Messages"].map(p => ({
      path: p, delimiter: "/", flags: [], subscribed: true,
    }))),
    selectMailbox: vi.fn(async p => ({ path: p, uidValidity: "42", exists: 2, readOnly: false })),
    search: vi.fn(async () => [1, 2]),
    fetchMessages: vi.fn(async (ids: number[]) => ids.map(uid => ({ uid, flags: new Set<string>() }))),
    addFlags: vi.fn(async () => undefined), removeFlags: vi.fn(async () => undefined),
    moveMessages: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    downloadPart: vi.fn(async () => ({ expectedSize: 0, contentType: "text/plain", content: Readable.from([]) })),
    appendMessage: vi.fn(async () => undefined),
  };
  const connect = vi.fn(async (_server, _username, _secret) => session);
  const send = vi.fn(async () => ({
    messageId: "<synthetic@example.test>", accepted: ["recipient@example.test"], rejected: [],
    rawMessage: Buffer.from("synthetic"),
  }));
  const service = new QqMailService({
    accountProvider: provider, referenceCodec: coreMessageReferenceCodec,
    draftStore: new DraftStore<OutgoingMessage, Record<string, unknown>>(),
    attachmentStorage: { save: async () => { throw Error("No attachment writes"); } },
    imapGateway: { connect }, smtpGateway: { verify: async () => undefined, send },
    sendApproval: { confirm: approve },
    mutationApproval: { confirm: async () => ({ status: "approved" }) },
  });
  return { service, session, connect, send };
}

describe("account state and credential boundaries", () => {
  it("imports legacy public config without assuming ownership of an old credential", async () => {
    const { store } = memoryStore(syntheticConfig());
    const state = await store.snapshot();
    expect(state.config?.email).toBe("user@qq.com");
    expect(state.credentialStored).toBe(false);
    expect(await state.unlock()).toBeUndefined();
  });

  it("keeps an in-flight IMAP connection on the original account and original credential", async () => {
    const { store } = await configured();
    const provider = createStoredMailAccountProvider(store);
    const h = harness({ getContext: async () => {
      const captured = await provider.getContext();
      await store.saveConfig(syntheticConfig("other@qq.com"), (await store.snapshot()).revision);
      await store.setCredential("SYNTHETIC_B", (await store.snapshot()).revision);
      return captured;
    } });
    await h.service.listMailboxes();
    expect(h.connect).toHaveBeenCalledWith(expect.anything(), "user@qq.com", "SYNTHETIC_A");
  });

  it("invalidates credentials when the account or endpoints change, including after restart", async () => {
    for (const change of ["email", "username", "imap", "smtp"] as const) {
      const { store, restart } = await configured();
      const config = syntheticConfig();
      if (change === "email" || change === "username") config[change] = "other@qq.com";
      else { config.preset = "custom"; config[change].host = "other.example.test"; }
      await store.saveConfig(config, (await store.snapshot()).revision);
      expect(await restart().snapshot()).toMatchObject({ credentialStored: false });
      expect(await (await restart().snapshot()).unlock()).toBeUndefined();
    }
  });

  it("does not publish half a credential update if persistence fails", async () => {
    const { store, storage } = await configured();
    const before = await store.snapshot();
    vi.spyOn(storage, "compareAndSwap").mockRejectedValueOnce(Error("Synthetic disk failure"));
    await expect(store.setCredential("SYNTHETIC_B", before.revision)).rejects.toThrow();
    const after = await store.snapshot();
    expect(after.revision).toBe(before.revision);
    expect(await after.unlock()).toBe("SYNTHETIC_A");
  });

  it("rejects concurrent revisions and A-to-B-to-A state reuse", async () => {
    const { store } = await configured();
    const before = await store.snapshot();
    await store.saveConfig(syntheticConfig("other@qq.com"), before.revision);
    await store.saveConfig(syntheticConfig(), (await store.snapshot()).revision);
    await expect(store.setCredential("SYNTHETIC_A", before.revision)).rejects.toThrow();
    expect((await store.snapshot()).scope).not.toBe(before.scope);
  });

  it("rejects a delayed encryption result when another process committed an account change", async () => {
    const { store, restart, protection } = await configured();
    const before = await store.snapshot();
    const encrypt = protection.protect;
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const spy = vi.spyOn(protection, "protect");
    // A new instance captures this test-only delayed protection provider.
    spy.mockImplementationOnce(async plain => { await paused; return encrypt(plain); });
    const writer = restart();
    const pending = writer.setCredential("SYNTHETIC_DELAYED_A", before.revision);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    await store.saveConfig(syntheticConfig("other@qq.com"), before.revision);
    resume();
    await expect(pending).rejects.toThrow();
    expect((await store.snapshot()).config?.email).toBe("other@qq.com");
    expect((await store.snapshot()).credentialStored).toBe(false);
  });

  it("rejects relabeling encrypted material as another account", async () => {
    const { store, storage } = await configured();
    const raw = await storage.read();
    const changed = JSON.parse(raw!);
    changed.profiles[0].config = syntheticConfig("other@qq.com");
    await storage.compareAndSwap(raw, JSON.stringify(changed));
    await expect((await store.snapshot()).unlock()).rejects.toThrow();
  });

  it("atomically persists a DPAPI-protected record and fails closed on a competing file lock", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "qqmail-account-"));
    try {
      const store = new AccountStore({ directory });
      await store.saveConfig(syntheticConfig(), (await store.snapshot()).revision);
      const state = await store.snapshot();
      await store.setCredential("SYNTHETIC_DPAPI_SECRET", state.revision);
      const raw = await readFile(path.join(directory, "account-profiles.json"), "utf8");
      expect(raw).not.toContain("SYNTHETIC_DPAPI_SECRET");
      const restarted = new AccountStore({ directory });
      expect(await (await restarted.snapshot()).unlock()).toBe("SYNTHETIC_DPAPI_SECRET");
      await writeFile(path.join(directory, "account.lock"), "synthetic competing writer");
      await expect(restarted.clearCredential((await restarted.snapshot()).revision)).rejects.toThrow();
      expect(await readFile(path.join(directory, "account-profiles.json"), "utf8")).toBe(raw);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 15_000);
});

describe("account-scoped mail objects", () => {
  for (const operation of ["flags", "move", "trash"] as const) {
    for (const waitingAt of ["connect", "select"] as const) {
      for (const change of ["account", "credential", "roundtrip"] as const) {
        it(`blocks interactive ${operation} after ${change} changes during ${waitingAt}`, async () => {
          const { store } = await configured();
          const h = harness(createStoredMailAccountProvider(store));
          const found = await h.service.searchEmails({}) as { messages: { messageRef: string }[] };
          const messageRefs = [found.messages[0]!.messageRef];
          const changeAccount = async () => {
            if (change === "credential") await store.setCredential("SYNTHETIC_REPLACED", (await store.snapshot()).revision);
            else {
              await store.saveConfig(syntheticConfig("other@qq.com"), (await store.snapshot()).revision);
              if (change === "roundtrip") await store.saveConfig(syntheticConfig(), (await store.snapshot()).revision);
            }
          };
          if (waitingAt === "connect") h.connect.mockImplementationOnce(async () => { await changeAccount(); return h.session; });
          else vi.mocked(h.session.selectMailbox).mockImplementationOnce(async mailbox => {
            await changeAccount(); return { path: mailbox, uidValidity: "42", exists: 2, readOnly: false };
          });
          const request = operation === "flags" ? h.service.setEmailFlags({ messageRefs, read: true })
            : operation === "move" ? h.service.moveEmails({ messageRefs, destination: "Sent Messages" })
            : h.service.trashEmails({ messageRefs });
          await expect(request).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
          expect(h.session.addFlags).not.toHaveBeenCalled();
          expect(h.session.removeFlags).not.toHaveBeenCalled();
          expect(h.session.moveMessages).not.toHaveBeenCalled();
          expect(h.session.close).toHaveBeenCalled();
        });
      }
    }
  }

  it("stops the second flag write and reports uncertainty after an account change", async () => {
    const { store } = await configured();
    const h = harness(createStoredMailAccountProvider(store));
    const found = await h.service.searchEmails({}) as { messages: { messageRef: string }[] };
    vi.mocked(h.session.addFlags).mockImplementationOnce(async () => {
      await store.setCredential("SYNTHETIC_REPLACED", (await store.snapshot()).revision);
    });
    await expect(h.service.setEmailFlags({ messageRefs: [found.messages[0]!.messageRef], read: true, starred: false }))
      .resolves.toMatchObject({ ok: false, status: "partial_failure", unconfirmed: 1, failure: { code: "ACCOUNT_CHANGED" } });
    expect(h.session.addFlags).toHaveBeenCalledOnce();
    expect(h.session.removeFlags).not.toHaveBeenCalled();
  });

  for (const operation of ["read", "batch", "thread", "flags", "move", "trash", "download", "reply"]) {
    it(`rejects a previous account's reference before ${operation}`, async () => {
      const { store } = await configured();
      const h = harness(createStoredMailAccountProvider(store));
      const result = await h.service.searchEmails({}) as { messages: { messageRef: string }[] };
      const messageRef = result.messages[0]!.messageRef;
      await store.saveConfig(syntheticConfig("other@qq.com"), (await store.snapshot()).revision);
      await store.setCredential("SYNTHETIC_B", (await store.snapshot()).revision);
      h.connect.mockClear();
      const calls: Record<string, () => Promise<unknown>> = {
        read: () => h.service.readEmail({ messageRef }),
        batch: () => h.service.batchReadEmails({ messageRefs: [messageRef] }),
        thread: () => h.service.readEmailThread({ messageRef, maxMessages: 5 }),
        flags: () => h.service.setEmailFlags({ messageRefs: [messageRef], read: true }),
        move: () => h.service.moveEmails({ messageRefs: [messageRef], destination: "Sent Messages" }),
        trash: () => h.service.trashEmails({ messageRefs: [messageRef] }),
        download: () => h.service.downloadAttachment({ messageRef, attachmentId: "1" }),
        reply: () => h.service.prepareEmail({ mode: "reply", sourceRef: messageRef, text: "Synthetic" }),
      };
      await expect(calls[operation]!()).rejects.toMatchObject({ code: "STALE_MESSAGE_REFERENCE" });
      expect(h.connect).not.toHaveBeenCalled();
      expect(h.session.moveMessages).not.toHaveBeenCalled();
    });
  }

  it("rejects a previous account's pagination cursor", async () => {
    const { store } = await configured();
    const h = harness(createStoredMailAccountProvider(store));
    const result = await h.service.searchEmails({ limit: 1 }) as { nextCursor: string };
    await store.saveConfig(syntheticConfig("other@qq.com"), (await store.snapshot()).revision);
    await store.setCredential("SYNTHETIC_B", (await store.snapshot()).revision);
    h.session.search = vi.fn(async () => []);
    await expect(h.service.searchEmails({ cursor: result.nextCursor, limit: 1 })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(h.session.search).not.toHaveBeenCalled();
  });

  it("rejects a credential-only change while the send confirmation is pending", async () => {
    const { store } = await configured();
    const h = harness(createStoredMailAccountProvider(store), async () => {
      await store.setCredential("SYNTHETIC_REPLACED", (await store.snapshot()).revision);
      return true;
    });
    const draft = await h.service.prepareEmail({ to: ["recipient@example.test"], text: "Synthetic" }) as { draftId: string };
    await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_ACCOUNT_CHANGED" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("rejects a change during credential decryption before SMTP dispatch", async () => {
    const { store } = await configured();
    const provider = createStoredMailAccountProvider(store);
    let approved = false;
    const h = harness({
      getContext: async () => {
        const captured = (await provider.getContext())!;
        return { ...captured, getAuthorizationCode: async () => {
          if (approved) await store.clearCredential((await store.snapshot()).revision);
          return captured.getAuthorizationCode();
        } };
      },
    }, async () => { approved = true; return true; });
    const draft = await h.service.prepareEmail({ to: ["recipient@example.test"], text: "Synthetic" }) as { draftId: string };
    await expect(h.service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_ACCOUNT_CHANGED" });
    expect(h.send).not.toHaveBeenCalled();
  });
});
