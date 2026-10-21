import { testContext } from "./account-fixtures.js";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { simpleParser, type AddressObject } from "mailparser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DraftStore } from "../src/drafts.js";
import { denySendApproval, type SendApprovalRequest } from "../src/approval.js";
import {
  QqMailService,
  SafeLocalAttachmentStorage,
  compileOutgoingMessage,
  coreMessageReferenceCodec,
  type ImapGateway,
  type ImapMessageData,
  type ImapSession,
  type MailAccountConfig,
  type MailAccountProvider,
  type OutgoingMessage,
  type SmtpGateway,
} from "../src/mail/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function account(downloadDirectory = "C:\\Users\\Codex\\Downloads\\QQ Mail"): MailAccountConfig {
  return {
    email: "sender@qq.com",
    username: "sender@qq.com",
    displayName: "Sender",
    imap: { host: "imap.qq.com", port: 993, security: "tls" },
    smtp: { host: "smtp.qq.com", port: 465, security: "tls" },
    folders: {
      inbox: "INBOX",
      sent: "Sent Messages",
      trash: "Deleted Messages",
      drafts: "Drafts",
      spam: "Junk",
    },
    downloadDirectory,
    downloadLimitBytes: 100 * 1024 * 1024,
  };
}

function messageSource(options: {
  subject: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  body?: string;
  contentType?: string;
}): Buffer {
  const headers = [
    'From: "Alice" <alice@example.com>',
    "To: Sender <sender@qq.com>",
    `Subject: ${options.subject}`,
    "Date: Fri, 24 Jul 2026 08:00:00 +0800",
    `Message-ID: ${options.messageId}`,
    ...(options.inReplyTo ? [`In-Reply-To: ${options.inReplyTo}`] : []),
    ...(options.references ? [`References: ${options.references}`] : []),
    `Content-Type: ${options.contentType ?? "text/plain"}; charset=utf-8`,
    "Content-Transfer-Encoding: 8bit",
    "",
    options.body ?? "Hello",
  ];
  return Buffer.from(headers.join("\r\n"), "utf8");
}

function record(uid: number, overrides: Partial<ImapMessageData> = {}): ImapMessageData {
  return {
    uid,
    flags: new Set<string>(),
    size: overrides.source?.length ?? 100,
    internalDate: new Date(`2026-07-24T0${uid}:00:00.000Z`),
    envelope: {
      subject: `Message ${uid}`,
      date: new Date(`2026-07-24T0${uid}:00:00.000Z`),
      from: [{ name: "Alice", address: "alice@example.com" }],
      to: [{ name: "Sender", address: "sender@qq.com" }],
      messageId: `<message-${uid}@example.com>`,
    },
    ...overrides,
  };
}

function parsedAddresses(value: AddressObject | AddressObject[] | undefined): string[] {
  const groups = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return groups.flatMap((group) => group.value.map((recipient) => recipient.address ?? ""));
}

function fakeSession(overrides: Partial<ImapSession> = {}): ImapSession {
  return {
    listMailboxes: vi.fn(async () => [
      { path: "INBOX", delimiter: "/", flags: [], subscribed: true, messages: 5, unseen: 2, uidValidity: "42" },
      { path: "Sent Messages", delimiter: "/", flags: [], subscribed: true, specialUse: "\\Sent" },
      { path: "Deleted Messages", delimiter: "/", flags: [], subscribed: true, specialUse: "\\Trash" },
      { path: "Archive", delimiter: "/", flags: [], subscribed: true, specialUse: "\\Archive" },
    ]),
    selectMailbox: vi.fn(async (mailbox) => ({ path: mailbox, uidValidity: "42", exists: 5, readOnly: false })),
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
    ...overrides,
  };
}

