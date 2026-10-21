import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { DraftStore } from "../src/drafts.js";
import { QqMailService } from "../src/mail/service.js";
import { coreMessageReferenceCodec } from "../src/mail/adapters.js";
import { ReadOutputBudget, ReadResourceBudget, MAX_READ_OUTPUT_BYTES } from "../src/mail/read-budget.js";
import type { ImapMessageData, ImapSession, MailAccountConfig, OutgoingMessage } from "../src/mail/types.js";
import { testContext } from "./account-fixtures.js";

const config: MailAccountConfig = {
  email: "synthetic@qq.com", username: "synthetic@qq.com", displayName: "Synthetic",
  imap: { host: "imap.qq.com", port: 993, security: "tls" },
  smtp: { host: "smtp.qq.com", port: 465, security: "tls" },
  folders: { inbox: "Configured Inbox", sent: "Sent", trash: "Trash" },
  downloadDirectory: "C:\\Synthetic\\Downloads", downloadLimitBytes: 1024 * 1024,
};

function source(uid: number, body = "Hello", extraHeaders: string[] = []): Buffer {
  return Buffer.from([
    "From: Synthetic <alice@example.com>", "To: synthetic@qq.com", `Subject: Message ${uid}`,
    `Message-ID: <message-${uid}@example.com>`, ...extraHeaders,
    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", body,
  ].join("\r\n"));
}

function fixture(options: {
  bodies?: Map<number, Buffer>;
  account?: MailAccountConfig;
  session?: Partial<ImapSession>;
  budget?: ReadResourceBudget;
  requestLimit?: number;
} = {}) {
  const account = options.account ?? config;
  const context = testContext(account);
  const bodies = options.bodies ?? new Map([[1, source(1)]]);
  let mailbox = account.folders.inbox;
  const session: ImapSession = {
    listMailboxes: vi.fn(async () => []),
    selectMailbox: vi.fn(async (path) => {
      mailbox = path;
      return { path, uidValidity: "42", exists: bodies.size, readOnly: false };
    }),
    search: vi.fn(async () => mailbox === account.folders.inbox ? [...bodies.keys()] : []),
    fetchMessages: vi.fn(async (uids: number[], options: { sourceMaxBytes?: number | undefined }) => uids.flatMap(uid => {
      const raw = bodies.get(uid);
      if (!raw) return [];
      const record: ImapMessageData = { uid, flags: new Set(), size: raw.length,
        envelope: { subject: `Message ${uid}` } };
      if (options.sourceMaxBytes !== undefined) record.source = raw.subarray(0, options.sourceMaxBytes);
      return [record];
    })),
    addFlags: vi.fn(async () => undefined), removeFlags: vi.fn(async () => undefined),
    moveMessages: vi.fn(async () => undefined), appendMessage: vi.fn(async () => undefined),
    downloadPart: vi.fn(async () => ({ expectedSize: 0, contentType: "text/plain", content: Readable.from([]) })),
    close: vi.fn(async () => undefined), ...options.session,
  };
  const service = new QqMailService({
    accountProvider: { getContext: async () => context }, referenceCodec: coreMessageReferenceCodec,
    draftStore: new DraftStore<OutgoingMessage, Record<string, unknown>>(),
    attachmentStorage: { save: async () => { throw new Error("Not used"); } },
    imapGateway: { connect: async () => session },
    readBudget: options.budget ?? new ReadResourceBudget(),
    ...(options.requestLimit === undefined ? {} : { readRequestLimitBytes: options.requestLimit }),
  });
  const ref = (uid: number) => coreMessageReferenceCodec.encode({
    accountScope: context.scope, mailbox: account.folders.inbox, uidValidity: "42", uid,
  });
  return { service, session, ref };
}

