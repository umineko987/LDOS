import type { Page } from "@playwright/test";

import { FakeDatasets } from "./fixtures/datasets";
import { FakeExports, fakeDesktopHost, hostCalls } from "./fixtures/exports";
import { expect, test } from "./fixtures/test";

async function setup(page: Page, prepare?: (exports: FakeExports) => void, config?: Record<string, unknown>) {
  const datasets = new FakeDatasets();
  const id = datasets.add({ name: "角色 A", trigger_word: "alice", members: 6, config });
  await datasets.install(page);
  const exports = new FakeExports(datasets, id);
  prepare?.(exports);
  await exports.install(page);
  return { id, exports };
}

test("kohya 布局：选目录、预览计划、开始导出，完成后在文件管理器中打开", async ({ page }) => {
  await fakeDesktopHost(page, { directory: "/home/me/train" });
  const { id, exports } = await setup(page);
  await page.goto(`/#/datasets/${id}/export`);

  // 默认 kohya、10 次、触发词取数据集的；还没选目录，不能预览。
  await expect(page.getByTestId("export-layout").getByRole("button", { name: "kohya" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("export-trigger")).toHaveValue("alice");
  await expect(page.getByTestId("export-issue")).toHaveText("先选导出目录。");
  await expect(page.getByTestId("export-preview")).toBeDisabled();

  await page.getByTestId("export-pick").click();
  await expect(page.getByTestId("export-target")).toHaveValue("/home/me/train");
  await page.getByTestId("export-repeats").fill("12");
  await page.getByTestId("export-rename").getByRole("button", { name: "按序号" }).click();
  await expect(page.getByText("将建在 12_alice")).toBeVisible();

  // 预览：不写文件，列出文件树和标注样例；预览前不能开始。
  await expect(page.getByTestId("export-start")).toBeDisabled();
  await page.getByTestId("export-preview").click();
  const plan = page.getByTestId("export-plan");
  await expect(plan.getByTestId("export-plan-output")).toHaveText("/home/me/train/12_alice");
  await expect(plan.getByTestId("export-plan-stats")).toContainText("6 张图 · 6 个标注");
  await expect(plan.getByTestId("export-plan-caption")).toHaveText("alice, 1girl, solo");
  await expect(plan.getByTestId("export-plan-tree")).toContainText("12_alice/0001.png");
  expect(exports.requests.at(-1)).toMatchObject({
    dry_run: true,
    target_path: "/home/me/train",
    layout: "kohya",
    repeats: 12,
    trigger_word: "alice",
    rename: "sequential",
    include_captions: true,
  });

  // 改了选项计划就过期，要重新预览。
  await page.getByTestId("export-repeats").fill("13");
  await expect(plan).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("export-start")).toBeDisabled();
  await page.getByTestId("export-repeats").fill("12");
  await expect(plan).not.toHaveAttribute("data-stale", "true");

  await page.getByTestId("export-start").click();
  await expect(page.getByText("已开始导出")).toBeVisible();
  expect(exports.requests.at(-1)).toMatchObject({ dry_run: false, repeats: 12 });

  // 进度：先是 4 / 6，再到完成。
  const current = page.getByTestId("export-current");
  await expect(current.getByTestId("export-progress-count")).toHaveText("4 / 6", { timeout: 10_000 });
  await expect(current).toHaveAttribute("data-status", "succeeded", { timeout: 10_000 });
  await expect(current.getByTestId("export-status")).toHaveText("完成");

  await current.getByTestId("export-reveal").click();
  await expect.poll(() => hostCalls(page)).toContainEqual({ command: "Host.RevealInFileManager", args: ["/home/me/train/12_alice"] });
});

test("黑名单默认取标签工作室存的，手动改过以后照用户的", async ({ page }) => {
  const { id, exports } = await setup(page, undefined, { tag_blacklist: ["watermark", "text"] });
  await page.goto(`/#/datasets/${id}/export`);

  const blacklist = page.getByTestId("export-blacklist");
  await expect(blacklist).toHaveValue("watermark, text");
  await page.getByTestId("export-target").fill("/home/me/train");
  await page.getByTestId("export-preview").click();
  await expect(page.getByTestId("export-plan")).toBeVisible();
  expect(exports.requests.at(-1)).toMatchObject({ dry_run: true, tag_blacklist: ["watermark", "text"] });

  await blacklist.fill("watermark");
  await page.getByTestId("export-preview").click();
  await expect.poll(() => exports.requests.at(-1)?.tag_blacklist).toEqual(["watermark"]);
});

test("浏览器模式：手填目录，没有选目录和在文件管理器中打开；中断的导出可以续传", async ({ page }) => {
  const { id, exports } = await setup(page, (fake) =>
    fake.add({
      body: { target_path: "/data/out", layout: "flat", include_captions: false },
      status: "interrupted",
      resumable: true,
      error_code: "export_interrupted",
      staged_items: 2,
    }),
  );
  await page.goto(`/#/datasets/${id}/export`);

  // 中断的导出钉在上面，可以续传。
  const current = page.getByTestId("export-current");
  await expect(current).toHaveAttribute("data-status", "interrupted");
  await expect(current.getByTestId("export-error")).toHaveText("后端重启，导出中断了。");
  await expect(current.getByTestId("export-progress-count")).toHaveText("2 / 6");

  // 上次的选项沿用：平铺、不带标注、同一个目录。
  await expect(page.getByTestId("export-layout").getByRole("button", { name: "平铺" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("export-target")).toHaveValue("/data/out");
  await expect(page.getByTestId("export-repeats")).toHaveCount(0);
  await expect(page.getByTestId("export-pick")).toHaveCount(0);

  // 相对路径不行。
  await page.getByTestId("export-target").fill("out");
  await expect(page.getByTestId("export-issue")).toHaveText("目录要写完整路径。");
  await expect(page.getByTestId("export-preview")).toBeDisabled();

  await current.getByTestId("export-resume").click();
  await expect(current).toHaveAttribute("data-status", "succeeded", { timeout: 10_000 });
  expect(exports.records[0]?.status).toBe("succeeded");
  // 浏览器里打不开文件管理器，不显示这个按钮。
  await expect(current.getByTestId("export-reveal")).toHaveCount(0);
});
