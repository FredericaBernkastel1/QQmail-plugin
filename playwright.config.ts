import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const controlled = process.env.QQMAIL_APPCONTAINER_TEST === "1";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.ui.spec.ts",
  workers: 1,
  use: {
    headless: true,
    browserName: controlled ? "firefox" : "chromium",
    ...(controlled ? {} : { channel: "msedge" }),
    launchOptions: {
      ...(controlled ? { env: { ...process.env,
        MOZ_DISABLE_CONTENT_SANDBOX: "1", MOZ_DISABLE_GPU_SANDBOX: "1",
        MOZ_DISABLE_RDD_SANDBOX: "1", MOZ_DISABLE_GMP_SANDBOX: "1",
      } } : {}),
      ...(controlled ? { executablePath: resolve(import.meta.dirname, "../test-browser/firefox/firefox.exe") }
        : process.env.QQMAIL_TEST_BROWSER ? { executablePath: process.env.QQMAIL_TEST_BROWSER } : {}),
    },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
});
