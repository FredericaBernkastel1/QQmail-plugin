import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOWS_APPROVAL_MAX_BYTES, WINDOWS_APPROVAL_SCRIPT, WindowsSendApproval, preflightSendApproval, type SendApprovalRequest } from "../src/approval.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
afterEach(() => { vi.useRealTimers(); mocks.spawn.mockReset(); });

function fixture(action: "approve" | "deny" | "forged" | "error" | "hang") {
  let input = "";
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(),
    receivedInput: () => Buffer.from(input, "base64"),
  });
  child.stdin.on("data", b => input += b.toString());
  child.stdin.on("end", () => {
    const request = JSON.parse(Buffer.from(input, "base64").toString("utf8"));
    if (action === "approve") child.stdout.write(request.nonce);
    if (action === "forged") child.stdout.write("true");
    if (action !== "hang") child.emit("close", action === "error" ? 1 : 0);
  });
  mocks.spawn.mockReturnValue(child);
  return child;
}
const request = (): SendApprovalRequest => ({
  draftId: "draft_synthetic_123456", digest: "synthetic-digest",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  preview: { to: ["synthetic@example.com"], text: "'; exit 0; # not executable" },
});

describe("Windows confirmation boundary", () => {
  it("accepts only the private per-request nonce", async () => {
    fixture("approve");
    expect(await new WindowsSendApproval().confirm(request())).toBe(true);
    const [, args, options] = mocks.spawn.mock.calls[0]!;
    expect(args.join(" ")).not.toContain("synthetic@example.com");
    expect(args.join(" ")).not.toContain("'; exit 0;");
    expect(args).toEqual(["-NoLogo", "-NoProfile", "-STA", "-NonInteractive", "-Command", WINDOWS_APPROVAL_SCRIPT]);
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
  });
  for (const action of ["deny", "forged", "error"] as const) {
    it(`rejects ${action}`, async () => {
      fixture(action);
      expect(await new WindowsSendApproval().confirm(request())).toBe(false);
    });
  }
  it("kills a timed-out confirmation without approval", async () => {
    vi.useFakeTimers();
    const child = fixture("hang");
    const result = new WindowsSendApproval().confirm(request());
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await result).toBe(false);
    expect(child.kill).toHaveBeenCalled();
  });
  it("never opens an expired confirmation", async () => {
    const data = { ...request(), expiresAt: new Date(0).toISOString() };
    expect(await new WindowsSendApproval().confirm(data)).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  for (const [action, status] of [["approve", "approved"], ["deny", "declined"], ["forged", "unavailable"], ["error", "unavailable"]] as const) {
    it(`reports ${status} explicitly for ${action}`, async () => {
      fixture(action);
      expect(await new WindowsSendApproval().confirmDetailed(request())).toEqual({ status });
    });
  }

  it("reports timeout separately from a user decline", async () => {
    vi.useFakeTimers();
    fixture("hang");
    const result = new WindowsSendApproval().confirmDetailed(request());
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await result).toEqual({ status: "timeout" });
  });

  it("reports a synchronous helper launch failure as unavailable", async () => {
    mocks.spawn.mockImplementation(() => { throw new Error("synthetic launch failure"); });
    expect(await new WindowsSendApproval().confirmDetailed(request())).toEqual({ status: "unavailable" });
  });

  it("rejects a large Chinese preview before opening a confirmation window", async () => {
    const data = { ...request(), preview: { text: "中".repeat(200_000) } };
    expect(preflightSendApproval(data)).toMatchObject({ ok: false, status: "too_large", maxBytes: WINDOWS_APPROVAL_MAX_BYTES });
    expect(await new WindowsSendApproval().confirmDetailed(data)).toEqual({ status: "too_large" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  for (const body of ["ascii", "中文", 'quotes " and slash \\ and newline\n', "<b>HTML & 中文</b>", "bidi\u202etext"]) {
    it(`uses the identical UTF-8 payload for preflight and approval: ${JSON.stringify(body)}`, async () => {
      const child = fixture("approve");
      const data = { ...request(), preview: { text: body, html: `<p>${body}</p>`, attachments: [{ filename: "附\\件\".txt", size: 123 }] } };
      const preflight = preflightSendApproval(data);
      expect(await new WindowsSendApproval().confirmDetailed(data)).toEqual({ status: "approved" });
      expect(child.receivedInput().byteLength).toBe(preflight.bytes);
    });
  }

  it("accepts the exact byte boundary and rejects the next byte", () => {
    const empty = { ...request(), preview: { text: "" } };
    const overhead = preflightSendApproval(empty).bytes;
    const exact = { ...empty, preview: { text: "x".repeat(WINDOWS_APPROVAL_MAX_BYTES - overhead) } };
    expect(preflightSendApproval(exact)).toMatchObject({ ok: true, bytes: WINDOWS_APPROVAL_MAX_BYTES });
    expect(preflightSendApproval({ ...exact, preview: { text: exact.preview.text + "x" } })).toMatchObject({ ok: false, bytes: WINDOWS_APPROVAL_MAX_BYTES + 1 });
  });
});
