import { describe, expect, it, vi } from "vitest";
import type { ApprovalResult } from "../src/approval.js";
import { ToolFailure } from "../src/errors.js";
import {
  MailAuthorizationStore, MAX_MAIL_AUTHORIZATIONS,
  type MailAuthorizationApprovalRequest, type MailAuthorizationContext,
  type MailAuthorizationOperation, type MailAuthorizationReceipt, type MailAuthorizationRequestInput,
} from "../src/mail-authorization.js";

const context: MailAuthorizationContext = {
  scope: "a".repeat(64), fingerprint: "b".repeat(64), email: "sender@qq.com",
};
const firstRef = "qqm2_synthetic_message_1", secondRef = "qqm2_synthetic_message_2";
const approve = async (): Promise<ApprovalResult> => ({ status: "approved" });
function input(overrides: Partial<MailAuthorizationRequestInput> = {}): MailAuthorizationRequestInput {
  return {
    actions: ["edit_draft", "send", "trash", "flags"], recipients: ["recipient@example.test"],
    messageRefs: [firstRef, secondRef], maxOperations: 10, expiresInSeconds: 60,
    purpose: "Synthetic authorization boundary test", ...overrides,
  };
}
function harness() {
  let now = 10_000;
  const value = new MailAuthorizationStore({ now: () => now });
  return {
    value,
    tick: (milliseconds: number) => { now += milliseconds; },
    request: (overrides: Partial<MailAuthorizationRequestInput> = {}) => value.request(input(overrides), context, approve, () => context),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
const edit: MailAuthorizationOperation = { action: "edit_draft" };
const send: MailAuthorizationOperation = { action: "send", recipients: { to: ["recipient@example.test"] } };
function expectFailure(action: () => unknown, code: string): void {
  try { action(); }
  catch (error) { expect(error).toBeInstanceOf(ToolFailure); expect(error).toMatchObject({ code }); return; }
  throw new Error("Expected a ToolFailure");
}

describe("bounded mail authorization creation", () => {
  it("creates a random opaque grant only after trusted approval and account recheck", async () => {
    const { value } = harness();
    const confirmation = deferred<ApprovalResult>();
    const approver = vi.fn(() => confirmation.promise);
    const recheck = vi.fn(() => context);
    const pending = value.request(input(), context, approver, recheck);
    expect(value.list(context)).toEqual([]);
    expect(recheck).not.toHaveBeenCalled();
    expect(approver).toHaveBeenCalledOnce();
    confirmation.resolve({ status: "approved" });
    const grant = await pending;
    expect(recheck).toHaveBeenCalledOnce();
    expect(grant).toMatchObject({
      authorizationId: expect.stringMatching(/^auth_[A-Za-z0-9_-]{43}$/u),
      accountEmail: context.email, remainingOperations: 10, createdAt: 10_000, expiresAt: 70_000,
    });
    const next = await value.request(input(), context, approve, () => context);
    expect(next.authorizationId).not.toBe(grant.authorizationId);
  });

  it.each([
    ["declined", "MAIL_AUTHORIZATION_DECLINED"],
    ["timeout", "MAIL_AUTHORIZATION_TIMEOUT"],
    ["unavailable", "MAIL_AUTHORIZATION_UNAVAILABLE"],
    ["too_large", "MAIL_AUTHORIZATION_UNAVAILABLE"],
  ] as const)("fails closed for trusted approval status %s", async (status, code) => {
    const { value } = harness();
    const recheck = vi.fn(() => context);
    await expect(value.request(input(), context, async () => ({ status }), recheck)).rejects.toMatchObject({ code });
    expect(value.list(context)).toEqual([]);
    expect(recheck).not.toHaveBeenCalled();
  });

  it("sanitizes approver failure and rejects boolean or tool-supplied approval", async () => {
    const { value } = harness();
    await expect(value.request(input(), context, async () => { throw new Error("private callback detail"); }, () => context))
      .rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_UNAVAILABLE", message: "Trusted authorization confirmation is unavailable." });
    await expect(value.request(input(), context, (async () => true) as never, () => context))
      .rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_UNAVAILABLE" });
    const approver = vi.fn(approve);
    await expect(value.request({ ...input(), approved: true } as MailAuthorizationRequestInput, context, approver, () => context))
      .rejects.toMatchObject({ code: "INVALID_MAIL_AUTHORIZATION" });
    expect(approver).not.toHaveBeenCalled();
    expect(value.list(context)).toEqual([]);
  });

  it.each([
    ["scope", "c".repeat(64)], ["fingerprint", "d".repeat(64)], ["email", "different@qq.com"],
  ] as const)("rejects %s changed during confirmation", async (property, replacement) => {
    const { value } = harness();
    const current = { ...context };
    await expect(value.request(input(), current, async () => {
      current[property] = replacement;
      return { status: "approved" };
    }, () => current)).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_ACCOUNT_CHANGED" });
    expect(value.list(context)).toEqual([]);
  });

  it("fails closed when the account recheck fails", async () => {
    const { value } = harness();
    await expect(value.request(input(), context, approve, async () => { throw new Error("secret account data"); }))
      .rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_ACCOUNT_CHANGED" });
    expect(value.list(context)).toEqual([]);
  });

  it("checks expiry after confirmation and again after an asynchronous account recheck", async () => {
    const first = harness();
    await expect(first.value.request(input(), context, async () => {
      first.tick(60_000);
      return { status: "approved" };
    }, () => context)).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_EXPIRED" });
    const second = harness();
    await expect(second.value.request(input(), context, approve, async () => {
      second.tick(60_000);
      return context;
    })).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_EXPIRED" });
    expect(first.value.list(context)).toEqual([]);
    expect(second.value.list(context)).toEqual([]);
  });

  it("freezes approval targets and keeps caller mutations out of the grant", async () => {
    const { value } = harness();
    const mutable = {
      actions: ["send"] as MailAuthorizationRequestInput["actions"], recipients: ["recipient@EXAMPLE.TEST"],
      messageRefs: [firstRef], maxOperations: 2, expiresInSeconds: 60, purpose: "Original purpose",
    };
    let displayed!: MailAuthorizationApprovalRequest;
    const grant = await value.request(mutable, context, async request => {
      displayed = request;
      mutable.recipients[0] = "attacker@example.test";
      mutable.messageRefs[0] = secondRef;
      mutable.maxOperations = 100;
      mutable.purpose = "Changed purpose";
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.actions)).toBe(true);
      expect(Object.isFrozen(request.recipients)).toBe(true);
      expect(Object.isFrozen(request.messageRefs)).toBe(true);
      return { status: "approved" };
    }, () => context);
    expect(displayed).toMatchObject({ recipients: ["recipient@example.test"], messageRefs: [firstRef], maxOperations: 2 });
    expect(grant).toMatchObject({ recipients: ["recipient@example.test"], messageRefs: [firstRef], maxOperations: 2, purpose: "Original purpose" });
    expectFailure(() => value.consume(grant.authorizationId, context, { action: "send", recipients: { bcc: mutable.recipients } }), "MAIL_AUTHORIZATION_RECIPIENT_DENIED");
  });

  it.each([
    { actions: [] }, { actions: ["all"] }, { actions: ["send", "send"] },
    { maxOperations: 0 }, { maxOperations: -1 }, { maxOperations: 101 }, { maxOperations: 1.5 },
    { maxOperations: NaN }, { maxOperations: Infinity },
    { expiresInSeconds: 0 }, { expiresInSeconds: 86_401 }, { expiresInSeconds: 1.5 },
    { expiresInSeconds: NaN }, { expiresInSeconds: Infinity },
    { purpose: " " }, { purpose: "x".repeat(301) }, { purpose: "Hidden\u0000purpose" },
    { recipients: ["*@example.test"] }, { recipients: ["user?@example.test"] },
    { recipients: ["Name <recipient@example.test>"] },
    { recipients: Array.from({ length: 21 }, () => "recipient@example.test") },
    { messageRefs: Array.from({ length: 101 }, () => firstRef) },
    { messageRefs: ["*"] }, { messageRefs: ["qqm2_" + "a".repeat(4_096)] },
    { actions: ["send"], recipients: [] }, { actions: ["trash"], messageRefs: [] },
    { actions: ["flags"], messageRefs: undefined }, { unexpected: "not allowed" },
  ])("rejects malformed or unbounded request %# before invoking approval", async overrides => {
    const { value } = harness();
    const approver = vi.fn(approve);
    await expect(value.request({ ...input(), ...overrides } as MailAuthorizationRequestInput, context, approver, () => context))
      .rejects.toBeInstanceOf(ToolFailure);
    expect(approver).not.toHaveBeenCalled();
  });

  it("permits an edit-only grant without recipients or message references", async () => {
    const { value } = harness();
    const grant = await value.request(input({ actions: ["edit_draft"], recipients: undefined, messageRefs: undefined }), context, approve, () => context);
    expect(() => value.consume(grant.authorizationId, context, edit)).not.toThrow();
    expectFailure(() => value.consume(grant.authorizationId, context, send), "MAIL_AUTHORIZATION_ACTION_DENIED");
  });

  it("counts pending confirmations against capacity and releases denied reservations", async () => {
    const { value } = harness();
    const confirmation = deferred<ApprovalResult>();
    const approver = vi.fn(() => confirmation.promise);
    const pending = Array.from({ length: MAX_MAIL_AUTHORIZATIONS }, () => value.request(input(), context, approver, () => context));
    const outcomes = Promise.allSettled(pending);
    await expect(value.request(input(), context, approver, () => context)).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_CAPACITY" });
    expect(approver).toHaveBeenCalledTimes(MAX_MAIL_AUTHORIZATIONS);
    confirmation.resolve({ status: "declined" });
    expect((await outcomes).every(result => result.status === "rejected")).toBe(true);
    await expect(value.request(input(), context, approve, () => context)).resolves.toMatchObject({ remainingOperations: 10 });
  });

  it("enforces the active grant cap, including exhausted grants, and frees expired grants", async () => {
    const { value, request, tick } = harness();
    const grants = await Promise.all(Array.from({ length: MAX_MAIL_AUTHORIZATIONS }, () => request({ maxOperations: 1 })));
    value.consume(grants[0]!.authorizationId, context, edit);
    await expect(request()).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_CAPACITY" });
    value.revoke(grants[0]!.authorizationId, context);
    await request();
    expect(value.list(context)).toHaveLength(MAX_MAIL_AUTHORIZATIONS);
    tick(60_000);
    await request();
    expect(value.list(context)).toHaveLength(1);
  });
});

