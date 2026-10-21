import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftJournalStorage } from "../src/draft-journal.js";
import { CloudDelegationBudget, type CloudDelegationConsent } from "../src/cloud/delegation-budget.js";

const budgets: CloudDelegationBudget[] = [];
afterEach(async () => { await Promise.allSettled(budgets.splice(0).map(budget => budget.close())); });
const consent: CloudDelegationConsent = { consentId: "consent_synthetic_one", policyDigest: "a".repeat(64), maxOperations: 100 };
const key = () => Buffer.alloc(32, 7);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Synthetic durable medium shared across fresh storage handles and budget instances. */
function medium() {
  let bytes: Buffer | null = null;
  let locked = false;
  let inFlight = 0;
  let maxInFlight = 0;
  let failure: "before" | "after" | undefined;
  let beforeWrite: (() => Promise<void>) | undefined;
  function storage() {
    let held = false;
    const value: DraftJournalStorage = {
      acquire: vi.fn(async () => {
        if (locked) throw new Error("Synthetic exclusive lock busy");
        locked = held = true;
      }),
      read: vi.fn(async () => {
        if (!held) throw new Error("Synthetic missing lock");
        return bytes === null ? null : Buffer.from(bytes);
      }),
      write: vi.fn(async data => {
        if (!held) throw new Error("Synthetic missing lock");
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await beforeWrite?.();
          if (failure === "before") throw new Error("Synthetic write failed before commit");
          bytes = Buffer.from(data);
          if (failure === "after") throw new Error("Synthetic write status lost after commit");
        } finally { inFlight -= 1; }
      }),
      release: vi.fn(async () => { if (held) locked = held = false; }),
    };
    return value;
  }
  return { storage, get: () => bytes === null ? null : Buffer.from(bytes), set: (value: Buffer) => { bytes = Buffer.from(value); },
    fail: (value: typeof failure) => { failure = value; }, gate: (value: typeof beforeWrite) => { beforeWrite = value; },
    maxInFlight: () => maxInFlight, locked: () => locked };
}
function create(storage: DraftJournalStorage, declared: CloudDelegationConsent = consent, secret = key()) {
  const budget = new CloudDelegationBudget(storage, secret, declared);
  budgets.push(budget);
  return budget;
}