describe("read resource budgets", () => {
  it("rejects cumulative reserved bytes and returns all reservations after success or failure", async () => {
    const budget = new ReadResourceBudget(100, 2);
    let release!: () => void;
    const held = budget.run(60, () => new Promise<void>(resolve => { release = resolve; }));
    await expect(budget.run(41, async () => undefined)).rejects.toMatchObject({ code: "READ_BYTE_BUDGET_EXCEEDED" });
    await expect(budget.run(40, async () => { throw new Error("Synthetic failure"); })).rejects.toThrow("Synthetic failure");
    expect(budget.snapshot()).toEqual({ reservedBytes: 60, activeReads: 1 });
    release();
    await held;
    expect(budget.snapshot()).toEqual({ reservedBytes: 0, activeReads: 0 });
  });

  it("rejects excess concurrency even when bytes are available and handles cancellation without leaking", async () => {
    const budget = new ReadResourceBudget(100, 1);
    const controller = new AbortController();
    let release!: () => void;
    const held = budget.run(20, () => new Promise<void>(resolve => { release = resolve; }), controller.signal);
    await expect(budget.run(20, async () => undefined)).rejects.toMatchObject({ code: "READ_CONCURRENCY_LIMIT" });
    controller.abort();
    // The reservation remains until the in-flight operation stops owning its buffer.
    expect(budget.snapshot().reservedBytes).toBe(20);
    release();
    await expect(held).rejects.toMatchObject({ code: "READ_CANCELLED" });
    await expect(budget.run(20, async () => undefined, controller.signal)).rejects.toMatchObject({ code: "READ_CANCELLED" });
    expect(budget.snapshot()).toEqual({ reservedBytes: 0, activeReads: 0 });
  });

  it("counts UTF-8 and JSON escaping in output rather than character count", () => {
    const budget = new ReadOutputBudget(20_000);
    expect(budget.add({ body: "中".repeat(1000) })).toBe(true);
    expect(budget.add({ body: "中".repeat(1000) })).toBe(false);
  });

  it("returns short default bodies and allows reading beyond the former 500000-character cutoff", async () => {
    const body = `${"a".repeat(510_000)}END`;
    const { service, ref } = fixture({ bodies: new Map([[1, source(1, body)]]) });
    const first = await service.readEmail({ messageRef: ref(1) }) as any;
    expect(first.body).toMatchObject({ offset: 0, returnedChars: 4000, totalChars: 510003, nextOffset: 4000, truncated: true });
    const last = await service.readEmail({ messageRef: ref(1), bodyOffset: 510_000, bodyLimit: 10 }) as any;
    expect(last.body).toMatchObject({ text: "END", nextOffset: null, offset: 510_000 });
    expect(first.truncationReasons).toContain("BODY_RANGE");
    await expect(service.readEmail({ messageRef: ref(1), bodyOffset: -1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("fetches only one MIME source at a time and leaves reusable gateway fixtures intact", async () => {
    const bodies = new Map([[1, source(1)], [2, source(2)]]);
    const original = Buffer.from(bodies.get(1)!);
    const { service, session, ref } = fixture({ bodies });
    const result = await service.batchReadEmails({ messageRefs: [ref(1), ref(2)] }) as any;
    expect(result.messages).toHaveLength(2);
    expect(result.incomplete).toBe(false);
    expect(vi.mocked(session.fetchMessages).mock.calls.every(([uids]) => uids.length === 1)).toBe(true);
    expect(bodies.get(1)).toEqual(original);
    expect(JSON.stringify(result)).not.toContain('"source"');
    await expect(service.readEmail({ messageRef: ref(1) })).resolves.toMatchObject({ body: { text: "Hello" } });
  });

  it("shares byte reservations across service instances and releases them when fetch fails", async () => {
    const budget = new ReadResourceBudget(300, 2);
    const account = { ...config, messageParseLimitBytes: 200 };
    let release!: () => void;
    const a = fixture({ account, budget, session: {
      fetchMessages: vi.fn(() => new Promise<ImapMessageData[]>(resolve => { release = () => resolve([]); })),
    } });
    const b = fixture({ account, budget });
    const first = a.service.readEmail({ messageRef: a.ref(1) });
    await vi.waitFor(() => expect(budget.snapshot().activeReads).toBe(1));
    await expect(b.service.readEmail({ messageRef: b.ref(1) })).rejects.toMatchObject({ code: "READ_BYTE_BUDGET_EXCEEDED" });
    release();
    await expect(first).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
    expect(budget.snapshot()).toEqual({ reservedBytes: 0, activeReads: 0 });
    a.service.dispose(); b.service.dispose();
  });

  it("bounds batch UTF-8 output and reports skipped messages with continuation", async () => {
    const bodies = new Map(Array.from({ length: 25 }, (_, i) => [i + 1, source(i + 1, "中".repeat(6000))]));
    const { service, ref } = fixture({ bodies });
    const result = await service.batchReadEmails({ messageRefs: [...bodies.keys()].map(ref) }) as any;
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_READ_OUTPUT_BYTES);
    expect(result.messages.length).toBeLessThan(25);
    expect(result.incomplete).toBe(true);
    expect(result.truncationReasons).toEqual(expect.arrayContaining(["BODY_RANGE", "OUTPUT_BYTE_LIMIT"]));
    expect(result.skippedMessageCount).toBe(25 - result.messages.length);
    expect(result.continuation).toContain("bodyOffset");
  });

  it("charges total fetched bytes including oversized failures and stops subsequent MIME fetches", async () => {
    const bodies = new Map([[1, source(1, "a".repeat(500))], [2, source(2, "b".repeat(500))], [3, source(3)]]);
    const { service, session, ref } = fixture({ bodies, requestLimit: 800 });
    const result = await service.batchReadEmails({ messageRefs: [ref(1), ref(2), ref(3)] }) as any;
    expect(result.messages).toHaveLength(1);
    expect(result.truncationReasons).toContain("READ_REQUEST_BYTE_LIMIT");
    expect(result.skippedMessageCount).toBe(2);
    expect(session.fetchMessages).toHaveBeenCalledTimes(2);
    const requested = vi.mocked(session.fetchMessages).mock.calls.map(([, options]) => options.sourceMaxBytes!);
    expect(requested[1]).toBeLessThan(requested[0]!);
  });

  it("marks oversized thread members and message-count limits incomplete", async () => {
    const bodies = new Map([[1, source(1)], [2, source(2, "x".repeat(1000))]]);
    const { service, ref } = fixture({ bodies, account: { ...config, messageParseLimitBytes: 500 } });
    const thread = await service.readEmailThread({ messageRef: ref(1), maxMessages: 10 }) as any;
    expect(thread.messages).toHaveLength(1);
    expect(thread.skippedMessages).toEqual([{ messageRef: ref(2), reason: "MESSAGE_TOO_LARGE" }]);
    expect(thread.incomplete).toBe(true);
    expect(thread.truncationReasons).toContain("MESSAGE_TOO_LARGE");
    const limited = await service.readEmailThread({ messageRef: ref(1), maxMessages: 1 }) as any;
    expect(limited.truncationReasons).toContain("THREAD_MESSAGE_LIMIT");
  });

  it("marks exhausted thread identifiers rather than silently claiming completeness", async () => {
    const references = Array.from({ length: 30 }, (_, i) => `<ref-${i}@example.com>`).join(" ");
    const { service, ref } = fixture({ bodies: new Map([[1, source(1, "Hello", [`References: ${references}`])]]) });
    const result = await service.readEmailThread({ messageRef: ref(1), maxMessages: 10 }) as any;
    expect(result.incomplete).toBe(true);
    expect(result.truncationReasons).toContain("THREAD_IDENTIFIER_LIMIT");
  });

  it("marks a thread frontier that still grows at the round limit as incomplete", async () => {
    const bodies = new Map(Array.from({ length: 7 }, (_, i) => [i + 1, source(i + 1)]));
    let selected = config.folders.inbox;
    let round = 1;
    const { service, ref } = fixture({ bodies, session: {
      selectMailbox: vi.fn(async path => {
        selected = path;
        return { path, uidValidity: "42", exists: 7, readOnly: false };
      }),
      search: vi.fn(async () => selected === config.folders.inbox ? [++round] : []),
    } });
    const result = await service.readEmailThread({ messageRef: ref(1), maxMessages: 20 }) as any;
    expect(result.messages).toHaveLength(6);
    expect(result.incomplete).toBe(true);
    expect(result.truncationReasons).toContain("THREAD_ROUND_LIMIT");
  });

  it("uses configured mailbox defaults and pushes cursor UID bounds into the gateway query", async () => {
    const bodies = new Map([[1, source(1)], [2, source(2)], [3, source(3)]]);
    const { service, session } = fixture({ bodies });
    const first = await service.searchEmails({ limit: 1 }) as any;
    expect(first.mailbox).toBe("Configured Inbox");
    await service.searchEmails({ limit: 1, cursor: first.nextCursor });
    expect(session.search).toHaveBeenLastCalledWith({ all: true, uid: "1:2" });
    await service.searchEmails({ mailbox: "Explicit", limit: 1 });
    expect(session.selectMailbox).toHaveBeenLastCalledWith("Explicit");
  });
});
