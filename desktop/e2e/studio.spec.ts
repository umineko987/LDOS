import type { Page } from "@playwright/test";

import { errorEnvelope } from "./fixtures/api";
import { FakeGalleryStudio } from "./fixtures/gallery-studio";
import { FakeLibrary, type FakeSourceHandle } from "./fixtures/library";
import { expect, test } from "./fixtures/test";

const TOTAL = 12;
const WITH_HAT = 9;
const WITH_HAT_TEXT = "sks, 1girl, hat, solo";
const WITHOUT_HAT_TEXT = "sks, 1girl, long_hair";

let library: FakeLibrary;
let studio: FakeGalleryStudio;
let source: FakeSourceHandle;
let rootAssets: string[];

const review = () => `/#/library/${source.sourceId}/review`;
const sourceApi = () => `/api/v1/gallery/sources/${source.sourceId}`;
const count = (page: Page) => page.getByTestId("studio-count");
const cell = (page: Page, index: number) => page.getByTestId("virtual-grid").locator(`[data-index="${index}"]`);
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });

async function enterSingle(page: Page) {
  await cell(page, 0).click();
  await page.keyboard.press("Enter");
  return page.getByTestId("studio-triage");
}

function assetIds(directoryId: string) {
  return [...library.assets.values()].filter((asset) => asset.directory_id === directoryId).map((asset) => asset.asset_id);
}

async function install(page: Page) {
  await library.install(page);
  await studio.install(page);
}

test.beforeEach(() => {
  library = new FakeLibrary();
  source = library.addSource({ name: "图库实拍", tree: { "": TOTAL } });
  studio = new FakeGalleryStudio(library);
  rootAssets = assetIds(source.rootId);
  rootAssets.forEach((id, index) => studio.seed(id, index < WITH_HAT ? WITH_HAT_TEXT : WITHOUT_HAT_TEXT));
});

test("来源内查询、全选、预览并写入批量标签，toast 可撤销", async ({ page }) => {
  await install(page);
  await page.goto(review());
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL));
  await expect(page.getByTestId("studio-gallery-scope")).toContainText("图库实拍");
  const frequency = page.getByTestId("studio-frequency");
  await expect(frequency.locator('[data-tag="hat"]')).toHaveAttribute("data-count", String(WITH_HAT));

  const query = page.getByTestId("studio-query");
  await query.fill("1girl -hat");
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL - WITH_HAT));
  await expect(frequency.locator('[data-tag="hat"]')).toHaveCount(0);
  await query.fill("1girl hat");
  await expect(count(page)).toHaveAttribute("data-count", String(WITH_HAT));
  const title = page.getByTestId("studio-inspector-title");
  await expect(title).toHaveAttribute("data-scope", "results");

  await cell(page, 0).click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(title).toHaveAttribute("data-scope", "selection");
  await expect(title).toHaveAttribute("data-count", String(WITH_HAT));
  const hatRow = page.getByTestId("studio-tags-all").locator('[data-tag="hat"]');
  await expect(hatRow).toContainText(`${WITH_HAT}/${WITH_HAT}`);
  await hatRow.locator('[data-action="remove"]').click();

  const dialog = page.getByTestId("studio-op-dialog");
  await expect(dialog.getByTestId("studio-op-tags")).toHaveValue("hat");
  await expect(dialog.getByTestId("studio-op-stats")).toHaveAttribute("data-changes", String(WITH_HAT));
  await expect(dialog.getByTestId("studio-op-samples").locator('[data-diff="removed"]').first()).toContainText("hat");
  const asset_ids = rootAssets.slice(0, WITH_HAT);
  const ops = [{ op: "remove", tags: ["hat"] }];
  const expected_versions = Object.fromEntries(asset_ids.map((id) => [id, "v1"]));
  expect(studio.requests).toContainEqual({
    method: "POST", path: `${sourceApi()}/captions/ops`, body: { asset_ids, ops, expected_versions, dry_run: true, sample_limit: 6 },
  });
  expect(studio.files(rootAssets[0]!)?.content).toBe(WITH_HAT_TEXT);

  await dialog.getByTestId("studio-op-apply").click();
  await expect(dialog).toBeHidden();
  expect(studio.requests).toContainEqual({
    method: "POST", path: `${sourceApi()}/captions/ops`, body: { asset_ids, ops, expected_versions, dry_run: false, sample_limit: 0 },
  });
  expect(studio.files(rootAssets[0]!)?.content).toBe("sks, 1girl, solo");
  expect(studio.files(rootAssets.at(-1)!)?.content).toBe(WITHOUT_HAT_TEXT);
  await expect(count(page)).toHaveAttribute("data-count", "0");
  await expect(page.getByTestId("studio-selection")).toBeHidden();
  const batch = page.getByTestId("studio-history").locator('[data-kind="ops"]');
  await expect(batch).toHaveAttribute("data-undone", "false");

  await toast(page, `已改写 ${WITH_HAT} 张 caption`).getByRole("button", { name: "撤销" }).click();
  await expect(toast(page, `已撤销，恢复了 ${WITH_HAT} 张`)).toBeVisible();
  await expect(count(page)).toHaveAttribute("data-count", String(WITH_HAT));
  await expect(batch).toHaveAttribute("data-undone", "true");
  expect(studio.files(rootAssets[0]!)?.content).toBe(WITH_HAT_TEXT);

  // Grid Keep applies only to the selection, never to all search results.
  const reviewed = page.getByTestId("studio-reviewed");
  await cell(page, 0).click();
  await page.keyboard.press("a");
  await expect(reviewed).toHaveAttribute("data-count", "1");
  await expect(page.getByTestId("studio-gallery-undo")).toBeEnabled();
  expect([...studio.kept]).toEqual([asset_ids[0]]);
  await page.keyboard.press("a");
  await expect(reviewed).toHaveAttribute("data-count", "0");
  expect(studio.kept.size).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("studio-selection")).toBeHidden();
  await expect(query).toHaveValue("1girl hat");
  await page.keyboard.press("Escape");
  await expect(query).toHaveValue("");
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL));
});

