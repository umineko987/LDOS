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
  "export",
  "personalization",
] as const;

export type AppId = (typeof APPLICATIONS)[number];

export function appWindow(page: Page, appId: string): Locator {
  return page.locator(`[data-app-window][data-app-id="${appId}"]`);
}

export async function prepareRichState(page: Page, appId: AppId): Promise<void> {
  const window = appWindow(page, appId);
  if (appId === "crawl") {
    await window.locator("[data-crawl-keyword]").fill("fixture");
    await window.getByRole("button", { name: "搜索来源" }).click();
    await expect(window.locator("[data-crawl-candidate]").first()).toBeVisible();
  } else if (appId === "tasks") {
    await window.getByRole("listbox", { name: "最近批次" }).selectOption("batch-running");
    await window.getByRole("button", { name: "查看所选批次" }).click();
    await expect(window.getByRole("heading", { name: "图片任务" })).toBeVisible();
  } else if (appId === "review") {
    await window.getByRole("combobox", { name: "已结束批次" }).selectOption("batch-review");
    await window.getByRole("button", { name: "打开审核" }).click();
    await expect(window.getByRole("heading", { name: /组 1/ })).toBeVisible();
    await expect(window.locator("[data-review-engine-image]").first()).toHaveAttribute("data-review-engine-decoded", "true");
  } else {
    const busy = window.locator("[aria-busy]").first();
    if (await busy.count()) await expect(busy).toHaveAttribute("aria-busy", "false");
  }
}