function createHarness(options: {
  session: ImapSession;
  smtp?: SmtpGateway;
  now?: () => number;
  downloadDirectory?: string;
  accountProvider?: MailAccountProvider;
  approve?: (() => Promise<boolean>) | undefined;
}) {
  const imap: ImapGateway = {
    connect: vi.fn(async () => options.session),
  };
  const smtp: SmtpGateway = options.smtp ?? {
    verify: vi.fn(async () => undefined),
    send: vi.fn(async () => ({
      messageId: "<sent@example.com>",
      accepted: ["recipient@example.com"],
      rejected: [],
      rawMessage: Buffer.from("From: sender@qq.com\r\n\r\nBody"),
    })),
  };
  const now = options.now ?? (() => Date.parse("2026-07-24T00:00:00.000Z"));
  const accountProvider = options.accountProvider ?? {
    getContext: vi.fn(async () => testContext(account(options.downloadDirectory))),
  };
  const service = new QqMailService({
    accountProvider,
    referenceCodec: coreMessageReferenceCodec,
    draftStore: new DraftStore({
      now,
      idFactory: () => "draft_12345678901234567890",
    }),
    attachmentStorage: new SafeLocalAttachmentStorage(),
    imapGateway: imap,
    smtpGateway: smtp,
    sendApproval: { confirm: options.approve ?? (async () => true) },
    mutationApproval: { confirm: async () => ({ status: "approved" }) },
    now,
    cursorKey: Buffer.alloc(32, 7),
  });
  return { service, imap, smtp, accountProvider };
}