test("Z 撤销来源的批量写入；暂时失败的批次可重试", async ({ page }) => {
  await install(page);
  await page.goto(review());
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL));
  const batches = page.getByTestId("studio-history").locator('[data-kind="ops"]');

  async function removeFromAll(tag: string) {
    await cell(page, 0).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.getByTestId("studio-tags-partial").locator(`[data-tag="${tag}"] [data-action="remove"]`).click();
    const dialog = page.getByTestId("studio-op-dialog");
    await expect(dialog.getByTestId("studio-op-stats")).toHaveAttribute("data-changes", String(WITH_HAT));
    await dialog.getByTestId("studio-op-apply").click();
    await expect(dialog).toBeHidden();
  }

  await removeFromAll("hat");
  await removeFromAll("solo");
  await expect(batches).toHaveCount(2);
  expect(studio.files(rootAssets[0]!)?.content).toBe("sks, 1girl");
  await page.keyboard.press("z");
  await expect(batches.first()).toHaveAttribute("data-undone", "true");
  expect(studio.files(rootAssets[0]!)?.content).toBe("sks, 1girl, solo");
  await page.keyboard.press("z");
  await expect(batches.nth(1)).toHaveAttribute("data-undone", "true");
  expect(studio.files(rootAssets[0]!)?.content).toBe(WITH_HAT_TEXT);
  expect(studio.requests.filter(({ path }) => path.endsWith("/undo")).map(({ path }) => path)).toEqual([
    "/api/v1/caption-batches/gallery-caption-2/undo", "/api/v1/caption-batches/gallery-caption-1/undo",
  ]);

  await removeFromAll("hat");
  studio.undoOutages = 1;
  await page.keyboard.press("z");
  const incomplete = toast(page, `${WITH_HAT} 张暂时没能恢复`);
  await expect(incomplete).toBeVisible();
  expect(studio.files(rootAssets[0]!)?.content).toBe("sks, 1girl, solo");
  await expect(batches.first()).toHaveAttribute("data-undone", "false");
  await incomplete.getByRole("button", { name: "重试" }).click();
  await expect(batches.first()).toHaveAttribute("data-undone", "true");
  expect(studio.files(rootAssets[0]!)?.content).toBe(WITH_HAT_TEXT);
});

