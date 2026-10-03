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
  ];
  const summary = () => ({
    response_profile: "desktop-gallery-review-v1", review_id: "review-created-1", version, status: "ready", directories: [],
    totalImageCount: 6, totalGroupCount: 3, duplicateGroupCount: 2, unreadableImageCount: 1,
    automaticGroupCount: 0, automaticRejectedImageCount: 0, filteredImageCount: 0,
    selectedImageCount: decisions.has("mixed") ? 5 : 6, decidedGroupCount: decisions.size,
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
  await expect(selector.locator("option")).toHaveCount(3);
  await review.getByRole("tab", { name: "线稿/草图", exact: true }).click();
  await expect(cards).toHaveCount(3);
  await expect(selector.locator("option")).toHaveCount(2);
  await selector.selectOption("rough-pair");
  await expect(cards).toHaveCount(2);
  await review.getByRole("tab", { name: "单色", exact: true }).click();
  await expect(cards).toHaveCount(3);
  await expect(selector.locator("option")).toHaveCount(1);
  await review.locator('[data-review-engine-card="mixed-2"]').click();
  await review.getByRole("button", { name: "采纳并前进", exact: true }).click();
  for (const name of ["全部", "线稿/草图", "单色"]) {
    await review.getByRole("tab", { name, exact: true }).click();
    await expect(cards).toHaveCount(3);
    await expect(review.locator('[data-review-engine-card="mixed-2"]')).toHaveAttribute("data-selected", "false");
    await expect(review.locator(".review-deck-statusbar")).toContainText("1 / 3 组已采纳");
  }
  expect(api.unhandled).toEqual([]);
});
