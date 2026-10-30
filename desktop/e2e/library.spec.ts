import type { Page } from "@playwright/test";

import { mockApi } from "./fixtures/api";
import { FakeDatasets } from "./fixtures/datasets";
import { job, sseBody, type SseEvent } from "./fixtures/jobs";
import { FakeLibrary } from "./fixtures/library";
import { expect, test } from "./fixtures/test";

// 图库：来源列表、浏览、查看器和 TXT、回收区、加入数据集。后端由 FakeLibrary / FakeDatasets 在浏览器里模拟。

function grid(page: Page) {
  return page.getByTestId("virtual-grid");
}

test("来源列表 → 打开文件夹 → 查看器里改 TXT，Backspace 回到上一层", async ({ page }) => {
  const library = new FakeLibrary();
  const source = library.addSource({ name: "角色图", tree: { "": 3, a: 5, "a/b": 2 } });
  library.addSource({ name: "旧硬盘", availability: "offline", lastScannedAt: null });
  await library.install(page);
  await page.goto("/#/library");

  const rows = page.getByTestId("library-sources").locator("[data-source]");
  await expect(rows).toHaveCount(2);
  const first = rows.filter({ hasText: "角色图" });
  await expect(first).toHaveAttribute("data-state", "available");
  await expect(first.getByTestId("library-source-count")).toHaveText("10 张图片");
  const offline = rows.filter({ hasText: "旧硬盘" });
  await expect(offline.getByTestId("library-source-state")).toHaveText("离线");
  await expect(offline).toContainText("尚未扫描");
  await expect(offline.getByTestId("library-relink")).toBeVisible();

  await first.getByTestId("library-source-link").click();
  await expect(page).toHaveURL(new RegExp(`#/library/${source.sourceId}$`));
  await expect(page.getByRole("heading", { name: "角色图" })).toBeVisible();
  await expect(grid(page).getByRole("option")).toHaveCount(3);
  await expect(page.getByTestId("library-count")).toHaveText("3 张图片");

  // 子文件夹 a，再进 b；面包屑跟着变。
  await page.getByTestId("library-folders").getByRole("link", { name: /^a/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/library/${source.sourceId}/${source.directories.a}$`));
  const crumbs = page.getByTestId("library-breadcrumb");
  await expect(crumbs).toHaveText(/图库\s*角色图\s*a/);
  await expect(grid(page).getByRole("option")).toHaveCount(5);
  await page.getByTestId("library-depth").getByRole("button", { name: "含子文件夹" }).click();
  await expect(grid(page).getByRole("option")).toHaveCount(7);
  await page.getByTestId("library-depth").getByRole("button", { name: "仅本层" }).click();
  await expect(grid(page).getByRole("option")).toHaveCount(5);

  // 方向键 + Enter 打开查看器，右侧是同名 TXT。
  await grid(page).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("l");
  await page.keyboard.press("Enter");
  const viewer = page.getByTestId("viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId("viewer-position")).toHaveText("2 / 5");
  await expect(viewer.getByRole("img", { name: "a-002.png" })).toBeVisible();
  const txt = viewer.getByTestId("library-annotation").getByRole("textbox");
  await expect(txt).toHaveValue("1girl, a-002");
  await txt.fill("1girl, solo");
  await txt.press("Control+Enter");
  await expect(page.locator("[data-sonner-toast]", { hasText: "TXT 已保存" })).toBeVisible();
  expect(library.writes.at(-1)).toEqual({
    method: "PUT",
    path: `/api/v1/gallery/assets/${source.directories.a}-a002/annotation`,
    body: { content: "1girl, solo", expected_disk_version: "v1", expected_txt_version: 1 },
  });

  // Esc 先关查看器，焦点停在看过的那张；Backspace 回到上一层。
  await txt.blur();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(grid(page).locator("[data-focused]")).toHaveAttribute("data-index", "1");
  await page.keyboard.press("Backspace");
  await expect(page).toHaveURL(new RegExp(`#/library/${source.sourceId}$`));
  await page.keyboard.press("Backspace");
  await expect(page).toHaveURL(/#\/library$/);
});

test("直接打开深层文件夹：面包屑的上级一次取回，根目录显示来源名", async ({ page }) => {
  const library = new FakeLibrary();
  const source = library.addSource({ name: "角色图", tree: { "": 1, a: 1, "a/b": 2 } });
  // 真实扫描器给根目录存的是文件夹名，面包屑应该显示来源名。
  library.directories.set(source.rootId, { ...library.directories.get(source.rootId)!, name: "pictures" });
  await library.install(page);
  const ancestors: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/ancestors")) ancestors.push(path);
  });
  await page.goto(`/#/library/${source.sourceId}/${source.directories["a/b"]}`);

  const crumbs = page.getByTestId("library-breadcrumb");
  await expect(crumbs).toHaveText(/图库\s*角色图\s*a\s*b/);
  await expect(crumbs).not.toContainText("pictures");
  expect(ancestors).toEqual([`/api/v1/gallery/directories/${source.directories["a/b"]}/ancestors`]);
  await crumbs.getByRole("link", { name: "a" }).click();
  await expect(page).toHaveURL(new RegExp(`#/library/${source.sourceId}/${source.directories.a}$`));
  await expect(crumbs).toHaveText(/图库\s*角色图\s*a$/);
});

test("改名只改主名，扩展名不变", async ({ page }) => {
  const library = new FakeLibrary();
  const source = library.addSource({ name: "角色图", tree: { "": 2 } });
  await library.install(page);
  await page.goto(`/#/library/${source.sourceId}`);

  await grid(page).locator('[data-index="0"]').click();
  await page.keyboard.press("F2");
  const dialog = page.getByTestId("library-rename-dialog");
  const input = dialog.getByLabel("新文件名");
  await expect(input).toHaveValue("root-001");
  await expect(dialog).toContainText(".png");
  await input.fill("cover.png");
  await expect(dialog).toContainText("不用写扩展名");
  await expect(dialog.getByRole("button", { name: "改名" })).toBeDisabled();
  await input.fill("cover");
  await dialog.getByRole("button", { name: "改名" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(grid(page).getByRole("option", { name: "cover.png" })).toBeVisible();
  expect(library.writes.at(-1)?.body).toEqual({ new_stem: "cover" });
});

test("回收 2 张 → 撤销；再回收 2 张 → 从回收区恢复", async ({ page }) => {
  const library = new FakeLibrary();
  const source = library.addSource({ name: "角色图", tree: { "": 5 } });
  await library.install(page);
  await page.goto(`/#/library/${source.sourceId}`);
  await expect(grid(page).getByRole("option")).toHaveCount(5);

  await grid(page).locator('[data-index="1"]').click();
  await grid(page).locator('[data-index="3"]').click({ modifiers: ["Control"] });
  await expect(page.getByTestId("library-selection")).toHaveText("已选 2 张");
  await page.keyboard.press("Delete");
  const toast = page.locator("[data-sonner-toast]", { hasText: "已把 2 项移到回收区" });
  await expect(toast).toBeVisible();
  await expect(grid(page).getByRole("option")).toHaveCount(3);
  expect(library.writes.at(-1)?.body).toEqual({ asset_ids: [`${source.rootId}-a002`, `${source.rootId}-a004`] });

  await toast.getByRole("button", { name: "撤销" }).click();
  await expect(page.locator("[data-sonner-toast]", { hasText: "已撤销，2 项回到原位置" })).toBeVisible();
  await expect(grid(page).getByRole("option")).toHaveCount(5);

  // 再回收两张（工具栏按钮），然后去回收区恢复。
  await grid(page).locator('[data-index="0"]').click();
  await grid(page).locator('[data-index="1"]').click({ modifiers: ["Shift"] });
  await page.getByTestId("library-trash-selected").click();
  await expect(grid(page).getByRole("option")).toHaveCount(3);

  await page.goto("/#/library");
  await page.getByTestId("library-trash-link").click();
  await expect(page).toHaveURL(/#\/library\/trash$/);
  const rows = page.getByTestId("library-trash").locator("[data-operation]");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("2 项");
  await expect(rows.first()).toContainText("含 2 个 TXT");
  await rows.first().getByTestId("library-trash-restore").click();
  await expect(page.locator("[data-sonner-toast]", { hasText: "已恢复 2 项到原位置" })).toBeVisible();
  await expect(page.getByTestId("library-trash-none")).toBeVisible();

  // Esc 回到图库，来源计数复原。
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/library$/);
  await expect(page.getByTestId("library-source-count")).toHaveText("5 张图片");
});

test("回收区永久删除和清空都要确认", async ({ page }) => {
  const library = new FakeLibrary();
  const source = library.addSource({ name: "角色图", tree: { "": 6 } });
  await library.install(page);
  await page.goto(`/#/library/${source.sourceId}`);
  for (const index of [0, 0, 0]) {
    await grid(page).locator(`[data-index="${index}"]`).click();
    await page.keyboard.press("Delete");
    await expect(page.locator("[data-sonner-toast]", { hasText: "已把 1 项移到回收区" }).first()).toBeVisible();
  }
  await expect(grid(page).getByRole("option")).toHaveCount(3);

  await page.goto("/#/library/trash");
  const rows = page.getByTestId("library-trash").locator("[data-operation]");
  await expect(rows).toHaveCount(3);
  await rows.first().getByTestId("library-trash-purge").click();
  const confirm = page.getByTestId("library-trash-confirm");
  await expect(confirm).toContainText("永久删除这 1 项？");
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(rows).toHaveCount(3);
  await rows.first().getByTestId("library-trash-purge").click();
  await confirm.getByTestId("library-trash-confirm-submit").click();
  await expect(rows).toHaveCount(2);

  await page.getByTestId("library-trash-empty").click();
  await expect(confirm).toContainText("清空回收区？");
  await confirm.getByTestId("library-trash-confirm-submit").click();
  await expect(page.locator("[data-sonner-toast]", { hasText: "永久删除 2 项" })).toBeVisible();
  await expect(page.getByTestId("library-trash-none")).toBeVisible();
  expect(library.writes.filter((write) => write.method === "DELETE").map((write) => write.path)).toEqual([
    expect.stringMatching(/^\/api\/v1\/gallery\/trash\/op\d+$/),
    "/api/v1/gallery/trash",
  ]);
});

test("加入数据集：选已有的数据集，POST roots 带 directory_id，提示里能打开数据集", async ({ page }) => {
  const library = new FakeLibrary();
  const source = library.addSource({ name: "角色图", tree: { "": 1, a: 4 } });
  const datasets = new FakeDatasets();
  datasets.add({ name: "角色 A" });
  await library.install(page);
  await datasets.install(page);
  const roots: unknown[] = [];
  await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/roots", (request) => {
    roots.push({ dataset: new URL(request.url()).pathname.split("/")[4], body: request.postDataJSON() });
    return { status: 201, body: datasets.attachFolder("ds1", "/pictures/a", 4) };
  });
  await page.goto(`/#/library/${source.sourceId}/${source.directories.a}`);

  await page.getByTestId("library-add-to-dataset").click();
  const dialog = page.getByTestId("library-add-dataset");
  await expect(dialog).toContainText("不能只加单张图片");
  await expect(dialog).toContainText("角色图 / a");
  const submit = dialog.getByTestId("library-add-submit");
  await expect(submit).toBeDisabled();
  await dialog.getByRole("radio", { name: /角色 A/ }).click();
  await submit.click();
  await expect(dialog).toHaveCount(0);
  expect(roots).toEqual([{ dataset: "ds1", body: { directory_id: source.directories.a } }]);

  const toast = page.locator("[data-sonner-toast]", { hasText: "已把「角色图 / a」加入「角色 A」" });
  await toast.getByRole("button", { name: "打开数据集" }).click();
  await expect(page).toHaveURL(/#\/datasets\/ds1\/collect$/);
  await expect(page.getByTestId("collect-roots")).toContainText("a");
});

test("加入数据集：就地新建数据集，来源根目录挂整个来源", async ({ page }) => {
  const library = new FakeLibrary();
  const source = library.addSource({ name: "角色图", tree: { "": 2 } });
  const datasets = new FakeDatasets();
  await library.install(page);
  await datasets.install(page);
  const roots: unknown[] = [];
  await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/roots", (request) => {
    roots.push(request.postDataJSON());
    return { status: 201, body: datasets.attachFolder("ds1", "/pictures", 2) };
  });
  await page.goto(`/#/library/${source.sourceId}`);

  await page.getByTestId("library-add-to-dataset").click();
  const dialog = page.getByTestId("library-add-dataset");
  // 还没有数据集时直接进入新建。
  await expect(dialog.getByTestId("library-add-new")).toHaveAttribute("aria-checked", "true");
  await dialog.getByLabel("名称").fill("新角色");
  await dialog.getByRole("button", { name: "画风" }).click();
  await dialog.getByTestId("library-add-submit").click();
  await expect(dialog).toHaveCount(0);
  expect(roots).toEqual([{ source_id: source.sourceId }]);
  expect(datasets.datasets.get("ds1")).toMatchObject({ name: "新角色", kind: "style" });
  await expect(page.locator("[data-sonner-toast]", { hasText: "加入「新角色」" })).toBeVisible();
});

