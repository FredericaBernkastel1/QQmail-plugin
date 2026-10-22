import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolFailure } from "../src/errors.js";
import { NodemailerSmtpGateway } from "../src/mail/gateways.js";
import type { MailServerConfig, OutgoingMessage } from "../src/mail/types.js";

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }));

const config: MailServerConfig = { host: "smtp.example.test", port: 465, security: "tls" };
const message: OutgoingMessage = {
  messageId: "<synthetic-authorization@example.test>",
  from: { name: "Synthetic Sender", address: "sender@example.test" },
  to: [{ name: "", address: "recipient@example.test" }], cc: [], bcc: [],
  subject: "Synthetic authorization boundary", text: "Synthetic private content",
};

beforeEach(() => { mocks.createTransport.mockReset(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Controlled compiler/SMTP doubles expose ordering and the exact MIME buffer. */
function harness() {
  const events: string[] = [];
  const raw = Buffer.from("From: sender@example.test\r\nSubject: Synthetic\r\n\r\nSynthetic private content");
  const compiled = {
    message: raw, messageId: message.messageId!,
    envelope: { from: "sender@example.test", to: ["recipient@example.test"] },
  };
  const compilerSend = vi.fn(async (_input: unknown) => {
    events.push("compile");
    return compiled;
  });
  const compilerClose = vi.fn(() => { events.push("compiler-close"); });
  const smtpSend = vi.fn(async (_input: unknown) => {
    events.push("smtp-send");
    return { accepted: ["recipient@example.test"], rejected: [] };
  });
  const smtpClose = vi.fn(() => { events.push("smtp-close"); });
  const smtpCreate = vi.fn(() => {
    events.push("smtp-create");
    return { sendMail: smtpSend, close: smtpClose };
  });
  mocks.createTransport.mockImplementation((options: { streamTransport?: boolean }) => {
    if (options.streamTransport) {
      events.push("compiler-create");
      return { sendMail: compilerSend, close: compilerClose };
    }
    return smtpCreate();
  });
  const gateway = new NodemailerSmtpGateway();
  const send = (beforeDispatch?: () => Promise<void>) =>
    gateway.send(config, "sender@example.test", "SYNTHETIC_ONLY", message, [], beforeDispatch);
  return { send, raw, compiled, compilerSend, compilerClose, smtpCreate, smtpSend, smtpClose, events };
}

describe("SMTP final authorization boundary", () => {
  it("preserves a denied authorization and clears MIME without constructing SMTP", async () => {
    const h = harness();
    const denied = new ToolFailure("AUTHORIZATION_REVOKED", "Synthetic authorization was revoked.");
    const beforeDispatch = vi.fn(async () => {
      h.events.push("authorization");
      expect(h.compilerClose).toHaveBeenCalledOnce();
      expect(h.raw.some((byte) => byte !== 0)).toBe(true);
      throw denied;
    });

    await expect(h.send(beforeDispatch)).rejects.toBe(denied);
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(h.smtpCreate).not.toHaveBeenCalled();
    expect(h.smtpSend).not.toHaveBeenCalled();
    expect(h.smtpClose).not.toHaveBeenCalled();
    expect(h.raw).toEqual(Buffer.alloc(h.raw.length));
    expect(h.events).toEqual(["compiler-create", "compile", "compiler-close", "authorization"]);
  });

  it("awaits explicit authorization before creating SMTP and returns successful synthetic delivery", async () => {
    const h = harness();
    const checkStarted = deferred();
    const releaseCheck = deferred();
    const beforeDispatch = vi.fn(async () => {
      h.events.push("authorization-start");
      checkStarted.resolve();
      await releaseCheck.promise;
      h.events.push("authorization-allowed");
    });
    const pending = h.send(beforeDispatch);
    await checkStarted.promise;
    expect(h.smtpCreate).not.toHaveBeenCalled();
    expect(h.smtpSend).not.toHaveBeenCalled();
    releaseCheck.resolve();
    const result = await pending;

    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(h.smtpCreate).toHaveBeenCalledOnce();
    expect(h.smtpSend).toHaveBeenCalledExactlyOnceWith({
      messageId: h.compiled.messageId, envelope: h.compiled.envelope, raw: h.raw,
    });
    expect(result).toEqual({
      messageId: h.compiled.messageId, accepted: ["recipient@example.test"], rejected: [], rawMessage: h.raw,
    });
    expect(result.rawMessage).toBe(h.raw);
    expect(h.raw.toString()).toContain("Synthetic private content");
    expect(h.events).toEqual([
      "compiler-create", "compile", "compiler-close", "authorization-start", "authorization-allowed",
      "smtp-create", "smtp-send", "smtp-close",
    ]);
  });

  it("observes revocation while MIME compilation is pending before any SMTP side effect", async () => {
    const h = harness();
    const compiling = deferred();
    const finishCompile = deferred();
    let revoked = false;
    const denied = new ToolFailure("AUTHORIZATION_REVOKED", "Synthetic authorization was revoked during compilation.");
    h.compilerSend.mockImplementationOnce(async () => {
      compiling.resolve();
      await finishCompile.promise;
      return h.compiled;
    });
    const beforeDispatch = vi.fn(async () => {
      if (revoked) throw denied;
    });
    const pending = h.send(beforeDispatch);
    const rejected = expect(pending).rejects.toBe(denied);
    await compiling.promise;
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(h.smtpCreate).not.toHaveBeenCalled();
    revoked = true;
    finishCompile.resolve();
    await rejected;

    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(h.smtpCreate).not.toHaveBeenCalled();
    expect(h.smtpSend).not.toHaveBeenCalled();
    expect(h.compilerClose).toHaveBeenCalledOnce();
    expect(h.raw).toEqual(Buffer.alloc(h.raw.length));
  });

  it("propagates an unexpected callback failure unchanged instead of reporting unknown delivery", async () => {
    const h = harness();
    const failure = new Error("Synthetic authorization provider failure");
    await expect(h.send(async () => { throw failure; })).rejects.toBe(failure);
    expect(h.smtpCreate).not.toHaveBeenCalled();
    expect(h.smtpSend).not.toHaveBeenCalled();
    expect(h.raw).toEqual(Buffer.alloc(h.raw.length));
  });

  it("clears compiled MIME if SMTP transport construction fails after authorization", async () => {
    const h = harness();
    const failure = new Error("Synthetic transport creation failure");
    h.smtpCreate.mockImplementationOnce(() => { throw failure; });
    const beforeDispatch = vi.fn(async () => undefined);
    await expect(h.send(beforeDispatch)).rejects.toBe(failure);
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(h.smtpSend).not.toHaveBeenCalled();
    expect(h.raw).toEqual(Buffer.alloc(h.raw.length));
  });

  it("still classifies failures after SMTP dispatch and clears their compiled MIME", async () => {
    const h = harness();
    const smtpFailure = Object.assign(new Error("Synthetic socket loss after DATA"), { command: "CONN", code: "ESOCKET" });
    h.smtpSend.mockRejectedValueOnce(smtpFailure);
    await expect(h.send(async () => undefined)).rejects.toMatchObject({ outcome: "delivery_unknown" });
    expect(h.smtpSend).toHaveBeenCalledOnce();
    expect(h.smtpClose).toHaveBeenCalledOnce();
    expect(h.raw).toEqual(Buffer.alloc(h.raw.length));
  });

  it("does not authorize or create SMTP when MIME compilation itself fails", async () => {
    const h = harness();
    const failure = new ToolFailure("MESSAGE_TOO_LARGE", "Synthetic compilation failure.");
    h.compilerSend.mockRejectedValueOnce(failure);
    const beforeDispatch = vi.fn(async () => undefined);
    await expect(h.send(beforeDispatch)).rejects.toBe(failure);
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(h.smtpCreate).not.toHaveBeenCalled();
    expect(h.smtpSend).not.toHaveBeenCalled();
    expect(h.compilerClose).toHaveBeenCalledOnce();
  });

  it("preserves existing five-argument interactive sends", async () => {
    const h = harness();
    const gateway = new NodemailerSmtpGateway();
    await expect(gateway.send(config, "sender@example.test", "SYNTHETIC_ONLY", message, []))
      .resolves.toMatchObject({ accepted: ["recipient@example.test"], rejected: [] });
    expect(h.smtpSend).toHaveBeenCalledOnce();
    expect(h.smtpClose).toHaveBeenCalledOnce();
  });
});
