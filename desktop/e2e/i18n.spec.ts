import { bootDesktop, expect, test } from "./fixtures/test";

const APPLICATION_LABELS = {
  crawl: ["Image Collection", "Sources and connections"],
  tasks: ["Batch Management", "Recent batches"],
  proxy: ["Proxy Management", "Status overview"],
  vault: ["Authorization", "Authorization targets"],
  review: ["Deduplication Review", "Finished batches"],
  policy: ["Site Settings", "Site setting sources"],
  diagnostics: ["System Diagnostics", "Connection and checks"],
  personalization: ["Appearance", "Built-in night scenes"],
  gallery: ["Gallery", "Sources and folders"],
} as const;
const USER_CONTENT = ["画师作品", "E2E 导入目录"] as const;

function containsUntranslatedUi(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(USER_CONTENT.reduce((result, content) => result.replaceAll(content, ""), value));
}

test("顶栏语言按钮默认中文，并可让全部应用在中英文之间切换", async ({ page }) => {
  await bootDesktop(page);

  const languageToggle = page.locator("[data-language-toggle]");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(languageToggle).toHaveText("EN");
  await expect(languageToggle).toHaveAccessibleName("切换到英文");
  await expect(page.locator('[data-menu-trigger="file"]')).toHaveText("文件");

  await languageToggle.click();

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(languageToggle).toHaveText("ZH");
  await expect(languageToggle).toHaveAccessibleName("Switch to Chinese");
  await expect(page.locator('[data-menu-trigger="file"]')).toHaveText("File");
  await expect(page.locator('[data-menu-trigger="edit"]')).toHaveText("Edit");
  await expect(page.locator('[data-menu-trigger="view"]')).toHaveText("View");
  await languageToggle.evaluate((element) => (element as HTMLElement).blur());

  for (const [appId, labels] of Object.entries(APPLICATION_LABELS)) {
    await page.getByRole("button", { name: /Application Center; Open the full application list/ }).click();
    const center = page.locator("[data-application-center]");
    await expect(center).toBeVisible();
    await expect(center.getByRole("heading", { name: "Application Center" })).toBeVisible();
    await center.locator(`[data-application-center-app="${appId}"]`).click();

    const appWindow = page.locator(`[data-app-window][data-app-id="${appId}"]`);
    await expect(appWindow).toBeVisible();
    await expect(appWindow.getByText(labels[0], { exact: true }).first()).toBeVisible();
    await expect(appWindow.getByText(labels[1], { exact: true }).first()).toBeVisible();
    const untranslatedAttributes = await appWindow.locator("*").evaluateAll((elements) =>
      Array.from(new Set(elements.flatMap((element) =>
        ["aria-label", "title", "placeholder", "alt"]
          .map((name) => element.getAttribute(name))
          .filter((value): value is string => Boolean(value && /[\u3400-\u9fff]/u.test(value))),
      ))),
    );
    expect(untranslatedAttributes.filter(containsUntranslatedUi), `${appId} contains untranslated attributes`).toEqual([]);
    const untranslatedPseudoContent = await appWindow.locator("*").evaluateAll((elements) =>
      Array.from(new Set(elements.flatMap((element) =>
        ["::before", "::after"]
          .map((pseudo) => getComputedStyle(element, pseudo).content)
          .filter((value) => /[\u3400-\u9fff]/u.test(value)),
      ))),
    );
    expect(untranslatedPseudoContent, `${appId} contains untranslated generated content`).toEqual([]);
    const untranslatedText = await appWindow.evaluate((root) => {
      const values: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.textContent?.replace(/\s+/gu, " ").trim();
        if (value && /[\u3400-\u9fff]/u.test(value)) values.push(value);
      }
      return Array.from(new Set(values));
    });
    expect(
      untranslatedText.filter(containsUntranslatedUi),
      `${appId} contains untranslated text`,
    ).toEqual([]);
    if (appId === "gallery") {
      await expect(appWindow.getByText("E2E 导入目录", { exact: true })).toBeVisible();
    }
    await appWindow.getByRole("button", { name: "Close window" }).click();
    await expect(appWindow).toHaveCount(0);
  }

  await page.getByRole("button", { name: /Application Center; Open the full application list/ }).click();
  await page.locator('[data-application-center-app="crawl"]').click();
  const crawlWindow = page.locator('[data-app-window][data-app-id="crawl"]');

  await languageToggle.click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator('[data-menu-trigger="file"]')).toHaveText("文件");
  await expect(crawlWindow.getByText("图片采集", { exact: true }).first()).toBeVisible();
  await expect(crawlWindow.getByText("来源与连接", { exact: true }).first()).toBeVisible();
  await crawlWindow.getByRole("button", { name: "关闭窗口" }).click();
});
