import type { Page } from "@playwright/test";

import { errorEnvelope, HEALTHY, mockApi } from "./fixtures/api";
import { expect, test } from "./fixtures/test";

declare global {
  interface Window {
    __bootState?: { state: string; code?: string };
    __invoked?: string[];
  }
}

/** 模拟 MyGo 宿主：运行真实生成绑定，mygo.call 按 Host 方法名返回可变启动状态。 */
async function fakeMyGoHost(page: Page) {
  await page.addInitScript(() => {
    window.__bootState = { state: "starting" };
    window.__invoked = [];
    Object.assign(window, {
      mygo: {
        call: async (method: string) => {
          window.__invoked?.push(method);
          if (method === "Host.BackendStatus") return window.__bootState;
          if (method === "Host.RuntimeMetadata") {
            return { apiOrigin: location.origin, backendVersion: "0.5.2", configPath: "/private/config.json" };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    });
  });
}

const setBackend = (page: Page, state: { state: string; code?: string }) =>
  page.evaluate((next) => {
    window.__bootState = next;
  }, state);

test("宿主报告启动中时显示启动门，就绪且 /healthz 通过后进入外壳", async ({ page }) => {
  await fakeMyGoHost(page);
  await page.goto("/");

  const gate = page.getByTestId("boot-screen");
  await expect(gate).toHaveAttribute("data-boot-phase", "starting");
  await expect(gate.getByRole("heading")).toHaveText("正在准备工作台");
  await expect(gate.getByRole("status")).toHaveText("正在启动本地服务");

  await setBackend(page, { state: "ready" });
  await expect(page.locator("[data-shell]")).toBeVisible();
  await expect(gate).toHaveCount(0);
  expect(await page.evaluate(() => window.__invoked)).toContain("Host.RuntimeMetadata");
});

test("后端启动失败时显示宿主给的原因，恢复后自动进入", async ({ page }) => {
  await fakeMyGoHost(page);
  await page.goto("/");
  await setBackend(page, { state: "failed", code: "backend_start_timeout" });

  const gate = page.getByTestId("boot-screen");
  await expect(gate).toHaveAttribute("data-boot-phase", "failed");
  await expect(gate.getByRole("heading")).toHaveText("本地服务暂时不可用");
  await expect(gate.getByRole("status")).toHaveText("等待后端启动超时");

  await setBackend(page, { state: "ready" });
  await expect(page.locator("[data-shell]")).toBeVisible();
});

test("健康检查失败时显示错误，按退避自动重试，也可以手动重试", async ({ page }) => {
  let healthy = false;
  let attempts = 0;
  await mockApi(page, "get", "/healthz", () => {
    attempts += 1;
    return healthy ? { body: HEALTHY } : { status: 500, body: errorEnvelope("database_unavailable", "数据库暂时不可用") };
  });
  await page.goto("/");

  const gate = page.getByTestId("boot-screen");
  await expect(gate).toHaveAttribute("data-boot-phase", "failed");
  await expect(gate.getByRole("status")).toHaveText("数据库暂时不可用");

  // 退避 0.5s → 1s → 2s → 4s：第 4 次失败后，下一次自动重试在 4 秒后。
  await expect.poll(() => attempts, { timeout: 8_000 }).toBe(4);
  healthy = true;
  await gate.getByRole("button", { name: "重试" }).click();
  await expect(page.locator("[data-shell]")).toBeVisible({ timeout: 2_000 });
  expect(attempts).toBe(5);
});