test("搜索按范围查文件名", async ({ page }) => {
  const library = new FakeLibrary();
  const source = library.addSource({ name: "角色图", tree: { "": 2, a: 3 } });
  library.addSource({ name: "别的", tree: { "": 2 } });
  await library.install(page);
  await page.goto(`/#/library/${source.sourceId}/${source.directories.a}`);
  await expect(grid(page).getByRole("option")).toHaveCount(3);

  await page.keyboard.press("/");
  await expect(page.getByTestId("library-search")).toBeFocused();
  await page.keyboard.type("root");
  await expect(page.getByText("没有文件名包含「root」的图片")).toBeVisible();
  await page.getByTestId("library-scope").getByRole("button", { name: "此来源" }).click();
  await expect(grid(page).getByRole("option")).toHaveCount(2);
  await page.getByTestId("library-scope").getByRole("button", { name: "整个图库" }).click();
  await expect(grid(page).getByRole("option")).toHaveCount(4);
  // 输入框里 Esc 清空搜索，回到文件夹内容（不会返回上一层）。
  await page.getByTestId("library-search").press("Escape");
  await expect(grid(page).getByRole("option")).toHaveCount(3);
  await expect(page).toHaveURL(new RegExp(`#/library/${source.sourceId}/${source.directories.a}$`));
});