test("频率表查询、来源级触发词与黑名单、不带标签筛选", async ({ page }) => {
  studio.seed(rootAssets.at(-1)!, null);
  await install(page);
  await page.goto(review());
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL));
  const settings = page.getByTestId("studio-gallery-settings");
  await settings.locator("summary").click();
  await settings.getByLabel("触发词", { exact: true }).fill("sks");
  await settings.getByRole("button", { name: "保存标签设置" }).click();
  await expect(page.getByTestId("studio-trigger")).toContainText("sks");
  await settings.locator("summary").click();

  const frequency = page.getByTestId("studio-frequency");
  const longHair = frequency.locator('[data-tag="long_hair"] button').first();
  const query = page.getByTestId("studio-query");
  await longHair.click();
  await expect(query).toHaveValue("long_hair");
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL - WITH_HAT - 1));
  await longHair.click({ modifiers: ["Alt"] });
  await expect(query).toHaveValue("-long_hair");
  await expect(count(page)).toHaveAttribute("data-count", String(WITH_HAT + 1));
  const solo = frequency.locator('[data-tag="solo"]');
  await solo.getByRole("button", { name: "把 solo 加进黑名单" }).click();
  await expect(page.getByTestId("studio-blacklist")).toContainText("solo");
  await expect(solo.getByRole("button", { name: "把 solo 移出黑名单" })).toHaveAttribute("aria-pressed", "true");

  await query.fill("");
  await page.getByTestId("studio-gallery-no-tags").click();
  await expect(query).toHaveValue("untagged");
  await expect(count(page)).toHaveAttribute("data-count", "1");
  await expect(cell(page, 0)).toHaveAccessibleName("root-012.png");
  await page.reload();
  await expect(page.getByTestId("studio-trigger")).toContainText("sks");
  await expect(page.getByTestId("studio-blacklist")).toContainText("solo");
  expect(studio.requests).toEqual([]);
});

test("逐张编辑使用版本，Z 按顺序撤销每次改动", async ({ page }) => {
  await install(page);
  await page.goto(review());
  await expect(count(page)).toHaveAttribute("data-count", String(TOTAL));
  const triage = await enterSingle(page);
  const current = rootAssets[0]!;
  await expect(triage).toHaveAttribute("data-asset", current);
  const region = page.getByRole("region", { name: "逐张校对" });
  await expect(page.getByTestId("studio-inspector-title")).toHaveAttribute("data-scope", "current");

  await page.keyboard.press("t");
  const add = page.getByTestId("studio-triage-add");
  await expect(add).toBeFocused();
  await add.fill("smile");
  await add.press("Enter");
  const tags = page.getByTestId("studio-triage-tags");
  await expect(tags.locator('[data-tag="smile"]')).toBeVisible();
  expect(studio.requests).toContainEqual({
    method: "PUT", path: `${sourceApi()}/captions/${current}`,
    body: { text: `${WITH_HAT_TEXT}, smile`, expected_version: "v1" },
  });
  await tags.getByRole("button", { name: "删掉 solo" }).click();
  await expect(tags.locator('[data-tag="solo"]')).toHaveCount(0);
  expect(studio.files(current)?.content).toBe("sks, 1girl, hat, smile");
  expect(studio.requests.at(-1)?.body).toMatchObject({ expected_version: "v2" });
  await region.focus();
  await page.keyboard.press("z");
  await expect(tags.locator('[data-tag="solo"]')).toBeVisible();
  await expect(page.getByTestId("studio-gallery-undo")).toBeEnabled();
  await page.keyboard.press("z");
  await expect(tags.locator('[data-tag="smile"]')).toHaveCount(0);
  expect(studio.files(current)?.content).toBe(WITH_HAT_TEXT);
  await expect(page.getByTestId("studio-gallery-undo")).toBeDisabled();
  await page.keyboard.press("ArrowRight");
  await expect(triage).toHaveAttribute("data-asset", rootAssets[1]!);
  await page.keyboard.press("Escape");
  await expect(triage).toBeHidden();
  await expect(cell(page, 1)).toHaveAttribute("data-focused", "true");
});