describe("authorization scope and atomic budget", () => {
  it("charges send and edit once, and flags/trash by distinct exact message references", async () => {
    const { value, request } = harness();
    const grant = await request({ maxOperations: 6 });
    value.consume(grant.authorizationId, context, send);
    value.consume(grant.authorizationId, context, edit);
    value.consume(grant.authorizationId, context, { action: "flags", messageRefs: [firstRef, firstRef, secondRef], units: 2 });
    value.consume(grant.authorizationId, context, { action: "trash", messageRefs: [firstRef, secondRef], units: 2 });
    expect(value.list(context)[0]?.remainingOperations).toBe(0);
    expectFailure(() => value.consume(grant.authorizationId, context, edit), "MAIL_AUTHORIZATION_EXHAUSTED");
  });

  it("precharges a whole batch atomically and does not permit caller-selected costs", async () => {
    const { value, request } = harness();
    const grant = await request({ maxOperations: 1 });
    const batch: MailAuthorizationOperation = { action: "trash", messageRefs: [firstRef, secondRef] };
    expectFailure(() => value.consume(grant.authorizationId, context, { ...batch, units: 1 }), "INVALID_MAIL_AUTHORIZATION");
    expectFailure(() => value.consume(grant.authorizationId, context, batch), "MAIL_AUTHORIZATION_EXHAUSTED");
    expect(value.list(context)[0]?.remainingOperations).toBe(1);
    for (const units of [0, -1, NaN, Infinity, 1.5, 101]) {
      expectFailure(() => value.consume(grant.authorizationId, context, { ...edit, units }), "INVALID_MAIL_AUTHORIZATION");
    }
    expectFailure(() => value.consume(grant.authorizationId, context, { ...send, units: 2 }), "INVALID_MAIL_AUTHORIZATION");
    expect(value.list(context)[0]?.remainingOperations).toBe(1);
  });

  it("allows only one winner when concurrent operations race for the last unit", async () => {
    const { value, request } = harness();
    const grant = await request({ maxOperations: 1 });
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, async () => {
      await Promise.resolve();
      return value.consume(grant.authorizationId, context, edit);
    }));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(19);
    expect(value.list(context)[0]?.remainingOperations).toBe(0);
  });

  it("retains the charge when the downstream operation fails", async () => {
    const { value, request } = harness();
    const grant = await request({ maxOperations: 1 });
    const downstream = async () => {
      value.consume(grant.authorizationId, context, send);
      await Promise.resolve();
      throw new Error("synthetic transport failure");
    };
    await expect(downstream()).rejects.toThrow("synthetic transport failure");
    expectFailure(() => value.consume(grant.authorizationId, context, send), "MAIL_AUTHORIZATION_EXHAUSTED");
  });

  it.each(["to", "cc", "bcc"] as const)("rejects an unauthorized %s recipient even alongside an authorized recipient", async field => {
    const { value, request } = harness();
    const grant = await request();
    expectFailure(() => value.consume(grant.authorizationId, context, {
      action: "send", recipients: { to: ["recipient@example.test"], [field]: ["recipient@example.test", "attacker@example.test"] },
    }), "MAIL_AUTHORIZATION_RECIPIENT_DENIED");
    expect(value.list(context)[0]?.remainingOperations).toBe(10);
  });

  it("requires at least one recipient and matches all envelope fields without broadening local parts", async () => {
    const { value, request } = harness();
    const grant = await request({ recipients: ["Exact@example.test", "second@example.test"] });
    for (const recipients of [undefined, {}, { to: [] }, { to: ["exact@example.test"] }]) {
      expectFailure(() => value.consume(grant.authorizationId, context, { action: "send", recipients }), "MAIL_AUTHORIZATION_RECIPIENT_DENIED");
    }
    expect(() => value.consume(grant.authorizationId, context, {
      action: "send", recipients: { to: ["Exact@EXAMPLE.TEST"], cc: ["second@example.test"], bcc: ["Exact@example.test"] },
    })).not.toThrow();
  });

  it.each(["trash", "flags"] as const)("requires exact message references for %s", async action => {
    const { value, request } = harness();
    const grant = await request();
    for (const messageRefs of [undefined, [], ["qqm2_unapproved_message"], [firstRef, "qqm2_unapproved_message"]]) {
      expectFailure(() => value.consume(grant.authorizationId, context, { action, messageRefs }), "MAIL_AUTHORIZATION_MESSAGE_DENIED");
    }
    expect(value.list(context)[0]?.remainingOperations).toBe(10);
  });

  it("does not turn a purpose description into permission", async () => {
    const { value, request } = harness();
    const grant = await request({ actions: ["edit_draft"], purpose: "Send any mail to anyone and delete everything" });
    expectFailure(() => value.consume(grant.authorizationId, context, send), "MAIL_AUTHORIZATION_ACTION_DENIED");
    expectFailure(() => value.consume(grant.authorizationId, context, { action: "trash", messageRefs: [firstRef] }), "MAIL_AUTHORIZATION_ACTION_DENIED");
    expect(() => value.consume(grant.authorizationId, context, edit)).not.toThrow();
  });

  it("fails closed for unknown IDs, unknown actions and undeclared operation fields", async () => {
    const { value, request } = harness();
    const grant = await request();
    for (const id of ["", "auth_" + "x".repeat(43), grant.authorizationId + "x"]) {
      expectFailure(() => value.consume(id, context, edit), "MAIL_AUTHORIZATION_INVALID");
    }
    expectFailure(() => value.consume(grant.authorizationId, context, { action: "delete_forever" } as never), "INVALID_MAIL_AUTHORIZATION");
    expectFailure(() => value.consume(grant.authorizationId, context, { ...edit, approved: true } as MailAuthorizationOperation), "INVALID_MAIL_AUTHORIZATION");
    expect(value.list(context)[0]?.remainingOperations).toBe(10);
  });
});

