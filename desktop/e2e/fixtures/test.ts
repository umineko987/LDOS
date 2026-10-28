import { readFileSync } from "node:fs";
import { expect, test as base } from "@playwright/test";

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
  runtimeErrors: string[];
  cspViolations: void;
};

export const test = base.extend<Fixtures>({
  allowConsoleErrors: [false, { option: true }],

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
      // tauri.conf.json 的 CSP 里有 `http://[::1]:*`，CSP 语法不接受 IPv6 字面量，Chromium 会提示并忽略它。
      if (/Content Security Policy directive '[a-z-]+' contains an invalid source: 'http:\/\/\[::1\]:\*'/.test(message.text())) return;
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
