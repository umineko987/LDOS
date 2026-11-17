import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const configuredExecutable = process.env.LDOS_CHROMIUM_PATH;
const localChromium = process.platform === "linux" && existsSync("/usr/bin/chromium")
  ? "/usr/bin/chromium"
  : undefined;
const executablePath = configuredExecutable || localChromium;

// 和 mygo.json 的 devUrl 同一个主机名：devCsp 只放行 ws://localhost:1420 的 HMR 连接。
const DEV_URL = "http://localhost:1420";
const DIST_URL = "http://localhost:1421";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  expect: { timeout: 5_000 },
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    contextOptions: { reducedMotion: "reduce" },
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    // 开发服务器：每个文档响应都补上 devCsp（见 fixtures/test.ts）。
    { name: "dev", testIgnore: /\.dist\.spec\.ts$/, use: { baseURL: DEV_URL } },
    // 构建产物：serve-dist 带生产 CSP 头。
    { name: "dist", testMatch: /\.dist\.spec\.ts$/, use: { baseURL: DIST_URL } },
  ],
  webServer: [
    {
      command: "npm run dev:web",
      url: DEV_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "npm run build:web && node scripts/serve-dist.mjs 1421",
      url: DIST_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