test("扫描进度跟着任务走，任务结束后重拉来源；手动扫描在任务推过来前也显示扫描中", async ({ page }) => {
  const library = new FakeLibrary();
  const source = library.addSource({ name: "角色图", tree: { "": 2 }, lastScannedAt: null });
  await library.install(page);
  const running = job({
    id: `scan:${source.sourceId}`,
    kind: "gallery.scan",
    title: "扫描 角色图",
    ref: { source_id: source.sourceId },
    current: 3,
    total: null,
  });
  // 第一次连接推「遍历中，已读 3 张」；第二次等用例放行推「写索引，10 / 10」；第三次推「已完成」。
  let commit = () => {};
  const committing = new Promise<void>((resolve) => (commit = resolve));
  let finish = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  let connections = 0;
  await page.route(
    (url) => url.pathname === "/api/v1/events",
    async (route) => {
      connections += 1;
      let events: SseEvent[] = [];
      if (connections === 1) events = [{ event: "job.updated", id: "s-1", data: { job: running } }];
      if (connections === 2) {
        await committing;
        events = [{ event: "job.updated", id: "s-2", data: { job: { ...running, current: 10, total: 10 } } }];
      }
      if (connections === 3) {
        await finished;
        const at = Math.floor(Date.now() / 1000);
        events = [{ event: "job.updated", id: "s-3", data: { job: { ...running, status: "succeeded", current: 10, total: 10, updated_at: at, finished_at: at } } }];
      }
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: `: ldos e2e\n\n${sseBody(events)}`,
      });
    },
  );
  await page.goto("/#/library");

  const row = page.locator(`[data-source="${source.sourceId}"]`);
  await expect(row).toHaveAttribute("data-state", "scanning");
  // 还没有总数：只显示已读张数，不画进度条。
  await expect(row.getByTestId("library-scan-progress")).toHaveText("扫描中 已读 3 张");
  await expect(row.getByTestId("library-scan-bar")).toHaveCount(0);
  await expect(row.getByTestId("library-scan")).toBeDisabled();
  commit();
  await expect(row.getByTestId("library-scan-progress")).toHaveText("扫描中 10 / 10");
  await expect(row.getByTestId("library-scan-bar")).toBeVisible();

  library.sources.set(source.sourceId, { ...library.sources.get(source.sourceId)!, last_scanned_at: Math.floor(Date.now() / 1000) });
  finish();
  await expect(row).toHaveAttribute("data-state", "available");
  await expect(row).toContainText("刚刚扫描");
  await expect(row.getByTestId("library-scan")).toHaveText("重新扫描");

  await row.getByTestId("library-scan").click();
  await expect(row).toHaveAttribute("data-state", "scanning");
  await expect(row.getByTestId("library-scan-progress")).toHaveText("扫描中…");
  expect(library.writes.at(-1)?.path).toBe(`/api/v1/gallery/sources/${source.sourceId}/scan`);
});

