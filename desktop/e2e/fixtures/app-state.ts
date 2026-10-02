import { expect, type Locator, type Page } from "@playwright/test";

export const APPLICATIONS = [
  "crawl",
  "tasks",
  "gallery",
  "review",
  "vault",
  "proxy",
  "policy",
  "diagnostics",
  "personalization",
] as const;

export type AppId = (typeof APPLICATIONS)[number];

export function appPage(page: Page, appId: string): Locator {
  return page.locator(`[data-app-page][data-app-id="${appId}"]`);
}

export async function prepareRichState(page: Page, appId: AppId): Promise<void> {
  const app = appPage(page, appId);
  if (appId === "crawl") {
    await app.locator("[data-crawl-keyword]").fill("fixture");
    const suggestion = app.getByRole("option", { name: /Fixture Artist/ });
    await expect(suggestion).toBeVisible();
    await suggestion.click();
    await app.getByRole("button", { name: "搜索来源" }).click();
    await expect(app.locator("[data-crawl-candidate]").first()).toBeVisible();
  } else if (appId === "tasks") {
    await app.getByRole("listbox", { name: "最近批次" }).selectOption("batch-running");
    await app.getByRole("button", { name: "查看所选批次" }).click();
    await expect(app.getByRole("heading", { name: "图片任务" })).toBeVisible();
  } else if (appId === "review") {
    await app.getByRole("combobox", { name: "已提交审核任务" }).selectOption("review-fixture");
    await expect(app.getByRole("heading", { name: /组 1/ })).toBeVisible();
    await expect(app.locator("[data-review-engine-image]").first()).toHaveAttribute("data-review-engine-decoded", "true");
  } else if (appId === "gallery") {
    await app.locator(".gallery-source").filter({ hasText: "E2E 导入目录" }).click();
    await expect(app.locator('[data-gallery-asset="gal-asset-01"]')).toBeVisible();
  } else {
    const busy = app.locator("[aria-busy]").first();
    if (await busy.count()) await expect(busy).toHaveAttribute("aria-busy", "false");
  }
}
