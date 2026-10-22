import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountStore } from "../src/account-store.js";
import { createConfig, getConfigPaths, writeFileAtomically } from "../src/config.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof promises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = [];
const junctions: string[] = [];
async function fixture() {
  const root = await promises.mkdtemp(path.join(tmpdir(), "qqmail-location-"));
  roots.push(root);
  const environment = { USERPROFILE: path.join(root, "profile"), LOCALAPPDATA: path.join(root, "local") };
  return {
    root, environment,
    preferred: path.join(environment.USERPROFILE, ".qq-mail"),
    legacy: path.join(environment.LOCALAPPDATA, "Codex", "plugins", "qq-mail"),
  };
}
afterEach(async () => {
  vi.resetAllMocks();
  for (const junction of junctions.splice(0)) await promises.rmdir(junction);
  await Promise.all(roots.splice(0).map(root => promises.rm(root, { recursive: true, force: true })));
});

describe("account storage location compatibility", () => {
  it("stores a new account in the independent profile directory and can update it atomically", async () => {
    const { environment, preferred, legacy } = await fixture();
    await promises.mkdir(legacy, { recursive: true });
    expect(getConfigPaths({ environment }).directory).toBe(preferred);
    const store = new AccountStore({ environment, acl: { runner: async () => ({ exitCode: 0 }) } });
    const config = createConfig({ preset: "personal", email: "synthetic@qq.com", displayName: "" });
    await store.saveConfig(config, (await store.snapshot()).revision);
    await store.saveConfig({ ...config, displayName: "Updated" }, (await store.snapshot()).revision);
    expect((await new AccountStore({ environment }).snapshot()).config?.displayName).toBe("Updated");
    expect(await promises.readdir(legacy)).toEqual([]);
    expect(await promises.readdir(preferred)).toEqual(["account-profiles.json"]);
  });

  it.each(["account-profiles.json", "account.json", "config.json", "secret.bin", "drafts.enc.json", "account.lock", "drafts.lock.recovery"])(
    "keeps the legacy location when %s already exists without reading or migrating it", async name => {
      const { environment, preferred, legacy } = await fixture();
      await promises.mkdir(legacy, { recursive: true });
      await promises.writeFile(path.join(legacy, name), "SYNTHETIC PRESERVED");
      expect(getConfigPaths({ environment }).directory).toBe(legacy);
      expect(await promises.readFile(path.join(legacy, name), "utf8")).toBe("SYNTHETIC PRESERVED");
      await expect(promises.stat(preferred)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects two populated locations instead of silently selecting a different account", async () => {
    const { environment, preferred, legacy } = await fixture();
    for (const directory of [preferred, legacy]) {
      await promises.mkdir(directory, { recursive: true });
      await promises.writeFile(path.join(directory, "account-profiles.json"), "SYNTHETIC PRESERVED");
    }
    expect(() => getConfigPaths({ environment })).toThrowError(expect.objectContaining({ code: "CONFIG_LOCATION_CONFLICT" }));
    await expect(new AccountStore({ environment }).snapshot()).rejects.toMatchObject({ code: "CONFIG_LOCATION_CONFLICT" });
  });

  it("does not treat access denied as a missing legacy account", async () => {
    const { environment, legacy } = await fixture();
    const original = (await vi.importActual<typeof fs>("node:fs")).lstatSync;
    vi.mocked(fs.lstatSync).mockImplementation(((file: fs.PathLike, options: any) => {
      if (file === legacy) throw Object.assign(new Error("PRIVATE ERROR DETAILS"), { code: "EACCES" });
      return original(file, options);
    }) as typeof fs.lstatSync);
    expect(() => getConfigPaths({ environment })).toThrowError(expect.objectContaining({ code: "CONFIG_IO_ERROR" }));
    expect(() => getConfigPaths({ environment })).not.toThrowError("PRIVATE ERROR DETAILS");
  });

  it("rejects a redirected default storage directory", async () => {
    const { root, environment, preferred } = await fixture();
    const target = path.join(root, "redirect");
    await promises.mkdir(target);
    await promises.mkdir(environment.USERPROFILE);
    await promises.symlink(await promises.realpath(target), preferred, "junction");
    junctions.push(preferred);
    expect(await promises.realpath(preferred)).toBe(await promises.realpath(target));
    expect(() => getConfigPaths({ environment })).toThrowError(expect.objectContaining({ code: "CONFIG_IO_ERROR" }));
  });

  it("retains explicit internal storage injection and the LocalAppData-only fallback", async () => {
    const { root, environment, legacy } = await fixture();
    expect(getConfigPaths({ environment: { LOCALAPPDATA: environment.LOCALAPPDATA } }).directory).toBe(legacy);
    expect(getConfigPaths({ environment: {}, directory: root }).directory).toBe(root);
    expect(() => getConfigPaths({ environment: {} })).toThrowError(expect.objectContaining({ code: "CONFIG_PATH_UNAVAILABLE" }));
  });

  it("reports EXDEV without copying over existing data and removes its own temporary file", async () => {
    const { root } = await fixture();
    const destination = path.join(root, "account.json");
    await promises.writeFile(destination, "ORIGINAL SYNTHETIC ACCOUNT");
    vi.mocked(promises.rename).mockRejectedValue(Object.assign(new Error("PRIVATE PATH"), { code: "EXDEV" }));
    await expect(writeFileAtomically(destination, "REPLACEMENT", 0o600, { runner: async () => ({ exitCode: 0 }) }))
      .rejects.toMatchObject({ code: "CONFIG_ATOMIC_REPLACE_UNAVAILABLE" });
    expect(await promises.readFile(destination, "utf8")).toBe("ORIGINAL SYNTHETIC ACCOUNT");
    expect(await promises.readdir(root)).toEqual(["account.json"]);
  });
});
