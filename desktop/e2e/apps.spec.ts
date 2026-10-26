import type { Route } from "@playwright/test";
import { appPage, configureExistingDedup } from "./fixtures/app-state";

import {
  bootDesktop,
  expect,
  launchApp,
  test,
} from "./fixtures/test";

async function openCurrentGalleryDirectoryExport(
  page: Parameters<typeof bootDesktop>[0],
) {
  await launchApp(page, "gallery");
  const gallery = appPage(page, "gallery");
  await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
  await gallery.getByRole("button", { name: "导出目录…" }).click();
  const directoryExport = gallery.getByRole("dialog", { name: "导出完整目录" });
  await expect(directoryExport).toBeVisible();
  await expect(directoryExport).toBeFocused();
  await directoryExport.getByLabel("目标路径").fill("/tmp/ldos-e2e-output");
  return directoryExport;
}

test.describe("可用应用关键旅程", () => {
  test("图片采集：自动补全、搜索、选择和创建批次", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "crawl");
    const window = appPage(page, "crawl");
    const keyword = window.locator("[data-crawl-keyword]");
    await keyword.fill("fixture");
    await expect(window.getByRole("option", { name: /Fixture Artist/ })).toBeVisible();
    await window.getByRole("option", { name: /Fixture Artist/ }).click();
    await window.getByRole("button", { name: "搜索来源" }).click();

    const candidate = window.locator("[data-crawl-candidate]").filter({ hasText: "Fixture Artist" });
    await expect(candidate).toBeVisible();
    await candidate.getByRole("checkbox", { name: "选择 Fixture Artist" }).check();
    await expect(window.getByText("1 个地址", { exact: true })).toBeVisible();
    const advanced = window.locator(".crawl-batch-settings");
    await expect(advanced).not.toHaveAttribute("open");
    await advanced.locator("summary").click();
    await expect(advanced.getByLabel("单地址并发")).toHaveValue("20");
    await expect(advanced.getByLabel("最多任务数")).toHaveValue("10000");
    await advanced.getByLabel("单地址并发").fill("8");
    await advanced.getByLabel("最多任务数").fill("250");
    await advanced.getByLabel("下载代理").selectOption("direct");
    await advanced.getByRole("textbox", { name: /输出目录/ }).fill("/tmp/ldos-e2e-crawl");
    await window.getByRole("button", { name: "创建批次" }).click();

    await expect(appPage(page, "tasks")).toBeVisible();
    expect(api.count("GET", "/api/v1/search/autocomplete")).toBeGreaterThan(0);
    expect(api.count("POST", "/api/v1/search")).toBe(1);
    expect(api.count("POST", "/api/v1/crawls")).toBe(1);
    const create = api.requests.find(
      (request) => request.method === "POST" && request.path === "/api/v1/crawls?view=desktop",
    );
    expect(create?.body).toMatchObject({ concurrency: 8, max_tasks: 250, proxy_mode: "direct", output_dir: "/tmp/ldos-e2e-crawl" });
    expect(api.unhandled).toEqual([]);
  });

  test("批次管理：选择权威批次、分页并确认取消", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "tasks");
    const window = appPage(page, "tasks");
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
    const readsBeforeConfirmation = api.count("GET", "/api/v1/crawls/batch-running");
    await expect.poll(
      () => api.count("GET", "/api/v1/crawls/batch-running"),
      { timeout: 4_000 },
    ).toBeGreaterThan(readsBeforeConfirmation);
    await expect(confirmation).toBeVisible();
    let failedTaskPageReads = 0;
    const taskPagePattern = /\/api\/v1\/crawls\/batch-running\/tasks(?:\?|$)/;
    const failTaskPage = (route: Route) => {
      failedTaskPageReads += 1;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "injected_task_page_failure", message: "任务页暂时不可用" },
        }),
      });
    };
    await page.route(taskPagePattern, failTaskPage);
    await expect.poll(() => failedTaskPageReads, { timeout: 4_000 }).toBeGreaterThan(0);
    await expect(confirmation).toBeVisible();
    await page.unroute(taskPagePattern, failTaskPage);
    await confirmation.locator("button.tasks-danger").click();
    await expect.poll(() => api.count("POST", "/api/v1/crawls/batch-running/cancel")).toBe(1);
    await expect(window.getByText(/取消请求已接受/).first()).toBeVisible();
    expect(api.unhandled).toEqual([]);
  });

  test("代理管理：运行池操作、保存来源与危险操作取消", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "proxy");
    const window = appPage(page, "proxy");
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
    const window = appPage(page, "vault");
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
    const window = appPage(page, "policy");
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

  test("去重模型设置折叠后仍可展开并刷新真实状态", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "review");
    const models = appPage(page, "review").locator(".review-model-setup");
    await expect(models).toHaveAttribute("data-phase", "ready");
    await expect(models).not.toHaveAttribute("open");
    const refresh = models.getByRole("button", { name: "刷新状态" });
    await expect(refresh).toBeHidden();
    await models.locator("summary").click();
    await expect(refresh).toBeVisible();
    const reads = api.count("GET", "/api/v1/setup/models");
    await refresh.click();
    await expect.poll(() => api.count("GET", "/api/v1/setup/models")).toBe(reads + 1);
    expect(api.count("POST", "/api/v1/setup/models")).toBe(0);
    expect(api.unhandled).toEqual([]);
  });

  test("图库去重：跨目录选区、独立任务切换和返回刷新", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "review");
    const review = appPage(page, "review");
    await expect(review.getByRole("heading", { name: "尚无去重任务" })).toBeVisible();
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
    const dedupButton = gallery.locator("[data-gallery-dedup]");
    await gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg" }).check();
    await dedupButton.click();
    await configureExistingDedup(gallery.locator("[data-gallery-review-confirmation]"));
    await gallery.locator("[data-gallery-review-confirmation]").getByRole("button", { name: "开始处理" }).click();
    await expect(page).toHaveURL(/#\/review$/);
    await expect(review.locator('[data-review-engine-card="gal-asset-02"]')).toBeVisible();
    await review.locator('[data-review-engine-card="gal-asset-02"]').click();
    await expect(review.locator('[data-review-dirty="true"]')).toBeVisible();
    await launchApp(page, "gallery");
    await gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg" }).uncheck();
    await gallery.getByRole("checkbox", { name: "选择目录 subdir" }).check();
    await gallery.locator("button.gallery-folder").filter({ hasText: "subdir" }).click();
    await expect(gallery.locator('[data-gallery-asset="gal-asset-05"]')).toBeVisible();
    await gallery.getByRole("checkbox", { name: "选择图片 image-05.jpg" }).check();
    await dedupButton.click();
    const confirmation = gallery.locator("[data-gallery-review-confirmation]");
    await confirmation.getByText("查看选区详情", { exact: true }).click();
    await expect(confirmation).toContainText("E2E 导入目录 / subdir");
    await expect(confirmation).toContainText("勾选的 1 张图片");
    await expect(confirmation).toContainText("同名 TXT");
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dedupButton).toBeFocused();
    await dedupButton.click();
    await configureExistingDedup(confirmation);
    await confirmation.getByRole("button", { name: "开始处理" }).click();
    await expect(page).toHaveURL(/#\/review$/);
    await expect(review.locator("[data-review-pending]")).toBeVisible();
    await expect(review.locator('[data-review-engine-card="gal-asset-02"]')).toHaveAttribute("data-selected", "false");
    expect(api.requests.filter(({ method, path }) => method === "POST" && path === "/api/v1/gallery/reviews").at(-1)?.body).toEqual({ directory_ids: ["gal-dir-sub"], asset_ids: ["gal-asset-05"], filter_config: { preset_name: "画风", options: { basic_dedup: true, filter_monochrome: false, filter_sketch: false, filter_character: false, similarity_groups: true, reference_asset_ids: [] } } });
    await review.getByRole("button", { name: "结束当前任务并切换", exact: true }).click();
    await expect(review.locator("[data-review-pending]")).toBeHidden();
    await expect.poll(() => api.count("POST", "/api/v1/gallery/reviews/review-created-1/finish")).toBe(1);
    await expect(review.locator('[data-review-directories]')).toContainText("E2E 导入目录 / subdir");
    await expect(review.locator('[data-review-engine-card="gal-asset-02"]')).toHaveAttribute("data-selected", "true");
    const reads = api.count("GET", "/api/v1/gallery/directories/gal-dir-sub/entries");
    await launchApp(page, "gallery");
    await expect.poll(() => api.count("GET", "/api/v1/gallery/directories/gal-dir-sub/entries")).toBeGreaterThan(reads);
    await expect(gallery.locator('[data-gallery-asset="gal-asset-05"]')).toBeVisible();
    expect(api.unhandled).toEqual([]);
  });

  test("图库去重：纯图片选区失败提示并可取消重试", async ({ page }) => {
    const api = await bootDesktop(page, { failPaths: ["/api/v1/gallery/reviews"] });
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
    const dedupButton = gallery.locator("[data-gallery-dedup]");
    await gallery.getByRole("checkbox", { name: "选择图片 image-01.jpg" }).check();
    await dedupButton.click();
    const confirmation = gallery.locator("[data-gallery-review-confirmation]");
    await configureExistingDedup(confirmation);
    await confirmation.getByRole("button", { name: "开始处理" }).click();
    await expect(confirmation.getByRole("alert")).toContainText("fixture_failure");
    await expect(confirmation).toContainText("勾选的 1 张图片");
    await expect(confirmation.getByRole("button", { name: "开始处理" })).toBeEnabled();
    await expect(page).toHaveURL(/#\/gallery$/);
    expect(api.count("POST", "/api/v1/gallery/reviews")).toBe(1);
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(gallery.locator("[data-gallery-dedup]")).toBeFocused();
  });
  test("去重审核：加载、比较、逐组采纳并完成一次性任务", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "gallery");
    const galleryHome = appPage(page, "gallery");
    await galleryHome.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
    await galleryHome.getByRole("checkbox", { name: "选择图片 image-01.jpg" }).check();
    await galleryHome.locator("[data-gallery-dedup]").click();
    await configureExistingDedup(galleryHome.locator("[data-gallery-review-confirmation]"));
    await galleryHome.locator("[data-gallery-review-confirmation]").getByRole("button", { name: "开始处理" }).click();
    await expect(page).toHaveURL(/#\/review$/);
    const window = appPage(page, "review");
    await expect(window.getByRole("heading", { name: /组 1/ })).toBeVisible();
    await expect(window.locator("[data-review-engine-image]").first()).toHaveAttribute("data-review-engine-decoded", "true");
    const deck = window.locator("[data-review-deck]");
    await expect(deck).toBeVisible();
    expect(await deck.evaluate((element) => {
      const host = element.closest(".review-engine-host");
      const statusbar = element.querySelector(".review-deck-statusbar");
      return Boolean(host && statusbar && statusbar.getBoundingClientRect().bottom <= host.getBoundingClientRect().bottom + 1);
    })).toBe(true);
    const firstCard = window.locator('[data-review-engine-card="gal-asset-01"]');
    const secondCard = window.locator('[data-review-engine-card="gal-asset-02"]');
    await expect(firstCard).toHaveAttribute("data-active", "true");
    await window.getByRole("button", { name: "刷新", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(secondCard).toHaveAttribute("data-active", "true");
    await expect(secondCard).toBeFocused();
    await page.keyboard.press("Space");
    await expect(secondCard).toHaveAttribute("data-selected", "false");

    const previews = window.locator("[data-review-engine-image]");
    const secondPreview = previews.nth(1);
    const before = await previews.evaluateAll((elements) => elements.map((element) => element.getAttribute("style") ?? ""));
    const box = await secondPreview.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, -240);
    await expect.poll(async () => {
      const after = await previews.evaluateAll((elements) => elements.map((element) => element.getAttribute("style") ?? ""));
      return after[0] !== before[0] && after[1] !== before[1];
    }).toBe(true);
    // 放大后拖拽平移；随后双击复位——适配状态下拖不动（边缘约束）。
    await page.mouse.down();
    await page.mouse.move(box!.x - 40, box!.y - 30, { steps: 4 });
    await page.mouse.up();
    await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect.poll(() => previews.evaluateAll((elements) => elements.map((element) => element.getAttribute("style") ?? ""))).toEqual(before);
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x - 80, box!.y - 60, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => previews.evaluateAll((elements) => elements.map((element) => element.getAttribute("style") ?? ""))).toEqual(before);

    await page.keyboard.press("Enter");
    await expect(window.getByRole("heading", { name: /组 2/ })).toBeVisible();
    await expect.poll(() => api.count("POST", "/api/v1/gallery/reviews/review-created-1/groups/group-1/adopt")).toBe(1);
    await page.keyboard.press("Escape");
    await expect(window.getByRole("heading", { name: /组 1/ })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    const secondCardAgain = window.locator('[data-review-engine-card="gal-asset-02"]');
    await expect(secondCardAgain).toBeFocused();
    await expect(secondCardAgain).toHaveAttribute("data-selected", "false");
    await page.keyboard.press("Space");
    await expect(secondCardAgain).toHaveAttribute("data-selected", "true");
    await page.keyboard.press("Enter");
    await expect(window.getByRole("heading", { name: /组 2/ })).toBeVisible();
    await expect.poll(() => api.count("POST", "/api/v1/gallery/reviews/review-created-1/groups/group-1/adopt")).toBe(2);
    await page.keyboard.press("ArrowRight");
    const fourthCard = window.locator('[data-review-engine-card="gal-asset-04"]');
    await expect(fourthCard).toBeFocused();
    await page.keyboard.press("Space");
    await expect(fourthCard).toHaveAttribute("data-selected", "false");
    await page.keyboard.press("Enter");
    await expect.poll(() => api.count("POST", "/api/v1/gallery/reviews/review-created-1/groups/group-2/adopt")).toBe(1);

    await window.getByRole("button", { name: "完成", exact: true }).click();
    await expect.poll(() => api.count("POST", "/api/v1/gallery/reviews/review-created-1/finish")).toBe(1);
    await expect(window.getByRole("heading", { name: "尚无去重任务" })).toBeVisible();
    expect(api.unhandled).toEqual([]);
  });

  test("系统诊断：汇总四类事实、复制摘要并跳转恢复工具", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:1420" });
    const api = await bootDesktop(page);
    await launchApp(page, "diagnostics");
    const window = appPage(page, "diagnostics");
    await expect(window.getByRole("heading", { name: "安全配置", exact: true })).toBeVisible();
    await expect(window.getByText("3 / 20")).toBeVisible();

    await window.getByRole("button", { name: "复制诊断摘要" }).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("LDOS");
    expect(clipboard).not.toContain("password");

    await window.getByRole("button", { name: "打开批次管理" }).click();
    await expect(appPage(page, "tasks")).toBeVisible();
    expect(api.unhandled).toEqual([]);
  });

  test("外观设置与图库目录导出保持确定状态且无伪能力", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "personalization");
    const personalization = appPage(page, "personalization");
    const scene = personalization.locator("[data-personalization-scene]:not([data-personalization-selected=\"true\"])").first();
    const sceneId = await scene.getAttribute("data-personalization-scene");
    await scene.click();
    await expect(page.locator("[data-desktop]")).toHaveAttribute("data-scene", sceneId ?? "");
    await personalization.getByRole("button", { name: "应用", exact: true }).click();
    await expect(personalization.locator("[data-personalization-status=\"success\"]")).toBeVisible();

    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    await expect(gallery.locator("[data-gallery-app]")).toHaveAttribute("data-preview-availability", "live");
    await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
    await expect(gallery.locator("[data-gallery-asset=\"gal-asset-01\"]")).toBeVisible();
    // 虚拟网格在 ResizeObserver 首次回调前只渲染首行；toHaveCount 自动重试等待窗口稳定。
    await expect(gallery.locator("[data-gallery-asset]")).toHaveCount(4);
    const assetIds = await gallery.locator("[data-gallery-asset]").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.galleryAsset));
    expect(assetIds).toEqual(["gal-asset-01", "gal-asset-02", "gal-asset-03", "gal-asset-04"]);
    // 目录树导航：进入 subdir 后只显示其直属图片。
    await gallery.getByRole("button", { name: "subdir" }).click();
    await expect(gallery.locator("[data-gallery-asset=\"gal-asset-05\"]")).toBeVisible();
    await expect(gallery.locator("[data-gallery-asset]")).toHaveCount(2);
    // 搜索限定当前目录（§2.5）。
    await gallery.getByRole("searchbox", { name: "搜索当前范围" }).fill("image-05");
    await gallery.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(gallery.locator("[data-gallery-asset]")).toHaveCount(1);
    await gallery.getByRole("button", { name: "清除", exact: true }).click();

    // 沉浸式查看器：双击打开，TXT 面板显示后端标注原文。
    await gallery.locator("[data-gallery-asset=\"gal-asset-05\"]").dblclick();
    await expect(gallery.getByRole("dialog", { name: /查看 image-05\.jpg/ })).toBeVisible();
    await expect(gallery.locator(".gallery-viewer__raw")).toContainText("alpha, beta, alpha");
    await page.keyboard.press("Escape");
    await expect(gallery.getByRole("dialog", { name: /查看 image-05\.jpg/ })).toBeHidden();

    await gallery.getByRole("button", { name: "导出目录…" }).click();
    const directoryExport = gallery.getByRole("dialog", { name: "导出完整目录" });
    await expect(directoryExport).toBeVisible();
    await expect(directoryExport).toBeFocused();
    await expect(directoryExport.getByText("subdir", { exact: true }).first()).toBeVisible();
    await directoryExport.getByRole("button", { name: "添加目录…" }).click();
    await directoryExport.getByRole("button", { name: /E2E 导入目录/ }).first().click();
    await directoryExport.getByRole("button", { name: "添加此完整目录" }).click();
    await directoryExport.getByRole("button", { name: "返回导出设置" }).click();
    await expect(directoryExport.locator(".gallery-export-selection-list li")).toHaveCount(2);
    await directoryExport.getByLabel("目标路径").fill("/tmp/ldos-e2e-output");
    await directoryExport.getByRole("button", { name: "开始复制" }).click();
    await expect(directoryExport.getByText("正在复制")).toBeVisible();
    await expect(directoryExport.getByText("复制完成")).toBeVisible();
    const request = api.requests.find(
      (entry) => entry.method === "POST" && entry.path === "/api/v1/gallery/directory-exports",
    );
    expect(request?.body).toEqual({
      directory_ids: ["gal-dir-sub", "gal-dir-root"],
      target_path: "/tmp/ldos-e2e-output",
    });
    expect(api.count("GET", "/api/v1/gallery/directory-exports/gallery-export-op-01")).toBeGreaterThan(0);
    expect(api.unhandled).toEqual([]);
  });
  test("图库为图片和目录提供显式多选控件", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();

    await expect(gallery.getByRole("checkbox", { name: "选择目录 E2E 导入目录" })).toHaveCount(0);
    const selectAll = gallery.getByRole("checkbox", { name: "全选" });
    await expect(selectAll).toBeVisible();
    const folderCheckbox = gallery.locator(".gallery-folder-shell").getByRole("checkbox", { name: "选择目录 subdir" });
    await expect(folderCheckbox).toBeVisible();
    const imageCheckboxes = gallery.getByRole("checkbox", { name: /选择图片/ });
    await expect(imageCheckboxes).toHaveCount(4);
    await selectAll.check();
    await expect(imageCheckboxes.nth(0)).toBeChecked();
    await expect(imageCheckboxes.nth(3)).toBeChecked();
    await expect(folderCheckbox).toBeChecked();
    await selectAll.uncheck();
    await expect(folderCheckbox).not.toBeChecked();

    await folderCheckbox.check();
    const deleteButton = gallery.getByRole("button", { name: "删除…" });
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeEnabled();
    await folderCheckbox.uncheck();
    await imageCheckboxes.nth(0).check();
    await imageCheckboxes.nth(1).check();
    const selectionSummary = gallery.locator("[data-gallery-selection-summary]");
    await expect(selectionSummary).toContainText("2 张图片");
    await folderCheckbox.check();
    await expect(selectionSummary).toContainText("1 个目录");

    await gallery.getByRole("button", { name: "导出目录…" }).click();
    const directoryExport = gallery.getByRole("dialog", { name: "导出完整目录" });
    await expect(directoryExport.locator(".gallery-export-selection-list li")).toHaveCount(1);
    await expect(directoryExport.locator(".gallery-export-selection-list")).toContainText("subdir");
    await directoryExport.getByRole("button", { name: "关闭" }).click();
    await expect(directoryExport).toBeHidden();
    await gallery.getByRole("radio", { name: "列表" }).click();
    await expect(gallery.getByRole("checkbox", { name: /选择图片/ })).toHaveCount(4);
    await gallery.getByRole("radio", { name: "网格" }).click();
    await gallery.getByRole("button", { name: "清除选择" }).click();
    await expect(selectionSummary).toBeHidden();
    expect(api.unhandled).toEqual([]);
  });
  test("图库批次卡片可警告并递归删除整个批次", async ({ page }) => {
    const api = await bootDesktop(page, { galleryScenario: "batch_delete" });
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    const batchCard = gallery.locator(".gallery-source-card--deletable");
    await expect(batchCard).toHaveCount(1);
    const deleteButton = batchCard.getByRole("button", { name: "删除批次 E2E 下载批次" });

    page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("删除批次会递归删除批次下所有文件");
      await dialog.dismiss();
    });
    await deleteButton.click();
    expect(api.count("DELETE", "/api/v1/gallery/sources/gal-src-batch?delete_files=true")).toBe(0);

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("删除批次会递归删除批次下所有文件");
      await dialog.accept();
    });
    await deleteButton.click();
    await expect(gallery.getByText("暂无图库来源")).toBeVisible();
    expect(api.count("DELETE", "/api/v1/gallery/sources/gal-src-batch?delete_files=true")).toBe(1);
    expect(api.unhandled).toEqual([]);
  });

  test("图库导入目录卡片可解除挂载但不删除原文件", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    const sourceCard = gallery.locator(".gallery-source-card--deletable");
    await expect(sourceCard).toHaveCount(1);
    const removeButton = sourceCard.getByRole("button", { name: "解除挂载 E2E 导入目录" });
    await expect(removeButton).toBeVisible();

    page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("不会删除原目录中的任何文件");
      await dialog.dismiss();
    });
    await removeButton.click();
    expect(api.count("DELETE", "/api/v1/gallery/sources/gal-src-import")).toBe(0);

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("不会删除原目录中的任何文件");
      await dialog.accept();
    });
    await removeButton.click();
    await expect(gallery.getByText("暂无图库来源")).toBeVisible();
    expect(api.count("DELETE", "/api/v1/gallery/sources/gal-src-import")).toBe(1);
    expect(api.unhandled).toEqual([]);
  });


  test("图库目录删除提交完整目录选择并保留回收撤销入口", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();

    await gallery.getByRole("checkbox", { name: "选择目录 subdir" }).check();
    await gallery.getByRole("button", { name: "删除…" }).click();
    const confirm = gallery.getByRole("alertdialog", { name: "移入回收区" });
    await expect(confirm).toContainText("1 个完整目录");
    await confirm.getByRole("button", { name: "移入回收区" }).click();
    await expect(confirm).toBeHidden();

    const request = api.requests.find(
      (entry) => entry.method === "POST" && entry.path === "/api/v1/gallery/file-operations/trash",
    );
    expect(request?.body).toEqual({ asset_ids: [], directory_ids: ["gal-dir-sub"] });
    await expect(gallery.getByRole("button", { name: "subdir" })).toHaveCount(0);
    expect(api.unhandled).toEqual([]);
  });

  test("图库切换目录后单张图片删除不会带入残留目录选择", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();

    await gallery.getByRole("checkbox", { name: "选择目录 subdir" }).check();
    await gallery.getByRole("button", { name: "subdir" }).click();
    const imageCheckbox = gallery.getByRole("checkbox", { name: "选择图片 image-05.jpg" });
    await expect(imageCheckbox).toBeVisible();
    await imageCheckbox.check();

    const selectionSummary = gallery.locator("[data-gallery-selection-summary]");
    await expect(selectionSummary).toContainText("1 张图片");
    // Folder selection persists for dedup/export, never for deletion outside the current view.
    await expect(selectionSummary).toContainText("1 个目录");
    await gallery.getByRole("button", { name: "删除…" }).click();
    const confirm = gallery.getByRole("alertdialog", { name: "移入回收区" });
    await expect(confirm).toContainText("0 个完整目录");
    await expect(confirm).toContainText("1 张图片");
    await confirm.getByRole("button", { name: "移入回收区" }).click();
    await expect(confirm).toBeHidden();

    const request = api.requests.find(
      (entry) => entry.method === "POST" && entry.path === "/api/v1/gallery/file-operations/trash",
    );
    expect(request?.body).toEqual({ asset_ids: ["gal-asset-05"], directory_ids: [] });
    expect(api.unhandled).toEqual([]);
  });


  test("图库呈现扫描失败、原目录管理警告与来源生命周期操作", async ({ page }) => {
    const api = await bootDesktop(page, { galleryScenario: "scan_failed" });
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();

    const sourceStatus = gallery.locator(".gallery-source-status");
    await expect(sourceStatus.getByText(/直接管理原目录/)).toBeVisible();
    await expect(sourceStatus.getByRole("alert")).toContainText("scan_failed");
    expect(api.count("POST", "/api/v1/gallery/sources/gal-src-import/scan")).toBeGreaterThan(0);

    await sourceStatus.getByRole("button", { name: "重新扫描" }).click();
    await expect.poll(() => api.count("POST", "/api/v1/gallery/sources/gal-src-import/scan")).toBeGreaterThan(1);
    await expect(sourceStatus.getByRole("button", { name: "重新扫描" })).toBeEnabled();
    await expect(sourceStatus.getByRole("alert")).toContainText("scan_failed");

    await sourceStatus.getByRole("button", { name: "来源设置…" }).click();
    let manager = gallery.getByRole("dialog", { name: /管理“E2E 导入目录”/ });
    await expect(manager.getByLabel("显示名称")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(manager).toBeHidden();
    await expect(sourceStatus.getByRole("button", { name: "来源设置…" })).toBeFocused();
    await sourceStatus.getByRole("button", { name: "来源设置…" }).click();
    manager = gallery.getByRole("dialog", { name: /管理“E2E 导入目录”/ });
    await manager.getByLabel("显示名称").fill("已重命名来源");
    await manager.getByRole("button", { name: "保存名称" }).click();
    await expect(gallery.locator(".gallery-source").filter({ hasText: "已重命名来源" })).toBeVisible();
    expect(api.count("PATCH", "/api/v1/gallery/sources/gal-src-import")).toBe(1);

    await gallery.locator(".gallery-source-status").getByRole("button", { name: "来源设置…" }).click();
    manager = gallery.getByRole("dialog", { name: /管理“已重命名来源”/ });
    await manager.getByRole("button", { name: "解除挂载（保留原文件）" }).click();
    await expect(gallery.getByText("暂无图库来源")).toBeVisible();
    expect(api.count("DELETE", "/api/v1/gallery/sources/gal-src-import")).toBe(1);
    expect(api.unhandled).toEqual([]);
  });

  test("图库显示候选保留移除统计并可重试去重对账", async ({ page }) => {
    const api = await bootDesktop(page, { galleryScenario: "reconciliation_failed" });
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
    const sourceStatus = gallery.locator(".gallery-source-status");

    await expect(sourceStatus.getByText("候选")).toBeVisible();
    await expect(sourceStatus.getByText("保留")).toBeVisible();
    await expect(sourceStatus.getByText("已移除")).toBeVisible();
    const alert = sourceStatus.getByRole("alert");
    await expect(alert).toContainText("图库去重对账失败");
    await alert.getByRole("button", { name: "重试对账" }).click();
    await expect(alert).toBeHidden();
    expect(
      api.count(
        "POST",
        "/api/v1/gallery/sources/gal-src-import/reconciliation/retry",
      ),
    ).toBe(1);
    expect(api.unhandled).toEqual([]);
  });

  test("图库跨全库搜索分页完成沉浸查看、标签辅助与显式 TXT 离开决策", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();

    await gallery.getByRole("combobox", { name: "范围", exact: true }).selectOption("library");
    await gallery.getByLabel("搜索当前范围").fill("image");
    await gallery.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(gallery.locator("[data-gallery-asset]")).toHaveCount(2);
    await expect(gallery.getByText(/“image” · 整个图库/)).toBeVisible();
    await expect(gallery.locator("[data-gallery-loaded-stats]")).toContainText("已加载 2 张");

    const opener = gallery.locator('[data-gallery-asset="gal-asset-02"]');
    await opener.dblclick();
    const viewer = gallery.locator(".gallery-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.locator(".gallery-viewer__raw")).toContainText("alpha, beta, alpha");

    await viewer.getByRole("button", { name: "逗号标签", exact: true }).click();
    const tagWarning = viewer.locator(".gallery-viewer__tag-warning");
    await expect(tagWarning).toContainText("空标签 1");
    await expect(tagWarning).toContainText("重复 1");
    await expect(tagWarning).toContainText("含多余空白 4");
    await viewer.getByRole("button", { name: "原文", exact: true }).click();

    await page.keyboard.press("f");
    await expect(viewer).toHaveClass(/gallery-viewer--focus/);
    await page.keyboard.press("f");
    await expect(viewer).not.toHaveClass(/gallery-viewer--focus/);

    const separator = viewer.getByRole("slider", { name: "调整 TXT 面板宽度" });
    const panelWidthBefore = Number(await separator.getAttribute("aria-valuenow"));
    await separator.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => Number(await separator.getAttribute("aria-valuenow"))).toBeGreaterThan(panelWidthBefore);

    const stage = viewer.getByRole("group", { name: /图片画布/ });
    const image = stage.locator("img");
    await stage.dispatchEvent("wheel", { deltaY: -240, clientX: 420, clientY: 320 });
    await expect(viewer.locator(".gallery-viewer__zoom")).not.toHaveText("100%");
    const transformBeforePan = await image.getAttribute("style");
    const stageBox = await stage.boundingBox();
    expect(stageBox).not.toBeNull();
    await page.mouse.move(stageBox!.x + stageBox!.width / 2, stageBox!.y + stageBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(stageBox!.x + stageBox!.width / 2 + 70, stageBox!.y + stageBox!.height / 2 + 35);
    await page.mouse.up();
    await expect.poll(() => image.getAttribute("style")).not.toBe(transformBeforePan);

    await viewer.getByRole("button", { name: /关闭/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(viewer.getByText("image-03.jpg", { exact: true })).toBeVisible();
    await expect(viewer.locator(".gallery-viewer__zoom")).toHaveText("100%");
    expect(
      api.requests.some(
        (entry) =>
          entry.method === "GET" &&
          entry.path.startsWith("/api/v1/gallery/search?") &&
          entry.path.includes("scope=library") &&
          entry.path.includes("asset_cursor=gallery-search-2"),
      ),
    ).toBe(true);

    await viewer.getByRole("button", { name: "编辑原文", exact: true }).click();
    const editor = viewer.getByLabel("TXT 原文编辑器");
    await editor.fill("尚未保存，先取消");
    await viewer.getByRole("button", { name: "下一张", exact: true }).click();
    let pending = viewer.getByRole("alertdialog", { name: "TXT 有未保存更改" });
    await pending.getByRole("button", { name: "取消" }).click();
    await expect(viewer.getByText("image-03.jpg", { exact: true })).toBeVisible();
    await expect(editor).toHaveValue("尚未保存，先取消");

    await viewer.getByRole("button", { name: "下一张", exact: true }).click();
    pending = viewer.getByRole("alertdialog", { name: "TXT 有未保存更改" });
    await pending.getByRole("button", { name: "放弃更改" }).click();
    await expect(viewer.getByText("image-04.jpg", { exact: true })).toBeVisible();

    await viewer.getByRole("button", { name: "编辑原文", exact: true }).click();
    await viewer.getByLabel("TXT 原文编辑器").fill("Ctrl+S 保存原文");
    await page.keyboard.press("Control+s");
    await expect.poll(() => api.count("PUT", "/api/v1/gallery/assets/gal-asset-04/annotation")).toBe(1);
    await expect(viewer.getByText("Ctrl+S 保存原文", { exact: true })).toBeVisible();

    await viewer.getByRole("button", { name: "编辑原文", exact: true }).click();
    await viewer.getByLabel("TXT 原文编辑器").fill("保存并前往下一张");
    await page.keyboard.press("Control+Enter");
    await expect(viewer.getByText("image-05.jpg", { exact: true })).toBeVisible();
    await expect.poll(() => api.count("PUT", "/api/v1/gallery/assets/gal-asset-04/annotation")).toBe(2);

    await viewer.getByRole("button", { name: /关闭/ }).click();
    await expect(viewer).toBeHidden();
    await expect(opener).toBeFocused();
    expect(api.unhandled).toEqual([]);
  });

  test("图库查看器删除自动前进，并支持批量恢复与批量永久删除", async ({ page }) => {
    const api = await bootDesktop(page);
    await launchApp(page, "gallery");
    const gallery = appPage(page, "gallery");
    await gallery.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();

    const trashFirstTwoFromViewer = async () => {
      await gallery.locator('[data-gallery-asset="gal-asset-01"]').dblclick();
      const viewer = gallery.locator(".gallery-viewer");
      await expect(viewer).toBeVisible();
      await viewer.getByRole("button", { name: "移入回收区" }).click();
      await expect(viewer.getByText("image-02.jpg", { exact: true })).toBeVisible();
      await expect(gallery.locator(".gallery-undo-toast")).toContainText("已移入回收区 1 项");
      await viewer.getByRole("button", { name: "移入回收区" }).click();
      await expect(viewer.getByText("image-03.jpg", { exact: true })).toBeVisible();
      await viewer.getByRole("button", { name: /关闭/ }).click();
      await expect(viewer).toBeHidden();
    };

    await trashFirstTwoFromViewer();
    await gallery.getByRole("button", { name: "回收区" }).click();
    let trashPanel = gallery.getByRole("complementary", { name: "图库回收区" });
    await expect(trashPanel.locator(".gallery-trash-item")).toHaveCount(2);
    await expect(trashPanel).toContainText("2 项");
    await trashPanel.getByRole("button", { name: "全选已载入" }).click();
    await trashPanel.getByRole("button", { name: "恢复所选" }).click();
    await expect(trashPanel.getByText("回收区为空。文件将保留至手动恢复或彻底删除。")).toBeVisible();
    expect(api.count("POST", "/api/v1/gallery/trash/gal-trash-1/restore")).toBe(1);
    expect(api.count("POST", "/api/v1/gallery/trash/gal-trash-2/restore")).toBe(1);
    await trashPanel.getByRole("button", { name: "关闭" }).click();
    await expect(gallery.locator('[data-gallery-asset="gal-asset-01"]')).toBeVisible();

    await trashFirstTwoFromViewer();
    await gallery.getByRole("button", { name: "回收区" }).click();
    trashPanel = gallery.getByRole("complementary", { name: "图库回收区" });
    await expect(trashPanel.locator(".gallery-trash-item")).toHaveCount(2);
    await trashPanel.getByRole("button", { name: "全选已载入" }).click();
    await trashPanel.getByRole("button", { name: "永久删除所选…" }).click();
    const purgeConfirm = trashPanel.getByRole("alertdialog", { name: "永久删除无法撤销" });
    await expect(purgeConfirm).toContainText("2 组、2 项");
    await purgeConfirm.getByRole("button", { name: "确认永久删除" }).click();
    await expect(trashPanel.getByText("回收区为空。文件将保留至手动恢复或彻底删除。")).toBeVisible();
    expect(api.count("DELETE", "/api/v1/gallery/trash/gal-trash-3")).toBe(1);
    expect(api.count("DELETE", "/api/v1/gallery/trash/gal-trash-4")).toBe(1);
    expect(api.unhandled).toEqual([]);
  });

  test("图库目录导出在顶层同名冲突时列出名称且不进入复制轮询", async ({ page }) => {
    const api = await bootDesktop(page, { directoryExportScenario: "conflict" });
    const directoryExport = await openCurrentGalleryDirectoryExport(page);
    await directoryExport.getByRole("button", { name: "开始复制" }).click();

    const alert = directoryExport.getByRole("alert");
    await expect(alert).toContainText("target_top_level_conflict");
    await expect(alert).toContainText("subdir");
    expect(api.count("GET", "/api/v1/gallery/directory-exports/gallery-export-op-01")).toBe(0);
    expect(api.unhandled).toEqual([]);
  });

  test("图库目录导出明确呈现部分成功后的失败结果", async ({ page }) => {
    const api = await bootDesktop(page, { directoryExportScenario: "failed" });
    const directoryExport = await openCurrentGalleryDirectoryExport(page);
    await directoryExport.getByRole("button", { name: "开始复制" }).click();

    await expect(directoryExport.getByText("复制失败")).toBeVisible();
    await expect(
      directoryExport.locator(".gallery-export-results li").filter({ hasText: "subdir" }),
    ).toContainText("已完成");
    await expect(
      directoryExport.locator(".gallery-export-results li").filter({ hasText: "E2E 导入目录" }),
    ).toContainText("失败（source_read_failed）");
    expect(api.unhandled).toEqual([]);
  });

  test("图库目录导出可取消正在复制的短生命周期操作", async ({ page }) => {
    const api = await bootDesktop(page, { directoryExportScenario: "copying" });
    const directoryExport = await openCurrentGalleryDirectoryExport(page);
    await directoryExport.getByRole("button", { name: "开始复制" }).click();
    await directoryExport.getByRole("button", { name: "取消复制" }).click();

    await expect(directoryExport.getByText("复制已取消")).toBeVisible();
    expect(
      api.count(
        "DELETE",
        "/api/v1/gallery/directory-exports/gallery-export-op-01",
      ),
    ).toBe(1);
    expect(api.unhandled).toEqual([]);
  });
});

test.describe("空数据与服务失败", () => {
  test("空最近批次不会伪造内容，并给出可操作空状态", async ({ page }) => {
    await bootDesktop(page, { emptyRecent: true });
    await launchApp(page, "tasks");
    const window = appPage(page, "tasks");
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
      const window = appPage(page, scenario.appId);
      const alert = window.getByRole("alert").first();
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(scenario.alert);
      expect(api.unhandled).toEqual([]);
    });
  }
});