test("文件夹审核：保留、回收图和同名 TXT、撤销；失败时不移动当前图", async ({ page }) => {
  const folder = "alpha 精选图";
  const tree = library.addSource({ name: "来源合集", tree: { [folder]: 2, [`${folder}/nested 子目录`]: 1, [`其它/${folder}`]: 1, "其它": 0 } });
  source = tree;
  const folderId = tree.directories[folder]!;
  const [first, second] = assetIds(folderId) as [string, string];
  const descendant = assetIds(tree.directories[`${folder}/nested 子目录`]!)[0]!;
  const outside = assetIds(tree.directories[`其它/${folder}`]!)[0]!;
  studio.seed(first, "keep me");
  studio.seed(second, "trash me");
  studio.seed(descendant, "nested caption");
  studio.seed(outside, "outside, same filename as first");
  const pair = { image: `${folder}/${folder}-002.png`, txt: `${folder}/${folder}-002.txt`, content: "trash me" };
  await install(page);

  // Return one real API error without changing the shared gallery fixture.
  const trashPath = "/api/v1/gallery/file-operations/trash";
  const failedBodies: unknown[] = [];
  await page.route((url) => url.pathname === trashPath, (route) => {
    if (route.request().method() !== "POST" || failedBodies.length) return route.fallback();
    failedBodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: errorEnvelope("source_offline", "来源离线") });
  });
  // Use the real library-folder entry to verify it uses the folder ID, not its name or a dataset ID.
  const folderUrl = `/#/library/${tree.sourceId}/${folderId}`;
  await page.goto(folderUrl);
  const captionsRequest = page.waitForRequest((request) => new URL(request.url()).pathname === `${sourceApi()}/captions`);
  await page.getByTestId("library-review-link").click();
  await expect(page).toHaveURL(`${review()}?directory=${folderId}`);
  expect(new URL((await captionsRequest).url()).searchParams.get("directory_id")).toBe(folderId);
  await expect(page.getByTestId("studio")).toHaveAttribute("data-directory", folderId);
  await expect(page.getByTestId("studio-gallery-scope")).toContainText(folder);
  await expect(page.getByTestId("studio-gallery-back")).toHaveAttribute("href", folderUrl.slice(1));
  await expect(count(page)).toHaveAttribute("data-count", "3");
  const grid = page.getByTestId("virtual-grid");
  await expect(grid.locator("[data-caption]").filter({ hasText: "nested caption" })).toBeVisible();
  await expect(grid.locator("[data-caption]").filter({ hasText: "outside" })).toHaveCount(0);

  const triage = await enterSingle(page);
  await expect(triage).toHaveAttribute("data-asset", first);
  await page.keyboard.press("Enter");
  await expect(triage).toHaveAttribute("data-asset", second);
  await expect(page.getByTestId("studio-reviewed")).toHaveAttribute("data-count", "1");
  const keepPath = `${sourceApi()}/kept`;
  expect(studio.requests).toContainEqual({ method: "PUT", path: keepPath, body: { asset_ids: [first], kept: true } });
  expect(studio.kept.has(first)).toBe(true);
  expect(studio.kept.has(outside)).toBe(false);
  expect(studio.files(second)).toEqual(pair);

  const trash = page.getByTestId("studio-gallery-trash");
  await trash.click();
  await expect(toast(page, "无法将图片移入回收区")).toBeVisible();
  await expect(triage).toHaveAttribute("data-asset", second);
  await expect(page.getByTestId("studio-triage-position")).toHaveText("2 / 3");
  await expect(page.getByTestId("studio-inspector-title")).toHaveAttribute("data-scope", "current");
  await expect(count(page)).toHaveAttribute("data-count", "3");
  expect(failedBodies).toEqual([{ asset_ids: [second] }]);
  expect(library.trashed()).toHaveLength(0);
  expect(studio.files(second)).toEqual(pair);

  await trash.click();
  await expect(triage).toHaveAttribute("data-asset", descendant);
  await expect(count(page)).toHaveAttribute("data-count", "2");
  expect(library.writes.at(-1)).toEqual({ method: "POST", path: trashPath, body: { asset_ids: [second] } });
  const operation = library.trashed()[0]!;
  expect(operation).toMatchObject({ asset_ids: [second], txt_paths: [pair.txt] });
  expect(studio.files(second)).toBeNull();
  expect(studio.files(outside)?.content).toBe("outside, same filename as first");

  const undo = page.getByTestId("studio-gallery-undo");
  await undo.click();
  await expect(triage).toHaveAttribute("data-asset", second);
  await expect(count(page)).toHaveAttribute("data-count", "3");
  await expect(page.getByTestId("studio-triage-text")).toHaveText(pair.content);
  expect(library.writes.at(-1)).toEqual({
    method: "POST", path: `/api/v1/gallery/file-operations/${operation.operation_id}/undo`, body: null,
  });
  expect(library.trashed()).toHaveLength(0);
  expect(studio.files(second)).toEqual(pair);

  await undo.click();
  await expect(triage).toHaveAttribute("data-asset", first);
  await expect(page.getByTestId("studio-reviewed")).toHaveAttribute("data-count", "0");
  expect(studio.requests.at(-1)).toEqual({ method: "PUT", path: keepPath, body: { asset_ids: [first], kept: false } });
  await expect(undo).toBeDisabled();
});