test("浏览器模式下输入路径添加文件夹，导入后显示扫描中", async ({ page }) => {
  const library = new FakeLibrary();
  library.addSource({ name: "角色图", tree: { "": 2 } });
  await library.install(page);
  await page.goto("/#/library");

  await page.getByTestId("library-add").click();
  const dialog = page.getByTestId("library-path-dialog");
  await expect(dialog).toContainText("请输入文件夹的绝对路径");
  const submit = dialog.getByRole("button", { name: "导入" });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("文件夹路径").fill("/home/me/pictures/new");
  await dialog.getByLabel("显示名称（可选）").fill("新文件夹");
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]", { hasText: "已添加「新文件夹」，正在扫描" })).toBeVisible();
  const rows = page.getByTestId("library-sources").locator("[data-source]");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "新文件夹" })).toHaveAttribute("data-state", "scanning");
  expect(library.writes.at(-1)).toEqual({
    method: "POST",
    path: "/api/v1/gallery/imports",
    body: { root_path: "/home/me/pictures/new", display_name: "新文件夹" },
  });
});

test("离线来源可以重新关联，移出来源要确认", async ({ page }) => {
  const library = new FakeLibrary();
  const offline = library.addSource({ name: "旧硬盘", availability: "offline", tree: { "": 1 } });
  await library.install(page);
  await page.goto("/#/library");

  const row = page.locator(`[data-source="${offline.sourceId}"]`);
  await row.getByTestId("library-relink").click();
  const dialog = page.getByTestId("library-path-dialog");
  await expect(dialog).toContainText("重新关联「旧硬盘」");
  await dialog.getByLabel("文件夹路径").fill("/mnt/new-disk/pictures");
  await dialog.getByRole("button", { name: "重新关联" }).click();
  await expect(dialog).toHaveCount(0);
  expect(library.writes.at(-1)).toEqual({
    method: "POST",
    path: `/api/v1/gallery/sources/${offline.sourceId}/relink`,
    body: { root_path: "/mnt/new-disk/pictures" },
  });
  await expect(row.getByTestId("library-relink")).toHaveCount(0);

  await row.getByTestId("library-remove").click();
  const confirm = page.getByTestId("library-remove-dialog");
  await expect(confirm).toContainText("把「旧硬盘」移出图库？");
  // 导入的文件夹不能连文件一起删。
  await expect(confirm.getByRole("checkbox")).toHaveCount(0);
  await confirm.getByTestId("library-remove-confirm").click();
  await expect(page.getByTestId("library-empty")).toBeVisible();
  expect(library.writes.at(-1)?.path).toBe(`/api/v1/gallery/sources/${offline.sourceId}?delete_files=false`);
});