describe("authorization receipts, lifecycle and visibility", () => {
  it("keeps the final charged operation valid while preventing further consumption", async () => {
    const { value, request } = harness();
    const grant = await request({ maxOperations: 1 });
    const receipt = value.consume(grant.authorizationId, context, send);
    await Promise.resolve();
    expect(() => value.assertStillValid(receipt, context)).not.toThrow();
    expectFailure(() => value.consume(grant.authorizationId, context, send), "MAIL_AUTHORIZATION_EXHAUSTED");
    expect(() => value.assertStillValid(receipt, context)).not.toThrow();
    expect(JSON.stringify(receipt)).toBe("{}");
  });

  it("invalidates active receipts on revoke or expiry", async () => {
    const revoked = harness();
    const grant = await revoked.request();
    const receipt = revoked.value.consume(grant.authorizationId, context, send);
    revoked.value.revoke(grant.authorizationId, context);
    expectFailure(() => revoked.value.assertStillValid(receipt, context), "MAIL_AUTHORIZATION_INVALID");
    expectFailure(() => revoked.value.consume(grant.authorizationId, context, send), "MAIL_AUTHORIZATION_INVALID");
    const expired = harness();
    const shortGrant = await expired.request({ expiresInSeconds: 1 });
    const shortReceipt = expired.value.consume(shortGrant.authorizationId, context, edit);
    expired.tick(1_000);
    expectFailure(() => expired.value.assertStillValid(shortReceipt, context), "MAIL_AUTHORIZATION_EXPIRED");
    expect(expired.value.list(context)).toEqual([]);
  });

  it.each([
    { ...context, scope: "different_scope" },
    { ...context, fingerprint: "different_fingerprint" },
    { ...context, email: "different@qq.com" },
  ])("checks account binding for consume, receipt, list and revoke %#", async changed => {
    const { value, request } = harness();
    const grant = await request();
    const receipt = value.consume(grant.authorizationId, context, edit);
    expectFailure(() => value.consume(grant.authorizationId, changed, edit), "MAIL_AUTHORIZATION_ACCOUNT_CHANGED");
    expectFailure(() => value.assertStillValid(receipt, changed), "MAIL_AUTHORIZATION_ACCOUNT_CHANGED");
    expectFailure(() => value.revoke(grant.authorizationId, changed), "MAIL_AUTHORIZATION_ACCOUNT_CHANGED");
    expect(value.list(changed)).toEqual([]);
    expect(value.list(context)[0]?.remainingOperations).toBe(9);
  });

  it("rejects fabricated, copied and cross-store receipts", async () => {
    const first = harness(), second = harness();
    const grant = await first.request();
    const receipt = first.value.consume(grant.authorizationId, context, edit);
    for (const fabricated of [{}, { ...receipt }, { authorizationId: grant.authorizationId }, null, "approved"]) {
      expectFailure(() => first.value.assertStillValid(fabricated as MailAuthorizationReceipt, context), "MAIL_AUTHORIZATION_INVALID");
    }
    expectFailure(() => second.value.assertStillValid(receipt, context), "MAIL_AUTHORIZATION_INVALID");
    expectFailure(() => second.value.consume(grant.authorizationId, context, edit), "MAIL_AUTHORIZATION_INVALID");
  });

  it("lists only immutable metadata for the selected account without credential or binding internals", async () => {
    const { value, request } = harness();
    const grant = await request({ recipients: ["recipient@example.test", "recipient@EXAMPLE.TEST"], messageRefs: [firstRef, firstRef] });
    const listed = value.list(context);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ recipients: ["recipient@example.test"], messageRefs: [firstRef], authorizationId: grant.authorizationId });
    expect(Object.keys(listed[0]!).sort()).toEqual([
      "accountEmail", "actions", "authorizationId", "createdAt", "expiresAt", "maxOperations", "messageRefs",
      "purpose", "recipients", "remainingOperations",
    ]);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(context.scope);
    expect(JSON.stringify(listed)).not.toContain(context.fingerprint);
  });

  it("disposal rejects active and pending grants and is idempotent", async () => {
    const { value, request } = harness();
    const grant = await request();
    const receipt = value.consume(grant.authorizationId, context, edit);
    const confirmation = deferred<ApprovalResult>();
    const pending = value.request(input(), context, () => confirmation.promise, () => context);
    value.dispose();
    value.dispose();
    confirmation.resolve({ status: "approved" });
    await expect(pending).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_UNAVAILABLE" });
    expectFailure(() => value.assertStillValid(receipt, context), "MAIL_AUTHORIZATION_UNAVAILABLE");
    expectFailure(() => value.consume(grant.authorizationId, context, edit), "MAIL_AUTHORIZATION_UNAVAILABLE");
    expectFailure(() => value.list(context), "MAIL_AUTHORIZATION_UNAVAILABLE");
    await expect(request()).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_UNAVAILABLE" });
  });

  it("does not restore grants in a fresh store and fails closed on an invalid clock", async () => {
    const { request } = harness();
    const grant = await request();
    const restarted = new MailAuthorizationStore();
    expectFailure(() => restarted.consume(grant.authorizationId, context, edit), "MAIL_AUTHORIZATION_INVALID");
    for (const now of [NaN, Infinity, -1]) {
      const invalidClock = new MailAuthorizationStore({ now: () => now });
      await expect(invalidClock.request(input(), context, approve, () => context)).rejects.toMatchObject({ code: "MAIL_AUTHORIZATION_UNAVAILABLE" });
    }
  });
});
