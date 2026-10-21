import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureWindowsDirectory, openWindowsWriteFile, readWindowsFile } from "../src/windows-path-lease.js";
import { readSelectedLocalFile } from "../src/outgoing-attachments.js";
import { writeSafeDownload } from "../src/security.js";

const directories: string[] = [];
const junctions: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "qqmail-native-path-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  // Remove junction entries before their targets; a dangling native junction
  // must not be mistaken for a directory by recursive cleanup in the sandbox.
  for (const junction of junctions.splice(0)) await rmdir(junction);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe.skipIf(process.platform !== "win32")("native file handle path containment", () => {
  it("reads the checked handle, supports canonical SUBST resolution and releases it after size rejection", async () => {
    const directory = await temporary();
    const filename = path.join(directory, "选中的附件.bin");
    const bytes = Buffer.from([0, 1, 255, 13, 10, 127]);
    await writeFile(filename, bytes);
    const canonical = await realpath(filename);
    expect(await readWindowsFile(filename, canonical, 1024)).toEqual(bytes);
    await expect(readWindowsFile(filename, canonical, 2)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await writeFile(filename, "changed after helper closed");
    expect(await readFile(filename, "utf8")).toBe("changed after helper closed");
  }, 90_000);

  it("rejects a real junction pointing at an existing readable file before releasing any content", async () => {
    const directory = await temporary();
    const actual = path.join(directory, "actual");
    await mkdir(actual);
    const original = path.join(actual, "private.txt");
    await writeFile(original, "Synthetic real target: this must remain unread through the junction");
    const link = path.join(directory, "redirect");
    await symlink(await realpath(actual), link, "junction");
    junctions.push(link);
    const redirected = path.join(link, "private.txt");
    // Establish that a missing-file error cannot make this test pass.
    expect(await readFile(redirected, "utf8")).toContain("Synthetic real target");
    await expect(readWindowsFile(redirected, await realpath(redirected), 1024)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(readSelectedLocalFile(redirected, 1024)).rejects.toMatchObject({ code: "UNSAFE_ATTACHMENT_PATH" });
    expect(await readFile(original, "utf8")).toContain("Synthetic real target");
  }, 90_000);

  it("blocks ancestor replacement while an actual write handle is open and releases the lease after commit", async () => {
    const directory = await temporary();
    const ancestor = path.join(directory, "owned");
    const destination = path.join(ancestor, "nested");
    await mkdir(destination, { recursive: true });
    const filename = path.join(destination, "saved.txt");
    const canonical = path.join(await realpath(destination), "saved.txt");
    const writer = await openWindowsWriteFile(filename, 1024, canonical);
    let committed = false;
    try {
      await expect(rename(ancestor, path.join(directory, "moved"))).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:EACCES|EPERM|EBUSY)$/u),
      });
      expect(await writer.write(Buffer.from("safe bytes"))).toEqual({ bytesWritten: 10 });
      await writer.close();
      committed = true;
      expect(await readFile(filename, "utf8")).toBe("safe bytes");
      await rename(ancestor, path.join(directory, "moved"));
    } finally { if (!committed) await writer.abort(); }
  }, 90_000);

  it("deletes the same unfinished native handle on abort without leaving a partial file", async () => {
    const directory = await temporary();
    const filename = path.join(directory, "partial.txt");
    const writer = await openWindowsWriteFile(filename, 1024, path.join(await realpath(directory), "partial.txt"));
    await writer.write(Buffer.from("partial"));
    await writer.abort();
    expect(await readdir(directory)).toEqual([]);
  }, 90_000);

  it("creates missing directories under held ancestors and refuses a junction before mkdir escapes", async () => {
    const directory = await temporary();
    const created = path.join(directory, "one", "two");
    await ensureWindowsDirectory(created);
    expect((await stat(created)).isDirectory()).toBe(true);
    const target = path.join(directory, "target");
    await mkdir(target);
    const link = path.join(directory, "redirect");
    await symlink(await realpath(target), link, "junction");
    junctions.push(link);
    await expect(ensureWindowsDirectory(path.join(link, "must-not-create"))).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(stat(path.join(target, "must-not-create"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 90_000);

  it("retains exclusive filename collision and bounded-download cleanup semantics", async () => {
    const directory = await temporary();
    async function* content() { yield Buffer.from("saved"); }
    const first = await writeSafeDownload(directory, "report.txt", content(), { maxBytes: 10 });
    const second = await writeSafeDownload(directory, "report.txt", content(), { maxBytes: 10 });
    expect(path.basename(first.path)).toBe("report.txt");
    expect(path.basename(second.path)).toBe("report (1).txt");
    expect(await readFile(first.path, "utf8")).toBe("saved");
    async function* oversized() { yield Buffer.from("1234"); }
    await expect(writeSafeDownload(directory, "oversized.txt", oversized(), { maxBytes: 3 })).rejects.toMatchObject({ code: "INVALID_DOWNLOAD_SIZE" });
    expect((await readdir(directory)).sort()).toEqual(["report (1).txt", "report.txt"]);
  }, 90_000);
});
