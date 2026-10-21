import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_VERSION,
  ConfigStore,
  MAX_DOWNLOAD_BYTES,
  configSchema,
  createConfig,
  getConfigPaths,
  isLocalAbsoluteWindowsPath,
  loadConfig,
  saveConfig,
  writeFileAtomically,
} from "../src/config.js";
import {
  DEFAULT_DPAPI_TIMEOUT_MS,
  DpapiError,
  CredentialStore,
  loadSecret,
  protectSecret,
  saveSecret,
  unprotectSecret,
  type DpapiProcessRunner,
} from "../src/dpapi.js";
import {
  DEFAULT_WINDOWS_ACL_TIMEOUT_MS,
  WindowsAclError,
  type WindowsAclProcessRequest,
  type WindowsAclProcessRunner,
} from "../src/windows-acl.js";
import { DraftError, DraftStore, type DraftDeliveryAdapter, type DraftPreview } from "../src/drafts.js";
import {
  MessageReferenceError,
  StaleMessageReferenceError,
  assertCurrentMessageReference,
  decodeMessageReference,
  encodeMessageReference,
} from "../src/references.js";
import {
  SecurityError,
  assertNoHeaderInjection,
  htmlToSafeText,
  resolveSafeDownloadPath,
  sanitizeWindowsFilename,
  writeSafeDownload,
} from "../src/security.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "qq-mail-core-"));
  temporaryDirectories.push(directory);
  return directory;
}

