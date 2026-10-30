import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// 黄金路径：真实后端上从建数据集走到导出（见 e2e/README.md「黄金路径」）。
// 默认的 playwright.config.ts 只跑模拟接口的用例，不会匹配到这里的 *.golden.ts。

const configuredExecutable = process.env.LDOS_CHROMIUM_PATH;
const localChromium = process.platform === "linux" && existsSync("/usr/bin/chromium")
  ? "/usr/bin/chromium"
  : undefined;
const executablePath = configuredExecutable || localChromium;

export default defineConfig({
  testDir: "./e2e/golden",
  testMatch: /\.golden\.ts$/,
  outputDir: "./test-results/golden",
  globalSetup: "./e2e/golden/setup.ts",
  // 一条用例走完整条流水线，状态都在同一个后端里：不并行、不重试。
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { outputFolder: "playwright-report/golden", open: "never" }]],
  // 去重和打标是真的子进程（worker 启动要导入 OpenCV / NumPy），等待放宽。
  expect: { timeout: 20_000 },
  timeout: 240_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:1420",
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    contextOptions: { reducedMotion: "reduce" },
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: "npx vite dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