describe("QQ Mail service", () => {
  it("denies sending without trusted approval and does not retry a denied draft", async () => {
    const approve = vi.fn(denySendApproval.confirm);
    const { service, smtp } = createHarness({ session: fakeSession(), approve: () => approve({} as SendApprovalRequest) });
    const prepared = await service.prepareEmail({ to: ["to@example.com"], subject: "Approval", text: "Synthetic" }) as { draftId: string };
    await expect(service.sendEmail(prepared)).rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
    await expect(service.sendEmail(prepared)).rejects.toMatchObject({ code: "DRAFT_APPROVAL_REQUIRED" });
    expect(smtp.send).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("fails closed when trusted approval throws", async () => {
    const { service, smtp } = createHarness({ session: fakeSession(), approve: async () => { throw Error("Unavailable"); } });
    const draft = await service.prepareEmail({ to: ["to@example.com"], subject: "Error", text: "Synthetic" }) as { draftId: string };
    await expect(service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_APPROVAL_UNAVAILABLE" });
    expect(smtp.send).not.toHaveBeenCalled();
  });

  it("requests approval only once for concurrent calls and retries return the receipt", async () => {
    let release!: (value: boolean) => void;
    const approve = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const { service, smtp } = createHarness({ session: fakeSession(), approve });
    const draft = await service.prepareEmail({ to: ["to@example.com"], subject: "Once", text: "Synthetic" }) as { draftId: string };
    const first = service.sendEmail(draft);
    const second = service.sendEmail(draft);
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(smtp.send).not.toHaveBeenCalled();
    release(true);
    expect(await first).toEqual(await second);
    expect(await service.sendEmail(draft)).toEqual(await first);
    expect(smtp.send).toHaveBeenCalledTimes(1);
  });

  it("rejects account changes while the user is reviewing", async () => {
    let current = account();
    const provider = { getContext: async () => testContext(current, "SYNTHETIC") };
    const { service, smtp } = createHarness({
      session: fakeSession(), accountProvider: provider,
      approve: async () => { current = { ...current, email: "changed@qq.com", username: "changed@qq.com" }; return true; },
    });
    const draft = await service.prepareEmail({ to: ["to@example.com"], subject: "Change", text: "Synthetic" }) as { draftId: string };
    await expect(service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_ACCOUNT_CHANGED" });
    expect(smtp.send).not.toHaveBeenCalled();
  });

  it("rejects approval after the draft expires", async () => {
    let now = Date.now();
    const { service, smtp } = createHarness({
      session: fakeSession(), now: () => now,
      approve: async () => { now += 31 * 60_000; return true; },
    });
    const draft = await service.prepareEmail({ to: ["to@example.com"], subject: "Expiry", text: "Synthetic" }) as { draftId: string };
    await expect(service.sendEmail(draft)).rejects.toMatchObject({ code: "DRAFT_EXPIRED" });
    expect(smtp.send).not.toHaveBeenCalled();
  });

  it("keeps Bcc recipients in the SMTP envelope but out of the generated MIME headers", async () => {
    const message: OutgoingMessage = {
      from: { name: "Sender", address: "sender@qq.com" },
      to: [{ name: "To Recipient", address: "to@example.com" }],
      cc: [{ name: "Cc Recipient", address: "cc@example.com" }],
      bcc: [{ name: "Hidden Recipient", address: "hidden@example.com" }],
      subject: "Envelope privacy",
      text: "Body",
    };

    const compiled = await compileOutgoingMessage(message);
    const rawMessage = Buffer.isBuffer(compiled.message)
      ? compiled.message
      : Buffer.from(String(compiled.message));
    const parsed = await simpleParser(rawMessage);

    expect(compiled.envelope).toEqual({
      from: "sender@qq.com",
      to: ["to@example.com", "cc@example.com", "hidden@example.com"],
    });
    expect(parsedAddresses(parsed.to)).toEqual(["to@example.com"]);
    expect(parsedAddresses(parsed.cc)).toEqual(["cc@example.com"]);
    expect(parsed.bcc).toBeUndefined();
    expect(rawMessage.toString("utf8")).not.toMatch(/^bcc\s*:/imu);
  });

  it("reports IMAP, SMTP, and required directory mapping status without exposing credentials", async () => {
    const session = fakeSession();
    const { service, smtp } = createHarness({ session });

    const result = await service.testConnection() as {
      ok: boolean;
      imap: { state: string };
      smtp: { state: string };
      directories: {
        state: string;
        inbox: { found: boolean };
        sent: { found: boolean };
        trash: { found: boolean };
      };
    };
    expect(result).toMatchObject({
      ok: true,
      imap: { state: "ok" },
      smtp: { state: "ok" },
      directories: {
        state: "ok",
        inbox: { found: true },
        sent: { found: true },
        trash: { found: true },
      },
    });
    expect(smtp.verify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("authorization-code-secret");
  });

  it("fails directory mapping when the configured Inbox is missing", async () => {
    const session = fakeSession({
      listMailboxes: vi.fn(async () => [
        { path: "Sent Messages", delimiter: "/", flags: [], subscribed: true, specialUse: "\\Sent" },
        { path: "Deleted Messages", delimiter: "/", flags: [], subscribed: true, specialUse: "\\Trash" },
      ]),
    });
    const { service } = createHarness({ session });

    await expect(service.testConnection()).resolves.toMatchObject({
      ok: false,
      directories: {
        state: "error",
        inbox: { path: "INBOX", found: false },
        sent: { found: true },
        trash: { found: true },
      },
    });
  });

  it("searches newest-first with query-bound cursor pagination and stale cursor detection", async () => {
    let uidValidity = "42";
    const session = fakeSession({
      selectMailbox: vi.fn(async (mailbox) => ({ path: mailbox, uidValidity, exists: 5, readOnly: false })),
      search: vi.fn(async () => [1, 2, 3, 4, 5]),
      fetchMessages: vi.fn(async (uids: number[]) => uids.map((uid: number) => record(uid))),
    });
    const { service } = createHarness({ session });

    const first = await service.searchEmails({ mailbox: "INBOX", subject: "report", limit: 2 }) as {
      messages: Array<{ messageRef: string; subject: string }>;
      nextCursor: string;
    };
    expect(first.messages.map((entry) => entry.subject)).toEqual(["Message 5", "Message 4"]);
    expect(first.nextCursor).toMatch(/^qqc1\./u);

    const second = await service.searchEmails({
      mailbox: "INBOX",
      subject: "report",
      limit: 2,
      cursor: first.nextCursor,
    }) as { messages: Array<{ subject: string }> };
    expect(second.messages.map((entry) => entry.subject)).toEqual(["Message 3", "Message 2"]);

    uidValidity = "43";
    await expect(service.searchEmails({
      mailbox: "INBOX",
      subject: "report",
      cursor: first.nextCursor,
    })).rejects.toMatchObject({ code: "STALE_CURSOR" });
  });

  it("reads and batch-reads sanitized MIME content and rejects stale message references", async () => {
    const firstSource = messageSource({
      subject: "Untrusted",
      messageId: "<root@example.com>",
      contentType: "text/html",
      body: '<style>body{background:url(https://tracker.invalid)}</style><p>Hello &amp; bye</p><img src="https://tracker.invalid/pixel"><script>steal()</script>',
    });
    const secondSource = messageSource({ subject: "Second", messageId: "<second@example.com>" });
    let uidValidity = "42";
    const records = new Map([
      [1, record(1, { source: firstSource, size: firstSource.length })],
      [2, record(2, { source: secondSource, size: secondSource.length })],
    ]);
    const session = fakeSession({
      selectMailbox: vi.fn(async (mailbox) => ({ path: mailbox, uidValidity, exists: 2, readOnly: false })),
      fetchMessages: vi.fn(async (uids: number[]) =>
        uids.map((uid: number) => records.get(uid)).filter((entry: ImapMessageData | undefined): entry is ImapMessageData => Boolean(entry)),
      ),
    });
    const { service } = createHarness({ session });
    const firstRef = coreMessageReferenceCodec.encode({ accountScope: testContext(account()).scope, mailbox: "INBOX", uidValidity: "42", uid: 1 });
    const secondRef = coreMessageReferenceCodec.encode({ accountScope: testContext(account()).scope, mailbox: "INBOX", uidValidity: "42", uid: 2 });

    const read = await service.readEmail({ messageRef: firstRef }) as { body: { text: string }; untrusted: boolean };
    expect(read.body.text).toContain("Hello & bye");
    expect(JSON.stringify(read)).not.toContain("tracker.invalid");
    expect(JSON.stringify(read)).not.toContain("steal");
    expect(read.untrusted).toBe(true);

    const batch = await service.batchReadEmails({ messageRefs: [firstRef, secondRef] }) as { messages: unknown[] };
    expect(batch.messages).toHaveLength(2);

    uidValidity = "43";
    await expect(service.readEmail({ messageRef: firstRef })).rejects.toMatchObject({
      code: "STALE_MESSAGE_REFERENCE",
    });
  });

  it("reconstructs a bounded thread from Message-ID, References, and In-Reply-To", async () => {
    const rootSource = messageSource({ subject: "Root", messageId: "<root@example.com>" });
    const replySource = messageSource({
      subject: "Re: Root",
      messageId: "<reply@example.com>",
      inReplyTo: "<root@example.com>",
      references: "<root@example.com>",
      body: "Reply",
    });
    const records = new Map([
      [1, record(1, { source: rootSource, size: rootSource.length })],
      [2, record(2, { source: replySource, size: replySource.length })],
    ]);
    let selectedMailbox = "INBOX";
    const session = fakeSession({
      selectMailbox: vi.fn(async (mailbox) => {
        selectedMailbox = mailbox;
        return { path: mailbox, uidValidity: "42", exists: 2, readOnly: false };
      }),
      search: vi.fn(async () => selectedMailbox === "INBOX" ? [1, 2] : []),
      fetchMessages: vi.fn(async (uids: number[]) => selectedMailbox === "INBOX"
        ? uids.map((uid: number) => records.get(uid)).filter((entry: ImapMessageData | undefined): entry is ImapMessageData => Boolean(entry))
        : []),
    });
    const { service } = createHarness({ session });
    const rootRef = coreMessageReferenceCodec.encode({ accountScope: testContext(account()).scope, mailbox: "INBOX", uidValidity: "42", uid: 1 });

    const thread = await service.readEmailThread({ messageRef: rootRef, maxMessages: 10 }) as {
      messages: Array<{ subject: string }>;
    };
    expect(thread.messages.map((entry) => entry.subject)).toEqual(["Root", "Re: Root"]);
    expect(session.search).toHaveBeenCalledWith(expect.objectContaining({ or: expect.any(Array) }));
  });

  it("reconstructs one thread across Inbox and Sent even when their UIDs collide", async () => {
    const rootSource = messageSource({ subject: "Root", messageId: "<root@example.com>" });
    const replySource = messageSource({
      subject: "Re: Root",
      messageId: "<reply@example.com>",
      inReplyTo: "<root@example.com>",
      references: "<root@example.com>",
      body: "Reply from Sent",
    });
    const recordsByMailbox = new Map([
      ["INBOX", new Map([[7, record(7, { source: rootSource, size: rootSource.length })]])],
      ["Sent Messages", new Map([[7, record(7, { source: replySource, size: replySource.length })]])],
    ]);
    let selectedMailbox = "INBOX";
    const session = fakeSession({
      selectMailbox: vi.fn(async (mailbox) => {
        selectedMailbox = mailbox;
        return {
          path: mailbox,
          uidValidity: mailbox === "INBOX" ? "42" : "84",
          exists: 1,
          readOnly: false,
        };
      }),
      search: vi.fn(async () => [7]),
      fetchMessages: vi.fn(async (uids: number[]) => {
        const selectedRecords = recordsByMailbox.get(selectedMailbox) ?? new Map<number, ImapMessageData>();
        return uids
          .map((uid) => selectedRecords.get(uid))
          .filter((entry): entry is ImapMessageData => Boolean(entry));
      }),
    });
    const { service } = createHarness({ session });
    const rootRef = coreMessageReferenceCodec.encode({ accountScope: testContext(account()).scope, mailbox: "INBOX", uidValidity: "42", uid: 7 });

    const thread = await service.readEmailThread({ messageRef: rootRef, maxMessages: 10 }) as {
      messages: Array<{ mailbox: string; subject: string }>;
      searchedMailboxes: string[];
      incomplete: boolean;
    };
    expect(thread.messages).toEqual([
      expect.objectContaining({ mailbox: "INBOX", subject: "Root" }),
      expect.objectContaining({ mailbox: "Sent Messages", subject: "Re: Root" }),
    ]);
    expect(thread.searchedMailboxes).toEqual(["INBOX", "Sent Messages"]);
    expect(thread.incomplete).toBe(false);
  });

  it("updates flags and moves messages only after validating UIDVALIDITY and destination", async () => {
    const session = fakeSession();
    const { service } = createHarness({ session });
    const refs = [1, 2].map((uid) => coreMessageReferenceCodec.encode({ accountScope: testContext(account()).scope, mailbox: "INBOX", uidValidity: "42", uid }));

    await expect(service.setEmailFlags({ messageRefs: refs, read: true, starred: false })).resolves.toMatchObject({ updated: 2 });
    expect(session.addFlags).toHaveBeenCalledWith([1, 2], ["\\Seen"]);
    expect(session.removeFlags).toHaveBeenCalledWith([1, 2], ["\\Flagged"]);

    await expect(service.moveEmails({ messageRefs: refs, destination: "Archive" })).resolves.toEqual({ moved: 2, destination: "Archive" });
    expect(session.moveMessages).toHaveBeenCalledWith([1, 2], "Archive");

    await expect(service.trashEmails({ messageRefs: refs })).resolves.toEqual({ trashed: 2, destination: "Deleted Messages" });
    expect(session.moveMessages).toHaveBeenCalledWith([1, 2], "Deleted Messages");
  });

  it("returns partial move and trash results when a later source mailbox fails", async () => {
    const inboxRef = coreMessageReferenceCodec.encode({ accountScope: testContext(account()).scope, mailbox: "INBOX", uidValidity: "42", uid: 1 });
    const sentRef = coreMessageReferenceCodec.encode({ accountScope: testContext(account()).scope, mailbox: "Sent Messages", uidValidity: "42", uid: 2 });

    for (const operation of ["move", "trash"] as const) {
      const session = fakeSession({
        moveMessages: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("private server failure")),
      });
      const { service } = createHarness({ session });
      const result = operation === "move"
        ? await service.moveEmails({ messageRefs: [inboxRef, sentRef], destination: "Archive" })
        : await service.trashEmails({ messageRefs: [inboxRef, sentRef] });

      expect(result).toEqual({
        ok: false,
        status: "partial_failure",
        [operation === "move" ? "moved" : "trashed"]: 1,
        failed: 1,
        destination: operation === "move" ? "Archive" : "Deleted Messages",
        failure: {
          code: operation === "move" ? "MOVE_FAILED" : "TRASH_FAILED",
          message: expect.stringContaining("completed 1 of 2"),
        },
      });
      expect(JSON.stringify(result)).not.toContain("private server failure");
    }
  });

  it("prepares a preview and never resends after SMTP success when Sent append fails", async () => {
    const source = messageSource({ subject: "Question", messageId: "<question@example.com>", body: "Original" });
    const session = fakeSession({
      fetchMessages: vi.fn(async () => [record(1, { source, size: source.length })]),
      appendMessage: vi.fn(async () => {
        throw new Error("server details that must remain private");
      }),
    });
    const smtp: SmtpGateway = {
      verify: vi.fn(async () => undefined),
      send: vi.fn(async () => ({
        messageId: "<sent@example.com>",
        accepted: ["alice@example.com"],
        rejected: [],
        rawMessage: Buffer.from("From: sender@qq.com\r\n\r\nReply"),
      })),
    };
    const { service } = createHarness({ session, smtp });
    const sourceRef = coreMessageReferenceCodec.encode({ accountScope: testContext(account()).scope, mailbox: "INBOX", uidValidity: "42", uid: 1 });
    const prepared = await service.prepareEmail({ mode: "reply", sourceRef, text: "My answer" }) as {
      draftId: string;
      preview: { to: Array<{ address: string }>; subject: string; text: string };
      confirmationRequired: boolean;
    };
    expect(prepared.preview.to).toEqual([{ address: "alice@example.com", name: "Alice" }]);
    expect(prepared.preview.subject).toBe("Re: Question");
    expect(prepared.preview.text).toContain("> Original");
    expect(prepared.confirmationRequired).toBe(true);

    const first = await service.sendEmail({ draftId: prepared.draftId });
    const repeated = await service.sendEmail({ draftId: prepared.draftId });
    expect(first).toMatchObject({ sent: true, status: "sent_copy_failed", sentCopySaved: false });
    expect(repeated).toEqual(first);
    expect(smtp.send).toHaveBeenCalledTimes(1);
    expect(session.appendMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain("server details");
  });

  it("reports partial SMTP recipient acceptance without claiming complete delivery", async () => {
    const session = fakeSession();
    const smtp: SmtpGateway = {
      verify: vi.fn(async () => undefined),
      send: vi.fn(async () => ({
        messageId: "<partial@example.com>",
        accepted: ["accepted@example.com"],
        rejected: ["rejected@example.com"],
        rawMessage: Buffer.from("From: sender@qq.com\r\n\r\nPartial"),
      })),
    };
    const { service } = createHarness({ session, smtp });
    const prepared = await service.prepareEmail({
      mode: "compose",
      to: ["accepted@example.com", "rejected@example.com"],
      subject: "Partial delivery",
      text: "Body",
    }) as { draftId: string };

    const first = await service.sendEmail({ draftId: prepared.draftId });
    const repeated = await service.sendEmail({ draftId: prepared.draftId });
    expect(first).toMatchObject({
      sent: true,
      status: "partially_sent",
      sentCopySaved: true,
      accepted: ["accepted@example.com"],
      rejected: ["rejected@example.com"],
      warning: expect.stringContaining("only the accepted recipients"),
    });
    expect(repeated).toEqual(first);
    expect(smtp.send).toHaveBeenCalledTimes(1);
    expect(session.appendMessage).toHaveBeenCalledTimes(1);
  });

  it("consumes a prepared draft safely when the configured account changes", async () => {
    let currentAccount: MailAccountConfig | undefined = account();
    const accountProvider: MailAccountProvider = {
      getContext: vi.fn(async () => currentAccount ? testContext(currentAccount) : undefined),
    };
    const session = fakeSession();
    const { service, smtp } = createHarness({ session, accountProvider });
    const prepared = await service.prepareEmail({
      mode: "compose",
      to: ["recipient@example.com"],
      subject: "Bound account",
      text: "Body",
    }) as { draftId: string };
    currentAccount = {
      ...account(),
      email: "other@qq.com",
      username: "other@qq.com",
      displayName: "Other",
    };

    await expect(service.sendEmail({ draftId: prepared.draftId })).rejects.toMatchObject({
      code: "DRAFT_ACCOUNT_CHANGED",
      message: expect.stringContaining("active account revision"),
    });
    await expect(service.sendEmail({ draftId: prepared.draftId })).rejects.toMatchObject({
      code: "DRAFT_ACCOUNT_CHANGED",
    });
    expect(smtp.send).not.toHaveBeenCalled();
    expect(session.appendMessage).not.toHaveBeenCalled();
    expect(smtp.send).not.toHaveBeenCalled();
  });

  it("treats an SMTP failure as a consumed single-attempt draft", async () => {
    const session = fakeSession();
    const smtp: SmtpGateway = {
      verify: vi.fn(async () => undefined),
      send: vi.fn(async () => {
        throw new Error("ambiguous failure after DATA");
      }),
    };
    const { service } = createHarness({ session, smtp });
    const prepared = await service.prepareEmail({
      mode: "compose",
      to: ["recipient@example.com"],
      subject: "Subject",
      text: "Body",
    }) as { draftId: string };

    await expect(service.sendEmail({ draftId: prepared.draftId })).resolves.toMatchObject({ status: "delivery_unknown", sent: null });
    await expect(service.sendEmail({ draftId: prepared.draftId })).resolves.toMatchObject({ status: "delivery_unknown", sent: null });
    expect(smtp.send).toHaveBeenCalledTimes(1);
  });

  it("downloads a selected MIME part through the safe local attachment writer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "qq-mail-service-"));
    temporaryDirectories.push(directory);
    const content = Buffer.from("attachment-body");
    const session = fakeSession({
      fetchMessages: vi.fn(async () => [record(1, {
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain", size: 5 },
            {
              part: "2",
              type: "application/octet-stream",
              size: content.length,
              disposition: "attachment",
              dispositionParameters: { filename: "..\\..\\CON.txt" },
            },
          ],
        },
      })]),
      downloadPart: vi.fn(async () => ({
        expectedSize: content.length,
        contentType: "application/octet-stream",
        filename: "..\\..\\CON.txt",
        content: Readable.from([content]),
      })),
    });
    const { service } = createHarness({ session, downloadDirectory: directory });
    const reference = coreMessageReferenceCodec.encode({ accountScope: testContext(account(directory)).scope, mailbox: "INBOX", uidValidity: "42", uid: 1 });

    const result = await service.downloadAttachment({ messageRef: reference, attachmentId: "2" }) as {
      path: string;
      filename: string;
      bytes: number;
    };
    expect(result.filename).toBe("_CON.txt");
    expect(path.dirname(result.path)).toBe(await realpath(directory));
    expect(await readFile(result.path, "utf8")).toBe("attachment-body");
    expect(result.bytes).toBe(content.length);
  });
});
