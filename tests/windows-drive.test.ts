import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { DRIVE_QUERY_TIMEOUT_MS, isLocalWindowsDrive } from "../src/windows-drive.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function child() {
  const value = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValueOnce(value as unknown as ReturnType<typeof spawn>);
  return value;
}

describe("bounded native drive query", () => {
  it("rejects a network path before spawning any helper", async () => {
    expect(await isLocalWindowsDrive("\\\\server\\share")).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("allows a valid cold start beyond ten seconds without changing the drive decision", async () => {
    vi.useFakeTimers();
    const process = child();
    const result = isLocalWindowsDrive("C:\\");
    await vi.advanceTimersByTimeAsync(11_000);
    expect(process.kill).not.toHaveBeenCalled();
    process.stdout.emit("data", Buffer.from("LOCAL")); process.emit("close", 0);
    expect(await result).toBe(true);
    expect(process.stdin.end).toHaveBeenCalledWith("C:\\");
  });

  it("terminates a stalled query at the finite deadline and refuses late success", async () => {
    vi.useFakeTimers();
    const process = child();
    const result = isLocalWindowsDrive("C:\\");
    await vi.advanceTimersByTimeAsync(DRIVE_QUERY_TIMEOUT_MS);
    expect(await result).toBe(false);
    expect(process.kill).toHaveBeenCalledOnce();
    process.stdout.emit("data", Buffer.from("LOCAL")); process.emit("close", 0);
    expect(await result).toBe(false);
  });

  it("denies a non-local result even when the helper exits successfully", async () => {
    const process = child(); const result = isLocalWindowsDrive("C:\\");
    process.emit("close", 0);
    expect(await result).toBe(false);
  });

  it("denies unexpected helper output rather than accepting a LOCAL prefix", async () => {
    const process = child(); const result = isLocalWindowsDrive("C:\\");
    process.stdout.emit("data", Buffer.from("LOCAL unexpected")); process.emit("close", 0);
    expect(await result).toBe(false);
  });
});
