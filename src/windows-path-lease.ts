import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

const MAX_NATIVE_BYTES = 100 * 1024 * 1024;
const FRAME_BYTES = 64 * 1024;

export class WindowsPathError extends Error {
  constructor(readonly code: string) { super("The native file operation could not safely acquire or use the selected path."); }
}

// Fixed program. Paths and bytes travel only as framed data over private stdio.
// The selected drive root anchors handle-relative opens. Every requested parent
// is held without FILE_SHARE_WRITE/DELETE; this also works with local SUBST roots.
// Final I/O uses the same handle whose reparse attributes and path were checked.
export const WINDOWS_PATH_LEASE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())) | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class QQMailSafePath {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential, Pack=1)] struct Disposition { public byte Delete; }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeName { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
    public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes;
    public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr file, uint access,
    ref ObjectAttributes attributes, out IoStatus status, IntPtr allocationSize, uint fileAttributes,
    uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder value, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle file);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveType(string root);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref Disposition info, uint size);

  const uint Reparse = 0x400, Directory = 0x10, OpenReparse = 0x200000, Backup = 0x2000000;
  static Exception Unsafe() { return new IOException("UNSAFE_PATH"); }
  static string Normal(string value) {
    if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) value = value.Substring(4);
    if (!Regex.IsMatch(value, @"^[A-Za-z]:\\") || value.IndexOf(':', 2) >= 0 ||
        value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0 ||
        Regex.IsMatch(value, @"[ .](?:[\\/]|$)")) throw Unsafe();
    value = Path.GetFullPath(value);
    return value.Length > 3 ? value.TrimEnd('\\') : value;
  }
  static bool Equal(string a, string b) { return String.Equals(Normal(a), Normal(b), StringComparison.OrdinalIgnoreCase); }
  static string Final(SafeFileHandle handle) {
    StringBuilder result = new StringBuilder(32768);
    uint count = GetFinalPathNameByHandle(handle, result, (uint)result.Capacity, 0);
    if (count == 0 || count >= result.Capacity) throw Unsafe();
    return Normal(result.ToString());
  }
  static Info Check(SafeFileHandle handle, bool directory) {
    Info info;
    if (handle.IsInvalid || GetFileType(handle) != 1 || !GetFileInformationByHandle(handle, out info) ||
        (info.Attributes & Reparse) != 0 || ((info.Attributes & Directory) != 0) != directory) throw Unsafe();
    return info;
  }
  static SafeFileHandle OpenRoot(string value) {
    SafeFileHandle handle = CreateFile(value, 0x80, 1, IntPtr.Zero, 3, OpenReparse | Backup, IntPtr.Zero);
    try { Check(handle, true); return handle; } catch { handle.Dispose(); throw; }
  }
  // Every descendant is resolved relative to the actual held parent object.
  // DOS drive remapping or renaming an ancestor above a SUBST root cannot
  // redirect these opens to a replacement directory with the same path text.
  static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, bool directory, bool create, bool write) {
    if (String.IsNullOrEmpty(name) || name == "." || name == ".." || name.IndexOfAny(new char[] {'\\', '/', ':', '\0'}) >= 0) throw Unsafe();
    IntPtr text = Marshal.StringToHGlobalUni(name);
    IntPtr unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName)));
    try {
      UnicodeName value = new UnicodeName { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)(name.Length * 2 + 2)), Buffer = text };
      Marshal.StructureToPtr(value, unicode, false);
      ObjectAttributes attributes = new ObjectAttributes {
        Length = Marshal.SizeOf(typeof(ObjectAttributes)), RootDirectory = parent.DangerousGetHandle(), ObjectName = unicode, Attributes = 0x40
      };
      IoStatus io;
      IntPtr raw;
      uint access = directory ? 0x100080U : write ? 0x40110080U : 0x80100000U;
      uint disposition = directory ? (create ? 3U : 1U) : write ? 2U : 1U;
      uint options = OpenReparse | 0x20U | (directory ? 1U : 0x40U);
      int status = NtCreateFile(out raw, access, ref attributes, out io, IntPtr.Zero, 0, 1, disposition, options, IntPtr.Zero, 0);
      if (status < 0) {
        uint error = RtlNtStatusToDosError(status);
        if (error == 80 || error == 183) throw new IOException("EEXIST");
        throw Unsafe();
      }
      SafeFileHandle handle = new SafeFileHandle(raw, true);
      try { Check(handle, directory); return handle; } catch { handle.Dispose(); throw; }
    } finally { Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text); }
  }
  static string LockAncestors(string requested, string expected, bool create, bool includeFinal, List<SafeFileHandle> held) {
    requested = Normal(requested);
    string aliasRoot = Path.GetPathRoot(requested);
    uint drive = GetDriveType(aliasRoot);
    if (drive != 2 && drive != 3 && drive != 6) throw Unsafe();
    SafeFileHandle alias = OpenRoot(aliasRoot);
    held.Add(alias);
    string physicalRoot = Final(alias);
    string expanded = Normal(Path.Combine(physicalRoot, requested.Substring(aliasRoot.Length)));
    if (!String.IsNullOrEmpty(expected) && !Equal(expanded, expected)) throw Unsafe();
    string parent = includeFinal ? requested : Path.GetDirectoryName(requested);
    string expectedCurrent = physicalRoot;
    foreach (string component in parent.Substring(aliasRoot.Length).Split(new char[] {'\\'}, StringSplitOptions.RemoveEmptyEntries)) {
      expectedCurrent = Path.Combine(expectedCurrent, component);
      SafeFileHandle directory = OpenRelative(held[held.Count - 1], component, true, create, false);
      held.Add(directory);
      if (!Equal(Final(directory), expectedCurrent)) throw Unsafe();
    }
    return expanded;
  }
  static void Line(string value) { Console.Out.WriteLine(value); Console.Out.Flush(); }
  static void DeleteOnClose(SafeFileHandle file, bool enabled) {
    Disposition disposition = new Disposition { Delete = enabled ? (byte)1 : (byte)0 };
    if (!SetFileInformationByHandle(file, 4, ref disposition, 1)) throw Unsafe();
  }
  public static void Run(string mode, string requested, string expected, long maximum) {
    List<SafeFileHandle> held = new List<SafeFileHandle>();
    SafeFileHandle file = null;
    FileStream stream = null;
    try {
      if (maximum < 1 || maximum > 104857600 || (mode != "read" && mode != "write" && mode != "mkdir")) throw Unsafe();
      string canonical = LockAncestors(requested, expected, mode == "mkdir", mode == "mkdir", held);
      if (mode == "mkdir") { Line("READY\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(canonical))); Line("DONE"); return; }
      file = OpenRelative(held[held.Count - 1], Path.GetFileName(Normal(requested)), false, false, mode == "write");
      Info before = Check(file, false);
      if (!Equal(Final(file), canonical)) throw Unsafe();
      long expectedSize = ((long)before.SizeHigh << 32) | before.SizeLow;
      if (mode == "read" && expectedSize > maximum) throw new IOException("LIMIT_EXCEEDED");
      // A killed/crashed writer keeps the new file delete-pending. Commit clears it.
      if (mode == "write") DeleteOnClose(file, true);
      stream = new FileStream(file, mode == "read" ? FileAccess.Read : FileAccess.Write, 65536, false);
      Line("READY\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(canonical)));
      long total = 0;
      if (mode == "read") {
        byte[] bytes = new byte[65536];
        int count;
        while ((count = stream.Read(bytes, 0, bytes.Length)) != 0) {
          total += count;
          if (total > maximum || total > expectedSize) throw new IOException("LIMIT_EXCEEDED");
          Line("DATA\t" + Convert.ToBase64String(bytes, 0, count));
        }
        Info after = Check(file, false);
        if (total != expectedSize || after.SizeHigh != before.SizeHigh || after.SizeLow != before.SizeLow ||
            after.Write.dwHighDateTime != before.Write.dwHighDateTime || after.Write.dwLowDateTime != before.Write.dwLowDateTime) {
          throw new IOException("FILE_CHANGED");
        }
      } else {
        while (true) {
          string command = Console.In.ReadLine();
          if (command == "COMMIT") {
            stream.Flush(true);
            DeleteOnClose(file, false);
            break;
          }
          if (command == null || command == "ABORT") break;
          if (!command.StartsWith("WRITE\t") || command.Length > 90000) throw Unsafe();
          byte[] bytes = Convert.FromBase64String(command.Substring(6));
          if (bytes.Length > 65536 || total + bytes.Length > maximum) throw new IOException("LIMIT_EXCEEDED");
          stream.Write(bytes, 0, bytes.Length);
          total += bytes.Length;
          Line("WROTE\t" + bytes.Length.ToString(System.Globalization.CultureInfo.InvariantCulture));
          Array.Clear(bytes, 0, bytes.Length);
        }
      }
      stream.Dispose(); stream = null;
      file.Dispose(); file = null;
      Line("DONE");
    } catch (Exception error) {
      string code = error.Message;
      if (code != "UNSAFE_PATH" && code != "LIMIT_EXCEEDED" && code != "EEXIST" && code != "FILE_CHANGED") code = "NATIVE_IO_FAILED";
      Line("ERROR\t" + code);
    } finally {
      if (stream != null) stream.Dispose();
      if (file != null) file.Dispose();
      for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose();
    }
  }
}
'@
  [QQMailSafePath]::Run([string]$request.mode, [string]$request.path, [string]$request.expected, [long]$request.maximum)
} catch { [Console]::Out.WriteLine('ERROR' + [char]9 + 'NATIVE_IO_FAILED') }
`;

class NativeChannel {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #lines: string[] = [];
  #pending: { resolve(value: string): void; reject(error: Error): void } | undefined;
  #error: Error | undefined;
  #buffer = "";
  #done = false;
  #timer: ReturnType<typeof setTimeout>;
  readonly closed: Promise<void>;

  constructor(mode: "read" | "write" | "mkdir", filename: string, maximum: number, expected = filename) {
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (process.platform !== "win32" || !windowsRoot || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_NATIVE_BYTES) {
      throw new WindowsPathError("UNSAFE_PATH");
    }
    this.child = spawn(path.win32.join(windowsRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PATH_LEASE_SCRIPT],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.#timer = setTimeout(() => this.fail(new WindowsPathError("NATIVE_TIMEOUT")), 90_000);
    this.#timer.unref();
    this.child.once("error", () => this.fail(new WindowsPathError("NATIVE_IO_FAILED")));
    this.child.stdin.once("error", () => this.fail(new WindowsPathError("NATIVE_IO_FAILED")));
    this.child.stderr.on("data", () => this.fail(new WindowsPathError("NATIVE_IO_FAILED")));
    this.child.stdout.setEncoding("ascii");
    this.child.stdout.on("data", (data: string) => {
      this.#timer.refresh();
      this.#buffer += data;
      let newline: number;
      while ((newline = this.#buffer.indexOf("\n")) !== -1) {
        const line = this.#buffer.slice(0, newline).replace(/\r$/u, "");
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.length > 90_000 || this.#lines.length > 1700) { this.fail(new WindowsPathError("NATIVE_IO_FAILED")); return; }
        if (line.startsWith("ERROR\t")) { this.fail(new WindowsPathError(line.slice(6))); return; }
        if (line === "DONE") this.#done = true;
        const pending = this.#pending;
        if (pending) { this.#pending = undefined; pending.resolve(line); }
        else this.#lines.push(line);
      }
      if (this.#buffer.length > 90_000) this.fail(new WindowsPathError("NATIVE_IO_FAILED"));
    });
    this.closed = new Promise(resolve => this.child.once("close", code => {
      clearTimeout(this.#timer);
      if (code !== 0 || !this.#done) this.fail(new WindowsPathError("NATIVE_IO_FAILED"));
      resolve();
    }));
    this.child.stdin.write(Buffer.from(JSON.stringify({ mode, path: filename, maximum, expected })).toString("base64") + "\n");
  }

  fail(error: Error): void {
    if (this.#error) return;
    this.#error = error;
    clearTimeout(this.#timer);
    this.child.kill();
    this.#pending?.reject(error);
    this.#pending = undefined;
  }

  next(): Promise<string> {
    if (this.#error) return Promise.reject(this.#error);
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve, reject) => { this.#pending = { resolve, reject }; });
  }

  send(line: string): void { this.#timer.refresh(); this.child.stdin.write(line + "\n"); }
  async finish(): Promise<void> { this.child.stdin.end(); await this.closed; if (this.#error) throw this.#error; }
  async stop(): Promise<void> { this.fail(new WindowsPathError("NATIVE_ABORTED")); await this.closed; }
}

async function ready(channel: NativeChannel): Promise<string> {
  const line = await channel.next();
  if (!line.startsWith("READY\t")) throw new WindowsPathError("NATIVE_IO_FAILED");
  return Buffer.from(line.slice(6), "base64").toString("utf8");
}

export async function ensureWindowsDirectory(directory: string): Promise<void> {
  const channel = new NativeChannel("mkdir", directory, 1, "");
  try {
    await ready(channel);
    if (await channel.next() !== "DONE") throw new WindowsPathError("NATIVE_IO_FAILED");
    await channel.finish();
  } catch (error) { await channel.stop(); throw error; }
}

export async function readWindowsFile(filename: string, expected: string, maximum: number): Promise<Buffer> {
  const channel = new NativeChannel("read", filename, maximum, expected);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    await ready(channel);
    while (true) {
      const line = await channel.next();
      if (line === "DONE") break;
      if (!line.startsWith("DATA\t")) throw new WindowsPathError("NATIVE_IO_FAILED");
      const chunk = Buffer.from(line.slice(5), "base64");
      total += chunk.length;
      if (chunk.length > FRAME_BYTES || total > maximum) { chunk.fill(0); throw new WindowsPathError("LIMIT_EXCEEDED"); }
      chunks.push(chunk);
    }
    await channel.finish();
    return Buffer.concat(chunks, total);
  } catch (error) { await channel.stop(); throw error; }
  finally { chunks.forEach(chunk => chunk.fill(0)); }
}

export interface NativeWriteHandle {
  write(data: Uint8Array): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export async function openWindowsWriteFile(filename: string, maximum = MAX_NATIVE_BYTES, expected = filename): Promise<NativeWriteHandle> {
  const channel = new NativeChannel("write", filename, maximum, expected);
  try { await ready(channel); } catch (error) { await channel.stop(); throw error; }
  let finished = false;
  const finish = async (commit: boolean): Promise<void> => {
    if (finished) return;
    finished = true;
    try {
      channel.send(commit ? "COMMIT" : "ABORT");
      if (await channel.next() !== "DONE") throw new WindowsPathError("NATIVE_IO_FAILED");
      await channel.finish();
    } catch (error) { await channel.stop(); throw error; }
  };
  return {
    async write(data) {
      if (finished) throw new WindowsPathError("NATIVE_IO_FAILED");
      const part = data.subarray(0, FRAME_BYTES);
      channel.send("WRITE\t" + Buffer.from(part).toString("base64"));
      const reply = await channel.next();
      if (reply !== `WROTE\t${part.length}`) { await channel.stop(); throw new WindowsPathError("NATIVE_IO_FAILED"); }
      return { bytesWritten: part.length };
    },
    close: () => finish(true), abort: () => finish(false),
  };
}
