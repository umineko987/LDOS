import { appPage } from "./fixtures/app-state";
import { bootDesktop, expect, launchApp, test } from "./fixtures/test";

const APPLICATION_LABELS = {
  crawl: ["Collect", "Sources and order"],
  tasks: ["Batch", "Recent batches"],
  proxy: ["Proxy", "Runtime status"],
  vault: ["Authorization", "Choose a site"],
  review: ["Deduplication", "No deduplication task yet"],
  policy: ["Site", "Choose a site"],
  diagnostics: ["Diagnostics", "Connection and checks"],
  personalization: ["Appearance", "Workbench palette"],
  gallery: ["Gallery", "Sources and folders"],
} as const;
const USER_CONTENT = ["画师作品", "E2E 导入目录"] as const;

function containsUntranslatedUi(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(USER_CONTENT.reduce((result, content) => result.replaceAll(content, ""), value));
}

test("语言按钮默认中文，工作台及全部业务页可在中英文间切换", async ({ page }) => {
  await bootDesktop(page);
  const languageToggle = page.locator("[data-language-toggle]");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(languageToggle).toHaveText("EN");
  await expect(languageToggle).toHaveAccessibleName("切换到英文");
  await expect(page.locator('[data-nav-app="crawl"]')).toContainText("采集");

  await languageToggle.click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(languageToggle).toHaveText("ZH");
  await expect(languageToggle).toHaveAccessibleName("Switch to Chinese");
  await expect(page.locator('[data-nav-app="crawl"]')).toContainText("Collect");
  await expect(page.locator("[data-nav-settings]")).toContainText("Settings");
  await expect(page.locator("[data-about-trigger]")).toHaveAccessibleName("About LDOS");
  await languageToggle.evaluate((element) => (element as HTMLElement).blur());

  for (const [appId, labels] of Object.entries(APPLICATION_LABELS)) {
    await launchApp(page, appId);
    const app = appPage(page, appId);
    await expect(app.getByRole("heading", { name: labels[0], exact: true }).first()).toBeVisible();
    await expect(app.getByRole("heading", { name: labels[1], exact: true }).first()).toBeVisible();
    const untranslatedAttributes = await app.locator("*").evaluateAll((elements) =>
      Array.from(new Set(elements.flatMap((element) =>
        ["aria-label", "title", "placeholder", "alt"]
          .map((name) => element.getAttribute(name))
          .filter((value): value is string => Boolean(value && /[\u3400-\u9fff]/u.test(value))),
      ))),
    );
    expect(untranslatedAttributes.filter(containsUntranslatedUi), `${appId} contains untranslated attributes`).toEqual([]);
    const untranslatedPseudoContent = await app.locator("*").evaluateAll((elements) =>
      Array.from(new Set(elements.flatMap((element) =>
        ["::before", "::after"]
          .map((pseudo) => getComputedStyle(element, pseudo).content)
          .filter((value) => /[\u3400-\u9fff]/u.test(value)),
      ))),
    );
    expect(untranslatedPseudoContent, `${appId} contains untranslated generated content`).toEqual([]);
    const untranslatedText = await app.evaluate((root) => {
      const values: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.textContent?.replace(/\s+/gu, " ").trim();
        if (value && /[\u3400-\u9fff]/u.test(value)) values.push(value);
      }
      return Array.from(new Set(values));
    });
    expect(untranslatedText.filter(containsUntranslatedUi), `${appId} contains untranslated text`).toEqual([]);
    if (appId === "gallery") await expect(app.getByText("E2E 导入目录", { exact: true })).toBeVisible();
  }

  await launchApp(page, "crawl");
  await languageToggle.click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator('[data-nav-app="crawl"]')).toContainText("采集");
  await expect(appPage(page, "crawl").getByRole("heading", { name: "采集", exact: true })).toBeVisible();
  await expect(appPage(page, "crawl").getByRole("heading", { name: "来源与顺序", exact: true })).toBeVisible();
  await launchApp(page, "personalization");
  await expect(appPage(page, "personalization").getByRole("heading", { name: "工作台配色", exact: true })).toBeVisible();
});
