import {
  bootDesktop,
  expect,
  launchApp,
  test,
} from "./fixtures/test";

function appWindow(page: Parameters<typeof bootDesktop>[0], appId: string) {
  return page.locator(`[data-app-window][data-app-id="${appId}"]`);
}

test.describe("可用应用关键旅程", () => {
  test("图片采集：自动补全、搜索、选择和创建批次", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "crawl");
    const window = appWindow(page, "crawl");
    const keyword = window.locator("[data-crawl-keyword]");
    await keyword.fill("fixture");
    await expect(window.getByRole("option", { name: /Fixture Artist/ })).toBeVisible();
    await window.getByRole("option", { name: /Fixture Artist/ }).click();
    await window.getByRole("button", { name: "搜索来源" }).click();

    const candidate = window.locator("[data-crawl-candidate]").filter({ hasText: "Fixture Artist" });
    await expect(candidate).toBeVisible();
    await candidate.getByRole("checkbox", { name: "选择 Fixture Artist" }).check();
    await expect(window.getByText("1 个地址", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "创建批次" }).click();

    await expect(appWindow(page, "tasks")).toBeVisible();
    expect(api.count("GET", "/api/v1/search/autocomplete")).toBeGreaterThan(0);
    expect(api.count("POST", "/api/v1/search")).toBe(1);
    expect(api.count("POST", "/api/v1/crawls")).toBe(1);
    const create = api.requests.find((request) => request.method === "POST" && request.path === "/api/v1/crawls");
    expect(create?.body).toMatchObject({ concurrency: 20, max_tasks: 10000 });
    expect(api.unhandled).toEqual([]);
  });

  test("批次管理：选择权威批次、分页并确认取消", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "tasks");
    const window = appWindow(page, "tasks");
    const recent = window.getByRole("listbox", { name: "最近批次" });
    await expect(recent.locator("option[value=\"batch-running\"]")).toBeAttached();
    await recent.selectOption("batch-running");
    await window.getByRole("button", { name: "查看所选批次" }).click();

    await expect(window.getByRole("heading", { name: "图片任务" })).toBeVisible();
    await expect(window.getByText("授权失效").first()).toBeVisible();
    await window.getByRole("button", { name: "下一页" }).click();
    await expect.poll(() => api.requests.some((request) => request.path.includes("offset=100"))).toBe(true);

    await window.getByRole("button", { name: "取消批次" }).click();
    const confirmation = window.locator("[data-tasks-confirmation=\"cancel\"]");
    await expect(confirmation).toBeVisible();
    await confirmation.locator("button.tasks-danger").click();
    await expect.poll(() => api.count("POST", "/api/v1/crawls/batch-running/cancel")).toBe(1);
    await expect(window.getByText(/取消请求已接受/).first()).toBeVisible();
    expect(api.unhandled).toEqual([]);
  });

  test("代理管理：运行池操作、保存来源与危险操作取消", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "proxy");
    const window = appWindow(page, "proxy");
    await expect(window.getByText("JP fixture")).toBeVisible();

    await window.getByRole("button", { name: "启动代理池" }).click();
    await expect.poll(() => api.count("POST", "/api/v1/proxy/start")).toBe(1);
    await window.getByRole("button", { name: "应用并重新加载" }).click();
    await expect.poll(() => api.count("POST", "/api/v1/proxy/reload")).toBe(1);

    await window.getByLabel("添加完整订阅地址").fill("https://new-provider.example/sub");
    await window.getByRole("button", { name: "保存订阅" }).click();
    await expect.poll(() => api.requests.some((request) => request.method === "POST" && request.path.startsWith("/api/v1/proxy/sources/subscriptions"))).toBe(true);

    await window.getByRole("button", { name: "恢复配置文件默认值" }).click();
    const confirmation = window.locator("[data-proxy-confirmation=\"override-reset\"]");
    await expect(confirmation).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    expect(api.requests.some((request) => request.method === "DELETE" && request.path.startsWith("/api/v1/proxy/sources/override"))).toBe(false);
    expect(api.unhandled).toEqual([]);
  });

  test("授权管理：切换站点、显示敏感输入并保存登录代理", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "vault");
    const window = appWindow(page, "vault");
    await expect(window.getByText("X / Twitter").first()).toBeVisible();

    await window.locator("[data-vault-action=\"site:pixiv\"]").click();
    await expect(window.getByRole("heading", { name: "Pixiv" })).toBeVisible();
    const proxy = window.locator(".vault-secret-input");
    await proxy.fill("https://user:pass@proxy.example:8443");
    await window.getByRole("button", { name: "显示代理输入" }).click();
    await expect(proxy).toHaveAttribute("data-revealed", "true");
    await window.getByRole("button", { name: /保存.*代理/ }).click();

    await expect.poll(() => api.count("PUT", "/api/v1/auth/proxy")).toBe(1);
    const save = api.requests.find((request) => request.method === "PUT" && request.path.startsWith("/api/v1/auth/proxy"));
    expect(save?.body).toEqual({ proxy_url: "https://user:pass@proxy.example:8443" });
    await expect(proxy).toHaveValue("");
    expect(api.unhandled).toEqual([]);
  });

  test("站点设置：阻止无效草稿、保存完整四字段并恢复默认", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "policy");
    const window = appWindow(page, "policy");
    const concurrency = window.locator("[data-policy-field=\"max_concurrency\"]");
    await expect(concurrency).toHaveValue("20");

    await concurrency.fill("129");
    await expect(concurrency).toHaveAttribute("aria-invalid", "true");
    await expect(window.locator("button[type=\"submit\"]")).toBeDisabled();
    expect(api.requests.some((request) => request.method === "PUT" && request.path.startsWith("/api/v1/sites/policies"))).toBe(false);

    await concurrency.fill("16");
    await window.locator("button[type=\"submit\"]").click();
    await expect.poll(() => api.count("PUT", "/api/v1/sites/policies/danbooru")).toBe(1);
    const save = api.requests.find((request) => request.method === "PUT" && request.path.startsWith("/api/v1/sites/policies/danbooru"));
    expect(save?.body).toEqual({ max_concurrency: 16, retry_limit: 2, backoff_base_seconds: 2, proxy_mode: "prefer" });

    await window.locator("[data-policy-site=\"pixiv\"]").click();
    await window.getByRole("button", { name: /恢复.*默认/ }).click();
    const confirmation = window.locator("[data-policy-confirmation=\"reset\"]");
    await confirmation.getByRole("button", { name: "恢复默认设置" }).click();
    await expect.poll(() => api.count("DELETE", "/api/v1/sites/policies/pixiv")).toBe(1);
    expect(api.unhandled).toEqual([]);
  });

  test("去重审核：加载、比较、逐组确认、串行保存并应用", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "review");
    const window = appWindow(page, "review");
    const batches = window.getByRole("combobox", { name: "已结束批次" });
    await expect(batches.locator("option[value=\"batch-review\"]")).toBeAttached();
    await batches.selectOption("batch-review");
    await window.getByRole("button", { name: "打开审核" }).click();

    await expect(window.getByRole("heading", { name: /组 1/ })).toBeVisible();
    await expect(window.locator("[data-review-engine-image]").first()).toHaveAttribute("data-review-engine-decoded", "true");
    await window.locator("[data-review-engine-card=\"image-2\"]").click();
    await window.getByRole("button", { name: "采纳并前进" }).click();
    await expect(window.getByRole("heading", { name: /组 2/ })).toBeVisible();
    await window.locator("[data-review-engine-card=\"image-4\"]").click();
    await window.getByRole("button", { name: "采纳并前进" }).click();

    await expect.poll(() => api.count("PUT", "/api/v1/crawls/batch-review/review/decisions")).toBeGreaterThan(0);
    const apply = window.getByRole("button", { name: "应用并整理文件" });
    await expect(apply).toBeEnabled();
    await apply.click();
    const confirmation = window.locator("[data-review-confirmation=\"apply\"]");
    await confirmation.getByRole("button", { name: "应用并整理文件" }).click();
    await expect.poll(() => api.count("POST", "/api/v1/crawls/batch-review/review/apply")).toBe(1);
    expect(api.unhandled).toEqual([]);
  });

  test("系统诊断：汇总四类事实、复制摘要并跳转恢复工具", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:1420" });
    const api = await bootDesktop(page);
    await launchApp(page, "diagnostics");
    const window = appWindow(page, "diagnostics");
    await expect(window.getByRole("heading", { name: "安全配置", exact: true })).toBeVisible();
    await expect(window.getByText("3 / 20")).toBeVisible();

    await window.getByRole("button", { name: "复制诊断摘要" }).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("ImageWeave");
    expect(clipboard).not.toContain("password");

    await window.getByRole("button", { name: "打开批次管理" }).click();
    await expect(appWindow(page, "tasks")).toBeVisible();
    expect(api.unhandled).toEqual([]);
  });

  test("外观设置及两个 Preview 应用保持确定状态且无伪能力", async ({ page }) => {
    await bootDesktop(page);
    await launchApp(page, "personalization");
    const personalization = appWindow(page, "personalization");
    const scene = personalization.locator("[data-personalization-scene]:not([data-personalization-selected=\"true\"])").first();
    const sceneId = await scene.getAttribute("data-personalization-scene");
    await scene.click();
    await expect(page.locator("[data-desktop]")).toHaveAttribute("data-scene", sceneId ?? "");
    await personalization.getByRole("button", { name: "应用", exact: true }).click();
    await expect(personalization.locator("[data-personalization-status=\"success\"]")).toBeVisible();

    await launchApp(page, "gallery");
    const gallery = appWindow(page, "gallery");
    const galleryNavigation = gallery.getByRole("navigation", { name: "图片库分区" });
    await galleryNavigation.getByRole("button", { name: "收藏", exact: true }).click();
    await expect(galleryNavigation.getByRole("button", { name: "收藏", exact: true })).toHaveAttribute("aria-pressed", "true");
    await gallery.getByLabel("安全搜索预览").fill("fixture");
    await gallery.getByRole("button", { name: "列表" }).click();
    await expect(gallery.getByRole("button", { name: "列表" })).toHaveAttribute("aria-pressed", "true");
    await gallery.getByRole("button", { name: "收起检查器" }).click();
    await expect(gallery.locator("[data-inspector-open=\"false\"]")).toBeVisible();
    await expect(gallery.getByRole("button", { name: "打开 Quick Look" })).toBeDisabled();

    await launchApp(page, "export");
    const exportWindow = appWindow(page, "export");
    await expect(exportWindow.locator("[data-export-app]")).toHaveAttribute("data-preview-availability", "unavailable");
    await expect(exportWindow.getByRole("button", { name: "开始导出" })).toBeDisabled();
    await expect(exportWindow.getByRole("status").filter({ hasText: "数据集导出后端能力尚未接入" })).toBeVisible();
  });
});

