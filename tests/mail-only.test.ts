import { describe, expect, it, vi } from "vitest";
import { attachmentStorageFilename, openSafeDownloadFile, type DownloadFileSystem } from "../src/security.js";

function fileSystem(root: string) {
  return {
    isLocalDrive: vi.fn(async () => true),
    mkdir: vi.fn(async () => undefined),
    lstat: vi.fn(async (file: string) => {
      if (file.endsWith(".download") || file.endsWith(".pdf")) throw Object.assign(Error("missing"), { code: "ENOENT" });
      return { isSymbolicLink: () => false };
    }),
    realpath: vi.fn(async () => root),
    openExclusive: vi.fn(async () => ({ write: async () => ({ bytesWritten: 1 }), close: async () => undefined })),
    unlink: vi.fn(async () => undefined),
  } satisfies DownloadFileSystem;
}

describe("mail-only attachment storage", () => {
  it("neutralizes host instruction, executable, shortcut, configuration and unknown filenames", () => {
    for (const name of [
      "AGENTS.md", "AGENTS.override.md", "SKILL.md", "CLAUDE.md", "config.toml", ".env", "desktop.ini",
      "install.exe", "code.ps1", "script.cmd", "payload.lnk", "macro.docm", "page.html", "extension.dll",
      "python.py", "script.js", "resume.pdf.exe", "ＧＡＧＥＮＴＳ.md", "AGENTS.md. ", "archive",
    ]) expect(attachmentStorageFilename(name)).toMatch(/\.download$/);
    expect(attachmentStorageFilename("invoice.pdf")).toBe("invoice.pdf");
    expect(attachmentStorageFilename("../../AGENTS.md")).toBe("AGENTS.md.download");
  });

  it("applies the neutralized filename to the actual exclusive file-open request", async () => {
    const root = "D:\\Synthetic\\Downloads";
    const fs = fileSystem(root);
    const opened = await openSafeDownloadFile(root, "AGENTS.md", { fileSystem: fs });
    expect(opened.path).toBe("D:\\Synthetic\\Downloads\\AGENTS.md.download");
    expect(fs.openExclusive).toHaveBeenCalledExactlyOnceWith(opened.path);
    await opened.handle.close();
  });

  it("blocks sensitive destinations before directory probing or file creation", async () => {
    for (const root of [
      "D:\\.codex", "D:\\Project\\.agents\\skills", "D:\\Repo\\.git\\hooks", "D:\\.ssh",
      "D:\\.aws", "C:\\Windows\\Temp", "C:\\ProgramData\\Start Menu",
      "D:\\Profile\\Startup", "D:\\Profile\\AppData\\Local\\Codex\\plugins\\qq-mail",
      "D:\\Downloads\\..\\.codex", "D:\\.codex. \\config",
    ]) {
      const fs = fileSystem(root);
      await expect(openSafeDownloadFile(root, "report.pdf", { fileSystem: fs }))
        .rejects.toMatchObject({ code: "UNSAFE_DOWNLOAD_PATH" });
      expect(fs.isLocalDrive).not.toHaveBeenCalled();
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.openExclusive).not.toHaveBeenCalled();
    }
  });

  it("checks the canonical destination as well as the displayed path", async () => {
    const fs = fileSystem("D:\\Profile\\.codex");
    await expect(openSafeDownloadFile("D:\\Downloads", "report.pdf", { fileSystem: fs }))
      .rejects.toMatchObject({ code: "UNSAFE_DOWNLOAD_PATH" });
    expect(fs.openExclusive).not.toHaveBeenCalled();
  });
});
