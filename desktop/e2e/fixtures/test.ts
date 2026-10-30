import { readFileSync } from "node:fs";
import { expect, test as base } from "@playwright/test";

import { mockHealthyBackend } from "./api";
import { mockQuietRealtime } from "./jobs";

const tauriConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as { app: { security: { csp: string; devCsp: string } } };

/** Tauri 开发窗口的 CSP；开发服务器自己给 HTML 加上它（见 scripts/external-boot.ts）。 */
export const DEV_CSP = tauriConfig.app.security.devCsp;
export const PRODUCTION_CSP = tauriConfig.app.security.csp;

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

type Fixtures = {
  /** 置为 true 时不因 console.error 失败（只给旧版冒烟测试用，它的接口没有全部模拟）。 */
  allowConsoleErrors: boolean;
  /** 默认模拟一个健康的后端（见 api.ts）和安静的实时连接（见 jobs.ts）；测试里再调 mockApi() / mockEvents() 可以覆盖。 */
  healthyBackend: boolean;
  backend: void;
  runtimeErrors: string[];
  cspViolations: void;
};

export const test = base.extend<Fixtures>({
  allowConsoleErrors: [false, { option: true }],
  healthyBackend: [true, { option: true }],

  backend: [async ({ page, healthyBackend }, use) => {
    if (healthyBackend) {
      await mockHealthyBackend(page);
      await mockQuietRealtime(page);
    }
    await use();
  }, { auto: true }],

  cspViolations: [async ({ page }, use) => {
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__cspViolations?.push(`${event.effectiveDirective} ${event.blockedURI || "inline"}`);
      });
    });
    await use();
    const violations = page.isClosed() ? [] : await page.evaluate(() => window.__cspViolations ?? []).catch(() => []);
    expect(violations, "页面不应触发 CSP 拦截").toEqual([]);
  }, { auto: true }],

  runtimeErrors: [async ({ page, allowConsoleErrors }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error" || allowConsoleErrors) return;
      if (message.text().startsWith("Failed to load resource: the server responded with a status of")) return;
      errors.push(`console.error: ${message.text()}`);
    });
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (response.status() >= 400 && /\.(?:css|js|mjs|png|svg|webp|woff2?)$/i.test(pathname)) {
        errors.push(`static resource HTTP ${response.status()}: ${pathname}`);
      }
    });
    await use(errors);
    expect(errors, "页面运行期间不应出现未处理异常、console.error 或静态资源失败").toEqual([]);
  }, { auto: true }],
});

export { expect };
