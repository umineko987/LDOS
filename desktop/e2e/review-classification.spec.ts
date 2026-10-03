import { appPage, prepareRichState } from "./fixtures/app-state";
import { bootDesktop, expect, test } from "./fixtures/test";

test("three category views retain complete mixed groups and share adoption decisions", async ({ page }) => {
  const api = await bootDesktop(page);
  let version = 1;
  const decisions = new Map<string, string[]>();
  const groups = [
    { id: "mixed", ordinal: 1, kind: "duplicate", classes: ["", "rough", "monochrome"] },
    { id: "rough-pair", ordinal: 2, kind: "duplicate", classes: ["rough", "rough"] },
    { id: "unreadable", ordinal: 3, kind: "unreadable", classes: [""] },
    { id: "single-sketch", ordinal: 24, kind: "single", classes: ["rough"] },
  ];
  const summary = () => ({
    response_profile: "desktop-gallery-review-v1", review_id: "review-created-1", version, status: "ready", directories: [],
    totalImageCount: 7, totalGroupCount: 4, duplicateGroupCount: 2, unreadableImageCount: 1,
    automaticGroupCount: 0, automaticRejectedImageCount: 0, filteredImageCount: 0,
    selectedImageCount: decisions.has("mixed") ? 6 : 7, decidedGroupCount: decisions.size,
    keptImageCount: decisions.has("mixed") ? 2 : 0, rejectedImageCount: decisions.has("mixed") ? 1 : 0,
    failedImageCount: 0, hasError: false,
  });
  await page.route("**/api/v1/gallery/reviews/review-created-1**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/adopt")) {
      const body = request.postDataJSON();
      expect(body.version).toBe(version);
      decisions.set("mixed", body.selected_image_ids);
      version += 1;
      await route.fulfill({ json: { ...summary(), response_profile: "desktop-gallery-review-operation-v1" } });
      return;
    }
    if (url.pathname.includes("/images/")) { await route.fallback(); return; }
    const classification = url.searchParams.get("classification");
    const matching = groups.filter(({ classes }) => !classification || classes.includes(classification));
    await route.fulfill({ json: { ...summary(), groups: { total: matching.length, offset: 0, limit: 50,
      items: matching.map((group) => ({ id: group.id, ordinal: group.ordinal, kind: group.kind, decided: decisions.has(group.id),
        images: group.classes.map((classification, index) => ({
          id: `${group.id}-${index}`, asset_id: `${group.id}-${index}`, source_display_name: "Fixture", relative_path: `${index}.png`,
          ordinal: index + 1, readable: group.kind !== "unreadable", recommended: index === 0,
          selected: decisions.get(group.id)?.includes(`${group.id}-${index}`) ?? !decisions.has(group.id),
          metadata: { w: 1200, h: 800, ...(classification ? { classification } : {}) },
        })),
      })),
    } } });
  });
  await prepareRichState(page, "review");
  const review = appPage(page, "review");
  const tabs = review.getByRole("tab");
  await expect(tabs).toHaveText(["全部", "线稿/草图", "单色"]);
  const cards = review.locator("[data-review-engine-card]");
  const selector = review.locator("[data-review-group-select]");
  await expect(cards).toHaveCount(3);
  await expect(selector.locator("option")).toHaveCount(4);
  await expect(review.locator(".review-deck-header h2")).toHaveText("组 1 · 3 张图片");
  await expect(selector.locator("option")).toHaveText([
    "组 1 · 3/3 保留", "组 2 · 2/2 保留", "组 3 · 1/1 保留", "组 24 · 1/1 保留",
  ]);
  for (const width of [1280, 800]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => review.locator(".review-engine-host").evaluate((host) => {
      const help = host.querySelector(".review-classification-help")!;
      const text = document.createRange();
      text.selectNodeContents(help);
      const header = host.querySelector(".review-deck-header")!.getBoundingClientRect();
      const deck = host.querySelector(".review-deck")!.getBoundingClientRect();
      const stage = host.querySelector(".review-deck-stage")!.getBoundingClientRect();
      const footer = host.querySelector(".review-deck-statusbar")!.getBoundingClientRect();
      return header.top >= text.getBoundingClientRect().bottom + 4
        && stage.height >= 100 && stage.bottom <= footer.top
        && deck.bottom <= host.getBoundingClientRect().bottom;
    })).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await review.getByRole("tab", { name: "线稿/草图", exact: true }).click();
  await expect(cards).toHaveCount(3);
  await expect(selector.locator("option")).toHaveCount(3);
  await selector.selectOption("rough-pair");
  await expect(cards).toHaveCount(2);
  await expect(review.locator(".review-deck-header h2")).toHaveText("组 2 · 2 张图片");
  await selector.selectOption("single-sketch");
  await expect(cards).toHaveCount(1);
  await expect(review.locator(".review-deck-header h2")).toHaveText("组 24 · 1 张图片");
  await expect(review.locator("[data-review-classification]")).toContainText("线稿/草图");
  await expect(review).not.toContainText(/独立图片|重复组|读取受限/);
  await review.getByRole("tab", { name: "单色", exact: true }).click();
  await expect(cards).toHaveCount(3);
  await expect(selector.locator("option")).toHaveCount(1);
  await review.locator('[data-review-engine-card="mixed-2"]').click();
  await review.getByRole("button", { name: "采纳并前进", exact: true }).click();
  for (const name of ["全部", "线稿/草图", "单色"]) {
    await review.getByRole("tab", { name, exact: true }).click();
    await expect(cards).toHaveCount(3);
    await expect(review.locator('[data-review-engine-card="mixed-2"]')).toHaveAttribute("data-selected", "false");
    await expect(review.locator(".review-deck-statusbar")).toContainText("1 / 4 组已采纳");
  }
  // Legacy tasks without classification still show all groups; empty categories have no old type stats.
  groups.forEach((group) => group.classes.fill(""));
  version += 1;
  await review.getByRole("tab", { name: "全部", exact: true }).click();
  await expect(selector.locator("option")).toHaveCount(4);
  await selector.selectOption("unreadable");
  await expect(review.locator(".review-deck-header h2")).toHaveText("组 3 · 1 张图片");
  await expect(review.getByText("图片不可读", { exact: true })).toBeVisible();
  await review.getByRole("tab", { name: "线稿/草图", exact: true }).click();
  await expect(review.locator(".review-deck")).toHaveCount(0);
  await expect(review.locator(".review-panel dt")).toHaveText(["图片", "审核组", "图片不可读"]);
  await expect(review).not.toContainText(/独立图片|重复组|读取受限/);
  expect(api.unhandled).toEqual([]);
});
