import type { components } from "../src/lib/api/schema";
import { errorEnvelope, mockApi, READY } from "./fixtures/api";
import { expect, test } from "./fixtures/test";

type ReadinessResponse = components["schemas"]["ReadinessResponse"];

test("诊断页按领域列出 /readyz 组件，并显示运行配置", async ({ page }) => {
  await page.goto("/#/settings/diagnostics");
  const diagnostics = page.getByTestId("diagnostics");

  await expect(diagnostics.getByTestId("diag-overall")).toHaveAttribute("data-status", "warning");
  await expect(diagnostics.getByTestId("diag-overall")).toContainText("必需组件正常，部分可选组件需要留意");

  const database = diagnostics.locator('[data-component="database"]');
  await expect(database).toContainText("SQLite 数据库");
  await expect(database).toContainText("SQLite 可读写");
  await expect(database).toContainText("必需");
  await expect(database).toContainText("正常");
  await expect(diagnostics.locator('[data-component="project_proxy"]')).toHaveAttribute("data-status", "warning");
  await expect(diagnostics.locator('[data-component="dedup"]')).toContainText("已禁用");
  await expect(diagnostics.getByRole("heading", { name: "服务基础" })).toBeVisible();
  await expect(diagnostics.getByRole("heading", { name: "连接与代理" })).toBeVisible();

  await expect(diagnostics.locator('[data-config="loopback"]')).toHaveText("开启");
  await expect(diagnostics.locator('[data-config="scheduler_capacity"]')).toHaveText("4");
  await expect(diagnostics.locator('[data-config="dedup_device"]')).toHaveText("CUDA");
  await expect(diagnostics.getByTestId("diag-mode")).toHaveText("浏览器");
});

test("未就绪时 503 的正文照常显示；刷新按钮重新请求", async ({ page }) => {
  let calls = 0;
  await mockApi(page, "get", "/readyz", () => {
    calls += 1;
    return {
      status: 503,
      body: {
        ready: false,
        time: READY.time,
        components: { database: { status: "error", required: true, summary: "SQLite 不可访问" } },
      } satisfies ReadinessResponse,
    };
  });
  await page.goto("/#/settings/diagnostics");
  const overall = page.getByTestId("diag-overall");
  await expect(overall).toHaveAttribute("data-status", "error");
  await expect(overall).toContainText("有必需组件异常");
  await expect(page.locator('[data-component="database"]')).toContainText("SQLite 不可访问");

  const before = calls;
  await page.getByTestId("diag-refresh").click();
  await expect.poll(() => calls).toBeGreaterThan(before);
});

test("接口失败时显示后端给的原因", async ({ page }) => {
  await mockApi(page, "get", "/readyz", () => ({ status: 403, body: errorEnvelope("forbidden", "诊断接口只允许本机访问") }));
  await page.goto("/#/settings/diagnostics");
  await expect(page.getByTestId("diag-error")).toHaveText("无法读取诊断信息：诊断接口只允许本机访问");
});