describe("persistent cloud delegation budget", () => {
  it("initializes exactly once and publishes only bounded metadata", async () => {
    const disk = medium();
    const storage = disk.storage();
    const budget = create(storage);
    expect(budget.snapshot()).toEqual({ ...consent, state: "new", remainingOperations: null });
    await Promise.all([budget.initialize(), budget.initialize(), budget.initialize()]);
    await budget.initialize();
    expect(storage.acquire).toHaveBeenCalledTimes(1);
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(budget.snapshot()).toEqual({ ...consent, state: "ready", remainingOperations: 100 });
    const ledger = JSON.parse(disk.get()!.toString()) as Record<string, unknown>;
    expect(Object.keys(ledger).sort()).toEqual(["consentId", "mac", "policyDigest", "remainingOperations", "version"]);
    expect(ledger.mac).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(budget.snapshot())).toBe(true);
    expect(disk.locked()).toBe(true);
  });

  it("serializes whole-grant reservations without exceeding the total budget", async () => {
    const disk = medium();
    const budget = create(disk.storage());
    await budget.initialize();
    await Promise.all([budget.reserve(30), budget.reserve(30), budget.reserve(40)]);
    expect(budget.snapshot().remainingOperations).toBe(0);
    expect(JSON.parse(disk.get()!.toString()).remainingOperations).toBe(0);
    expect(disk.maxInFlight()).toBe(1);
    await expect(budget.reserve(1)).rejects.toMatchObject({ code: "CLOUD_DELEGATION_EXHAUSTED" });
    expect(budget.snapshot().state).toBe("ready");
  });

  it("has exactly one winner for concurrent requests for the final operation", async () => {
    const disk = medium();
    const budget = create(disk.storage(), { ...consent, maxOperations: 1 });
    await budget.initialize();
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => budget.reserve(1)));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(19);
    expect(budget.snapshot().remainingOperations).toBe(0);
  });

  it("does not return an approval reservation before the durable write finishes", async () => {
    const disk = medium();
    const budget = create(disk.storage());
    await budget.initialize();
    const entered = deferred(), release = deferred();
    disk.gate(async () => { entered.resolve(); await release.promise; });
    let finished = false;
    const pending = budget.reserve(20).then(() => { finished = true; });
    await entered.promise;
    expect(finished).toBe(false);
    expect(budget.snapshot().remainingOperations).toBe(100);
    release.resolve();
    await pending;
    expect(budget.snapshot().remainingOperations).toBe(80);
  });

  for (const failAt of ["before", "after"] as const) {
    it(`disables further reservations after an ambiguous ${failAt}-commit write error`, async () => {
      const disk = medium();
      const budget = create(disk.storage(), { ...consent, maxOperations: 5 });
      await budget.initialize();
      disk.fail(failAt);
      await expect(budget.reserve(3)).rejects.toMatchObject({ code: "CLOUD_DELEGATION_UNAVAILABLE" });
      expect(budget.snapshot()).toMatchObject({ state: "failed", remainingOperations: null });
      disk.fail(undefined);
      await expect(budget.reserve(1)).rejects.toMatchObject({ code: "CLOUD_DELEGATION_UNAVAILABLE" });
      await expect(budget.initialize()).rejects.toMatchObject({ code: "CLOUD_DELEGATION_UNAVAILABLE" });
      await budget.close();
      const restarted = create(disk.storage(), { ...consent, maxOperations: 5 });
      await restarted.initialize();
      expect(restarted.snapshot().remainingOperations).toBe(failAt === "after" ? 2 : 5);
    });
  }

  it("keeps the consumed total across restart instead of resetting the same consent", async () => {
    const disk = medium();
    const first = create(disk.storage());
    await first.initialize();
    await first.reserve(100);
    await first.close();
    const storage = disk.storage();
    const second = create(storage);
    await second.initialize();
    expect(second.snapshot().remainingOperations).toBe(0);
    expect(storage.write).not.toHaveBeenCalled();
    await expect(second.reserve(1)).rejects.toMatchObject({ code: "CLOUD_DELEGATION_EXHAUSTED" });
  });

  it("rejects a changed policy under the same consent ID", async () => {
    const disk = medium();
    const first = create(disk.storage());
    await first.initialize();
    await first.reserve(20);
    await first.close();
    const storage = disk.storage();
    const changed = create(storage, { ...consent, policyDigest: "b".repeat(64) });
    await expect(changed.initialize()).rejects.toMatchObject({ code: "CLOUD_DELEGATION_POLICY_CHANGED" });
    expect(storage.write).not.toHaveBeenCalled();
    expect(disk.locked()).toBe(false);
  });

  it("accepts a new operator consent ID as explicit renewal after authenticating prior state", async () => {
    const disk = medium();
    const first = create(disk.storage());
    await first.initialize();
    await first.reserve(100);
    await first.close();
    const renewed = { consentId: "consent_synthetic_two", policyDigest: "b".repeat(64), maxOperations: 7 };
    const second = create(disk.storage(), renewed);
    await second.initialize();
    expect(second.snapshot()).toEqual({ ...renewed, state: "ready", remainingOperations: 7 });
    await second.reserve(7);
    await expect(second.reserve(1)).rejects.toMatchObject({ code: "CLOUD_DELEGATION_EXHAUSTED" });
  });

  for (const [field, replacement] of [
    ["version", 2], ["consentId", "attacker_changed_consent"], ["policyDigest", "f".repeat(64)],
    ["remainingOperations", 100], ["mac", "0".repeat(64)], ["undeclared", true],
  ] as const) {
    it(`rejects tampered ${field} without recreating a fresh allowance`, async () => {
      const disk = medium();
      const first = create(disk.storage());
      await first.initialize();
      await first.reserve(90);
      await first.close();
      const ledger = JSON.parse(disk.get()!.toString()) as Record<string, unknown>;
      ledger[field] = replacement;
      disk.set(Buffer.from(JSON.stringify(ledger)));
      const storage = disk.storage();
      const second = create(storage);
      await expect(second.initialize()).rejects.toMatchObject({ code: "CLOUD_DELEGATION_INVALID" });
      expect(storage.write).not.toHaveBeenCalled();
      await expect(second.reserve(1)).rejects.toMatchObject({ code: "CLOUD_DELEGATION_UNAVAILABLE" });
    });
  }

  it("does not let a new consent ID bypass corruption in the existing ledger", async () => {
    const disk = medium();
    disk.set(Buffer.from("{corrupt"));
    const budget = create(disk.storage(), { ...consent, consentId: "consent_synthetic_two" });
    await expect(budget.initialize()).rejects.toMatchObject({ code: "CLOUD_DELEGATION_INVALID" });
  });

  it("rejects the wrong key and preserves ownership of the supplied key buffer", async () => {
    const disk = medium();
    const supplied = key();
    const first = create(disk.storage(), consent, supplied);
    supplied.fill(9);
    await first.initialize();
    await first.reserve(20);
    await first.close();
    expect(supplied).toEqual(Buffer.alloc(32, 9));
    const wrong = create(disk.storage(), consent, Buffer.alloc(32, 8));
    await expect(wrong.initialize()).rejects.toMatchObject({ code: "CLOUD_DELEGATION_INVALID" });
    const correct = create(disk.storage());
    await correct.initialize();
    expect(correct.snapshot().remainingOperations).toBe(80);
  });

  it("keeps one process-lifetime lock until close", async () => {
    const disk = medium();
    const first = create(disk.storage());
    await first.initialize();
    const blocked = create(disk.storage());
    await expect(blocked.initialize()).rejects.toMatchObject({ code: "CLOUD_DELEGATION_UNAVAILABLE" });
    expect(disk.locked()).toBe(true);
    await first.close();
    const next = create(disk.storage());
    await next.initialize();
    expect(next.snapshot().remainingOperations).toBe(100);
  });

  it("waits for an in-flight reservation before releasing the lock during close", async () => {
    const disk = medium();
    const storage = disk.storage();
    const budget = create(storage);
    await budget.initialize();
    const entered = deferred(), release = deferred();
    disk.gate(async () => { entered.resolve(); await release.promise; });
    const pending = budget.reserve(30);
    await entered.promise;
    const closing = budget.close();
    expect(storage.release).not.toHaveBeenCalled();
    await expect(budget.reserve(1)).rejects.toMatchObject({ code: "CLOUD_DELEGATION_UNAVAILABLE" });
    release.resolve();
    await pending;
    await closing;
    await budget.close();
    expect(storage.release).toHaveBeenCalledTimes(1);
    expect(budget.snapshot()).toMatchObject({ state: "closed", remainingOperations: null });
    await expect(budget.initialize()).rejects.toMatchObject({ code: "CLOUD_DELEGATION_UNAVAILABLE" });
  });

  it("rejects malformed limits and uninitialized reservations without storage writes", async () => {
    const disk = medium();
    const storage = disk.storage();
    const budget = create(storage);
    await expect(budget.reserve(1)).rejects.toMatchObject({ code: "CLOUD_DELEGATION_UNAVAILABLE" });
    for (const units of [0, -1, 101, 1.5, NaN, Infinity]) {
      await expect(budget.reserve(units)).rejects.toMatchObject({ code: "CLOUD_DELEGATION_INVALID" });
    }
    for (const maximum of [0, -1, 101, 1.5, NaN, Infinity]) {
      expect(() => new CloudDelegationBudget(storage, key(), { ...consent, maxOperations: maximum })).toThrow();
    }
    expect(() => new CloudDelegationBudget(storage, Buffer.alloc(31), consent)).toThrow();
    expect(() => new CloudDelegationBudget(storage, key(), { ...consent, policyDigest: "wrong" })).toThrow();
    expect(storage.acquire).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
  });
});
