import { build } from "esbuild";
import { readFile, writeFile, mkdir, rm, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
if (!dist.startsWith(root + "\\") && !dist.startsWith(root + "/")) throw Error("Invalid output directory");
const stat = await lstat(dist).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
if (stat?.isSymbolicLink()) throw Error("Refuse redirected build directory");
const started = performance.now();
const stage = name => console.error(`[build] ${name} (${Math.round(performance.now() - started)} ms)`);

stage("prepare");
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "ui"), { recursive: true });

stage("server");
await build({
  entryPoints: [join(root, "src", "server.ts")],
  outfile: join(dist, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  legalComments: "linked",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

stage("cloud MCP server");
await build({
  entryPoints: [join(root, "src", "cloud", "server.ts")],
  outfile: join(dist, "cloud-server.mjs"), bundle: true, platform: "node", format: "esm",
  target: "node22", sourcemap: true, legalComments: "linked",
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

stage("settings UI from source");
const ui = await build({
  entryPoints: [join(root, "ui", "app.ts")],
  bundle: true, platform: "browser", format: "iife", target: "es2022",
  minify: true, write: false, legalComments: "inline",
});
const template = await readFile(join(root, "ui", "settings.template.html"), "utf8");
if (template.split("__QQ_MAIL_APP_BUNDLE__").length !== 2) throw Error("Missing or duplicate UI bundle marker");
// A callback inserts the bundle literally: minified JS may contain $&, $` or $'.
const html = template.replace("__QQ_MAIL_APP_BUNDLE__", () => ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script"));
await writeFile(join(dist, "ui", "settings.html"), html);
// UI tests use the same generated file as the packaged application.
await writeFile(join(root, "ui", "settings.html"), html);
stage("done");