function decodeAclTarget(request: Pick<WindowsAclProcessRequest, "stdin">): string {
  const [kind, encodedPath] = Buffer.from(request.stdin).toString("ascii").split("\n", 2);
  expect(kind).toMatch(/^(?:directory|file)$/u);
  expect(encodedPath).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
  return Buffer.from(encodedPath as string, "base64").toString("utf8");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("versioned configuration", () => {
  const environment = {
    USERPROFILE: "C:\\Users\\Codex",
    LOCALAPPDATA: "C:\\Users\\Codex\\AppData\\Local",
  } as NodeJS.ProcessEnv;

  it("resolves the personal preset without storing a credential", () => {
    const config = createConfig(
      {
        preset: "personal",
        email: "person@qq.com",
        displayName: "Person",
      },
      environment,
    );

    expect(config).toMatchObject({
      version: CONFIG_VERSION,
      username: "person@qq.com",
      imap: { host: "imap.qq.com", port: 993, security: "tls", rejectUnauthorized: true },
      smtp: { host: "smtp.qq.com", port: 465, security: "tls", rejectUnauthorized: true },
      maxDownloadBytes: MAX_DOWNLOAD_BYTES,
    });
    expect(config).not.toHaveProperty("authorizationCode");
    expect(getConfigPaths({ environment }).configPath).toBe(
      path.join(environment.LOCALAPPDATA as string, "Codex", "plugins", "qq-mail", "config.json"),
    );
  });

  it("allows only the documented personal SMTP alternative", () => {
    const base = createConfig(
      { preset: "personal", email: "person@qq.com", displayName: "" },
      environment,
    );
    expect(
      configSchema.parse({
        ...base,
        smtp: { host: "smtp.qq.com", port: 587, security: "starttls", rejectUnauthorized: true },
      }).smtp.port,
    ).toBe(587);
    expect(() =>
      configSchema.parse({
        ...base,
        smtp: { host: "attacker.invalid", port: 587, security: "starttls", rejectUnauthorized: true },
      }),
    ).toThrow();
    expect(() => configSchema.parse({ ...base, maxDownloadBytes: MAX_DOWNLOAD_BYTES + 1 })).toThrow();
    expect(() =>
      configSchema.parse({
        ...base,
        imap: { ...base.imap, rejectUnauthorized: false },
      }),
    ).toThrow();
  });

  it("accepts only absolute download directories on a local Windows drive", () => {
    const base = createConfig(
      { preset: "personal", email: "person@qq.com", displayName: "" },
      environment,
    );
    expect(isLocalAbsoluteWindowsPath("D:\\QQ Mail\\Attachments")).toBe(true);
    expect(isLocalAbsoluteWindowsPath("D:/QQ Mail/Attachments")).toBe(true);

    for (const downloadDirectory of [
      "Downloads\\QQ Mail",
      "\\\\server\\share\\QQ Mail",
      "\\\\?\\C:\\Downloads\\QQ Mail",
    ]) {
      expect(isLocalAbsoluteWindowsPath(downloadDirectory)).toBe(false);
      expect(() => configSchema.parse({ ...base, downloadDirectory })).toThrow();
    }
  });

  it("atomically saves only schema-approved fields", async () => {
    const directory = await temporaryDirectory();
    const config = createConfig(
      {
        preset: "enterprise",
        email: "person@example.com",
        displayName: "Example",
        inboxMailbox: "Inbox",
        sentMailbox: "Sent",
        draftsMailbox: "Drafts",
        trashMailbox: "Trash",
        spamMailbox: "Spam",
        archiveMailbox: "Archive",
      },
      environment,
    );
    await saveConfig(config, { directory });
    await expect(loadConfig({ directory })).resolves.toEqual(config);
    expect(config).toMatchObject({
      inboxMailbox: "Inbox",
      sentMailbox: "Sent",
      draftsMailbox: "Drafts",
      trashMailbox: "Trash",
      spamMailbox: "Spam",
      archiveMailbox: "Archive",
    });
    const serialized = await readFile(path.join(directory, "config.json"), "utf8");
    expect(serialized).not.toContain("secret");
    expect(await readdir(directory)).toEqual(["config.json"]);
    expect(() => configSchema.parse({ ...config, authorizationCode: "must-not-persist" })).toThrow();
  });

  it("exposes a non-sensitive ConfigStore interface", async () => {
    const directory = await temporaryDirectory();
    const store = new ConfigStore({ directory });
    const config = createConfig(
      { preset: "xinchuang", email: "person@example.com", displayName: "Example" },
      environment,
    );
    await store.save(config);
    await expect(store.load()).resolves.toEqual(config);
    expect(store.paths.secretPath).toBe(path.join(directory, "secret.bin"));
  });

  it("restricts the directory and temporary file before an atomic Windows replacement", async () => {
    const directory = await temporaryDirectory();
    const targetPath = path.join(directory, "config.json");
    const calls: Array<{
      targetKind: WindowsAclProcessRequest["targetKind"];
      targetPath: string;
      args: readonly string[];
      timeoutMs: number;
    }> = [];
    const runner: WindowsAclProcessRunner = async (request) => {
      const aclTarget = decodeAclTarget(request);
      calls.push({
        targetKind: request.targetKind,
        targetPath: aclTarget,
        args: request.args,
        timeoutMs: request.timeoutMs,
      });
      if (request.targetKind === "file") {
        await expect(readFile(aclTarget, "utf8")).resolves.toBe("new contents");
        await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
      return { exitCode: 0 };
    };

    await writeFileAtomically(targetPath, "new contents", 0o600, {
      runner,
      platform: "win32",
      powershellPath: "powershell.exe",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      targetKind: "directory",
      targetPath: directory,
      timeoutMs: DEFAULT_WINDOWS_ACL_TIMEOUT_MS,
    });
    expect(calls[1]?.targetKind).toBe("file");
    expect(calls[1]?.targetPath).toMatch(new RegExp(`^${directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\\\?\\.config\\.json\\..+\\.tmp$`, "u"));
    expect(calls.every((call) => call.args.every((argument) => !argument.includes(directory)))).toBe(true);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("new contents");
    expect(await readdir(directory)).toEqual(["config.json"]);
  });

  it("keeps the old file and removes the temporary file when Windows ACL hardening fails", async () => {
    const directory = await temporaryDirectory();
    const targetPath = path.join(directory, "config.json");
    await writeFile(targetPath, "old contents");
    const runner: WindowsAclProcessRunner = async (request) => ({
      exitCode: request.targetKind === "directory" ? 0 : 1,
    });

    await expect(
      writeFileAtomically(targetPath, "new contents", 0o600, {
        runner,
        platform: "win32",
        powershellPath: "powershell.exe",
      }),
    ).rejects.toBeInstanceOf(WindowsAclError);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("old contents");
    expect(await readdir(directory)).toEqual(["config.json"]);
  });
});

describe("Windows DPAPI boundary", () => {
  function fakeRunner(requests: Parameters<DpapiProcessRunner>[0][]): DpapiProcessRunner {
    return async (request) => {
      requests.push(request);
      const input = Buffer.from(Buffer.from(request.stdin).toString("ascii"), "base64");
      const output = Buffer.from(input);
      for (let index = 0; index < output.byteLength; index += 1) {
        output[index] = (output[index] as number) ^ 0xa5;
      }
      return { exitCode: 0, stdout: Buffer.from(output.toString("base64"), "ascii") };
    };
  }

  it("passes secret material through stdin and never argv", async () => {
    const requests: Parameters<DpapiProcessRunner>[0][] = [];
    const runner = fakeRunner(requests);
    const secret = "authorization-code-123";
    const encrypted = await protectSecret(secret, {
      runner,
      platform: "win32",
      powershellPath: "powershell.exe",
    });
    await expect(
      unprotectSecret(encrypted, { runner, platform: "win32", powershellPath: "powershell.exe" }),
    ).resolves.toBe(secret);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.args.every((argument) => !argument.includes(secret)))).toBe(true);
    expect(requests.every((request) => request.timeoutMs === DEFAULT_DPAPI_TIMEOUT_MS)).toBe(true);
    expect(requests.every((request) => !request.signal.aborted)).toBe(true);
    expect(Buffer.from(requests[0]?.stdin ?? []).byteLength).toBeGreaterThan(0);
  });

  it("stores only the protected blob in secret.bin", async () => {
    const directory = await temporaryDirectory();
    const requests: Parameters<DpapiProcessRunner>[0][] = [];
    const aclRequests: Array<{
      args: readonly string[];
      stdin: Buffer;
      targetPath: string;
    }> = [];
    const aclRunner: WindowsAclProcessRunner = async (request) => {
      aclRequests.push({
        args: request.args,
        stdin: Buffer.from(request.stdin),
        targetPath: decodeAclTarget(request),
      });
      return { exitCode: 0 };
    };
    const options = {
      directory,
      runner: fakeRunner(requests),
      platform: "win32" as const,
      powershellPath: "powershell.exe",
      acl: {
        runner: aclRunner,
        platform: "win32" as const,
        powershellPath: "powershell.exe",
      },
    };
    await saveSecret("private-code", options);
    expect((await readFile(path.join(directory, "secret.bin"))).toString("utf8")).not.toContain("private-code");
    await expect(loadSecret(options)).resolves.toBe("private-code");
    expect(aclRequests).toHaveLength(2);
    expect(
      aclRequests.every(
        (request) =>
          !request.args.some((argument) => argument.includes("private-code")) &&
          !request.stdin.includes(Buffer.from("private-code")) &&
          !request.targetPath.includes("private-code"),
      ),
    ).toBe(true);
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;

  windowsIt("round-trips and clears a real CurrentUser DPAPI credential", async () => {
    const directory = await temporaryDirectory();
    const secret = "qq-mail-dpapi-roundtrip-dummy";
    const store = new CredentialStore({ directory });

    await store.set(secret);
    const encrypted = await readFile(path.join(directory, "secret.bin"));
    expect(encrypted.toString("utf8")).not.toContain(secret);
    await expect(store.get()).resolves.toBe(secret);

    await store.clear();
    await expect(store.get()).resolves.toBeNull();
  });

  it("exposes a dedicated CredentialStore for raw text credentials", async () => {
    const directory = await temporaryDirectory();
    const requests: Parameters<DpapiProcessRunner>[0][] = [];
    const store = new CredentialStore({
      directory,
      runner: fakeRunner(requests),
      platform: "win32",
      powershellPath: "powershell.exe",
    });
    await store.set("raw-text-secret");
    await expect(store.get()).resolves.toBe("raw-text-secret");
    await store.clear();
    await expect(store.get()).resolves.toBeNull();
  });

  it("does not expose subprocess errors or work outside Windows", async () => {
    const runner: DpapiProcessRunner = async () => {
      throw new Error("private-code was rejected");
    };
    await expect(
      protectSecret("private-code", { runner, platform: "win32", powershellPath: "powershell.exe" }),
    ).rejects.toMatchObject({ code: "DPAPI_FAILED", message: expect.not.stringContaining("private-code") });
    await expect(protectSecret("private-code", { platform: "linux" })).rejects.toBeInstanceOf(DpapiError);
  });

  it("aborts a hanging subprocess at the configured timeout and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      let processRequest: Parameters<DpapiProcessRunner>[0] | undefined;
      const runner: DpapiProcessRunner = (request) => {
        processRequest = request;
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("private-code timed out")),
            { once: true },
          );
        });
      };
      const pending = protectSecret("private-code", {
        runner,
        platform: "win32",
        powershellPath: "powershell.exe",
        timeoutMs: 25,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "DPAPI_FAILED",
        message: expect.not.stringContaining("private-code"),
      });

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(processRequest?.timeoutMs).toBe(25);
      expect(processRequest?.signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid timeout values before launching a subprocess", async () => {
    const runner = vi.fn<DpapiProcessRunner>();
    await expect(
      protectSecret("private-code", {
        runner,
        platform: "win32",
        powershellPath: "powershell.exe",
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "DPAPI_FAILED" });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("message references", () => {
  it("round-trips a versioned opaque reference", () => {
    const encoded = encodeMessageReference({ accountScope: "a".repeat(64), mailbox: "INBOX", uidValidity: 42n, uid: 123 });
    expect(encoded).toMatch(/^qqm2_[A-Za-z0-9_-]+$/u);
    expect(encoded).not.toContain("INBOX");
    expect(decodeMessageReference(encoded)).toEqual({
      version: 2,
      accountScope: "a".repeat(64),
      mailbox: "INBOX",
      uidValidity: "42",
      uid: 123,
    });
  });

  it("rejects tampering and explicitly reports stale UIDVALIDITY", () => {
    const encoded = encodeMessageReference({ accountScope: "a".repeat(64), mailbox: "INBOX", uidValidity: 42, uid: 123 });
    expect(() => decodeMessageReference(`${encoded}x`)).toThrow(MessageReferenceError);
    expect(() => assertCurrentMessageReference(encoded, 43)).toThrow(StaleMessageReferenceError);
    expect(() => assertCurrentMessageReference(encoded, 43)).toThrow(/mailbox was recreated/iu);
  });
});

describe("untrusted content and attachment paths", () => {
  it("converts HTML to plain text without retaining active or remote elements", () => {
    const text = htmlToSafeText(
      '<style>body{background:url(https://tracker.invalid)}</style><p>Hello &amp; bye</p><img src="https://tracker.invalid/pixel"><script>alert(1)</script>',
    );
    expect(text).toBe("Hello & bye");
    expect(text).not.toContain("tracker.invalid");
    expect(text).not.toContain("alert");
  });

  it("rejects CR/LF injection in all header-like values", () => {
    expect(assertNoHeaderInjection("Normal subject", "Subject")).toBe("Normal subject");
    expect(() => assertNoHeaderInjection("Hello\r\nBcc: victim@example.com", "Subject")).toThrow(SecurityError);
  });

  it("normalizes traversal, reserved names, and filename collisions", async () => {
    const directory = await temporaryDirectory();
    expect(sanitizeWindowsFilename("..\\..\\CON.txt")).toBe("_CON.txt");
    expect(sanitizeWindowsFilename("folder\\report.txt::$DATA")).toBe("report.txt__$DATA");
    await writeFile(path.join(directory, "_CON.txt"), "existing");
    await expect(resolveSafeDownloadPath(directory, "..\\CON.txt")).resolves.toBe(path.join(await realpath(directory), "_CON (1).txt"));
  });

  it("rejects relative, UNC, and device download roots before filesystem access", async () => {
    for (const downloadRoot of [
      "Downloads\\QQ Mail",
      "\\\\server\\share\\QQ Mail",
      "\\\\?\\C:\\Downloads\\QQ Mail",
    ]) {
      await expect(resolveSafeDownloadPath(downloadRoot, "report.txt")).rejects.toMatchObject({
        code: "UNSAFE_DOWNLOAD_PATH",
      });
    }
  });

  it("enforces the configured size while streaming and removes partial files", async () => {
    const directory = await temporaryDirectory();
    async function* oversized(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("1234");
    }
    await expect(writeSafeDownload(directory, "file.bin", oversized(), { maxBytes: 3 })).rejects.toMatchObject({
      code: "INVALID_DOWNLOAD_SIZE",
    });
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("single-attempt draft state machine", () => {
  const preview: DraftPreview = { to: ["recipient@example.com"], subject: "Subject", text: "Body" };

  it("expires an unsent draft after 30 minutes", () => {
    let now = Date.parse("2026-07-24T00:00:00.000Z");
    const store = new DraftStore<{ body: string }>({
      now: () => now,
      idFactory: () => "draft_12345678901234567890",
    });
    const draft = store.prepare({ body: "Body" }, preview, ["Review recipients"]);
    expect(draft.warnings).toEqual(["Review recipients"]);
    now += 30 * 60 * 1_000;
    expect(() => store.get(draft.draftId)).toThrowError(DraftError);
    expect(() => store.get(draft.draftId)).toThrow(/not found/iu);
  });

  it("coalesces concurrent and repeated sends", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: DraftDeliveryAdapter<{ body: string }> = {
      send: vi.fn(async () => {
        await gate;
        return { messageId: "<message@example.com>" };
      }),
      saveSentCopy: vi.fn(async () => undefined),
    };
    const store = new DraftStore<{ body: string }>({ idFactory: () => "draft_12345678901234567890" });
    const draft = store.prepare({ body: "Body" }, preview);
    const first = store.send(draft.draftId, adapter);
    const concurrent = store.send(draft.draftId, adapter);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    release?.();
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    const repeatedResult = await store.send(draft.draftId, adapter);
    expect(concurrentResult).toEqual(firstResult);
    expect(repeatedResult).toBe(firstResult);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.saveSentCopy).toHaveBeenCalledTimes(1);
  });

  it("returns the first sent result when saving the Sent copy fails", async () => {
    const adapter: DraftDeliveryAdapter<{ body: string }> = {
      send: vi.fn(async () => ({ messageId: "<sent@example.com>" })),
      saveSentCopy: vi.fn(async () => {
        throw new Error("IMAP append failed");
      }),
    };
    const store = new DraftStore<{ body: string }>({ idFactory: () => "draft_12345678901234567890" });
    const draft = store.prepare({ body: "Body" }, preview);
    const first = await store.send(draft.draftId, adapter);
    const repeated = await store.send(draft.draftId, adapter);
    expect(first).toMatchObject({ status: "sent_copy_failed", sent: true, sentCopySaved: false });
    expect(repeated).toBe(first);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.saveSentCopy).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous SMTP failure", async () => {
    const adapter: DraftDeliveryAdapter<{ body: string }> = {
      send: vi.fn(async () => {
        throw new Error("connection closed after DATA");
      }),
      saveSentCopy: vi.fn(async () => undefined),
    };
    const store = new DraftStore<{ body: string }>({ idFactory: () => "draft_12345678901234567890" });
    const draft = store.prepare({ body: "Body" }, preview);
    await expect(store.send(draft.draftId, adapter)).rejects.toMatchObject({ code: "DRAFT_SEND_FAILED" });
    await expect(store.send(draft.draftId, adapter)).rejects.toMatchObject({ code: "DRAFT_SEND_FAILED" });
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.saveSentCopy).not.toHaveBeenCalled();
  });
});