test.describe("空数据与服务失败", () => {
  test("空最近批次不会伪造内容，并给出可操作空状态", async ({ page }) => {
    await bootDesktop(page, { emptyRecent: true });
    await launchApp(page, "tasks");
    const window = appWindow(page, "tasks");
    await expect(window.getByRole("option", { name: "当前筛选没有批次" })).toBeAttached();
    await expect(window.getByRole("heading", { name: "尚未选择批次" })).toBeVisible();
    await expect(window.getByRole("button", { name: "查看所选批次" })).toBeDisabled();
  });

  for (const scenario of [
    { appId: "proxy", path: "/api/v1/proxy/", alert: /代理.*失败|服务/ },
    { appId: "vault", path: "/api/v1/auth", alert: /授权.*失败|服务/ },
    { appId: "policy", path: "/api/v1/sites/policies", alert: /设置.*失败|服务/ },
  ] as const) {
    test(`${scenario.appId} 在服务失败时保留明确错误与恢复入口`, async ({ page }) => {
      const api = await bootDesktop(page, { failPaths: [scenario.path] });
      await launchApp(page, scenario.appId);
      const window = appWindow(page, scenario.appId);
      const alert = window.locator("section[role=\"alert\"]").first();
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(scenario.alert);
      expect(api.unhandled).toEqual([]);
    });
  }
});
