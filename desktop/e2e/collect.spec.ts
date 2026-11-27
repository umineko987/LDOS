import type { components } from "../src/lib/api/schema";
import { mockApi } from "./fixtures/api";
import { FakeDatasets, PIXEL_PNG } from "./fixtures/datasets";
import { CRAWL_BATCH, CRAWL_TASKS, TASK_EVENTS, TASK_LOGS } from "./fixtures/jobs";
import { expect, test } from "./fixtures/test";

type Schemas = components["schemas"];

function makeItem(site: string, index: number, overrides: Partial<Schemas["CollectBrowseItem"]> = {}): Schemas["CollectBrowseItem"] {
  const id = `${site}-${index + 1}`;
  return {
    id,
    title: `${site.toUpperCase()} Work ${index + 1}`,
    author: "Artist",
    preview_url: `/api/v1/collect/media/fake.${id}`,
    width: 800,
    height: 1000,
    file_ext: "png",
    media_count: 1,
    url: `https://example.test/${site}/${id}`,
    downloadable: true,
    local_state: "none",
    ...overrides,
  };
}

test("默认勾选 Danbooru 并记忆图源勾选、跨源独立设范围、合并提交且保留状态", async ({ page }) => {
  const backend = new FakeDatasets();
  const dsId = backend.add({ name: "在线采集角色", kind: "character" });
  await backend.install(page);

  await page.route("**/api/v1/auth**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          { site: "danbooru", label: "Danbooru", method: "anonymous", state: "ready", authorized: true, summary: "OK", cookie_count: 0, updated_at: null, actions: {} },
          { site: "pixiv", label: "Pixiv", method: "oauth", state: "authorized", authorized: true, summary: "OK", cookie_count: 1, updated_at: null, actions: {} },
          { site: "exhentai", label: "ExHentai", method: "managed_browser", state: "authorized", authorized: true, summary: "OK", cookie_count: 2, updated_at: null, actions: {} },
        ],
        browser_profile: { exists: false, size_bytes: 0, resettable: false },
        authorization_proxy: { configured: false, mode: "direct", summary: "" },
        managed: true,
        secrets_exposed: false,
        response_profile: "vault",
      }),
    });
  });

  await mockApi(page, "get", "/api/v1/search/autocomplete", { items: [] });

  await page.route("**/api/v1/collect/media/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "Cross-Origin-Resource-Policy": "cross-origin" },
      body: PIXEL_PNG,
    });
  });

  const danSource: Schemas["CollectSourceSpec"] = {
    id: "danbooru:search:silver_hair",
    site: "danbooru",
    kind: "search",
    label: "silver_hair",
    query: "silver_hair",
    unit_kind: "post",
    default_mode: "top_n",
    default_top_n: 50,
  };
  const pixSource: Schemas["CollectSourceSpec"] = {
    id: "pixiv:timeline:42",
    site: "pixiv",
    kind: "timeline",
    label: "画师 42",
    url: "https://www.pixiv.net/users/42/artworks",
    unit_kind: "work",
    default_mode: "top_n",
    default_top_n: 50,
  };
  const ehSource: Schemas["CollectSourceSpec"] = {
    id: "exhentai:gallery:9",
    site: "exhentai",
    kind: "eh_gallery",
    label: "EH 画廊 #9",
    url: "https://exhentai.org/g/9/0123456789/",
    total: 45,
    unit_kind: "page",
    default_mode: "all",
  };

  let browseCalls = 0;
  let releaseFirstBrowse!: () => void;
  const firstBrowse = new Promise<void>((resolve) => (releaseFirstBrowse = resolve));
  let capturedSubmit: Schemas["CollectSubmitRequest"] | null = null;

  await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/collect/resolve", async (req) => {
    const body = req.postDataJSON() as Schemas["CollectResolveRequest"];
    if (body.input.includes("@alice_x")) {
      return {
        body: {
          resolved_mode: "url",
          sources: [
            {
              id: "twitter:timeline:alice_x",
              site: "twitter",
              kind: "timeline",
              label: "@alice_x",
              url: "https://x.com/alice_x/media",
              unit_kind: "work",
              default_mode: "top_n",
              default_top_n: 50,
              auto_enable: true,
            },
          ],
          site_statuses: [{ site: "twitter", authorized: true, state: "ready", summary: "OK" }],
          warnings: [],
        },
      };
    }
    return {
      body: {
        resolved_mode: "keyword",
        sources: [danSource, pixSource, ehSource],
        site_statuses: (body.sites ?? ["danbooru"]).map((site) => ({
          site,
          authorized: true,
          state: "ready",
          summary: "OK",
        })),
        warnings: [],
      },
    };
  });

  await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/collect/browse", async (req) => {
    browseCalls += 1;
    if (browseCalls === 1) await firstBrowse;
    const body = req.postDataJSON() as Schemas["CollectBrowseRequest"];
    if (body.source.site === "danbooru") {
      return {
        body: {
          source: body.source,
          items: Array.from({ length: 5 }, (_, i) => makeItem("dan", i)),
          next_cursor: "",
          total: 5,
          warnings: [],
        },
      };
    }
    if (body.source.site === "pixiv") {
      return {
        body: {
          source: body.source,
          items: Array.from({ length: 4 }, (_, i) => makeItem("pix", i)),
          next_cursor: "",
          warnings: [],
        },
      };
    }
    if (body.source.site === "exhentai") {
      return {
        body: {
          source: body.source,
          items: Array.from({ length: 3 }, (_, i) =>
            makeItem("eh", i, { id: String(i + 1), page: i + 1 }),
          ),
          next_cursor: "3",
          total: 45,
          warnings: [],
        },
      };
    }
    return {
      body: {
        source: body.source,
        items: [makeItem(body.source.site, 0)],
        next_cursor: "",
        warnings: [],
      },
    };
  });

  await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/collect/submit", async (req) => {
    capturedSubmit = req.postDataJSON() as Schemas["CollectSubmitRequest"];
    return {
      body: {
        batch_id: "batch-7",
        queued_sources: capturedSubmit.sources.length,
        queued_count: 140,
        reused_count: 0,
        skipped_count: 0,
      },
    };
  });

  await mockApi(page, "get", "/api/v1/crawls/{batch_id}", CRAWL_BATCH);
  await mockApi(page, "get", "/api/v1/crawls/{batch_id}/tasks", CRAWL_TASKS);
  await mockApi(page, "get", "/api/v1/tasks/{task_id}/logs", TASK_LOGS);
  await mockApi(page, "get", "/api/v1/tasks/{task_id}/events", TASK_EVENTS);

  await page.goto(`/#/datasets/${dsId}/collect`);
  await page.getByTestId("collect-add-crawl").click();

  const dialog = page.getByTestId("collect-workbench");
  await expect(dialog).toBeVisible();

  // 1. 默认只勾选 Danbooru
  await expect(dialog.locator('[data-collect-site="danbooru"]')).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator('[data-collect-site="pixiv"]')).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.locator('[data-collect-site="exhentai"]')).toHaveAttribute("aria-pressed", "false");

  // 勾选 Pixiv 和 EH，刷新后仍记住
  await dialog.locator('[data-collect-site="pixiv"]').click();
  await dialog.locator('[data-collect-site="exhentai"]').click();
  await page.reload();
  await page.getByTestId("collect-add-crawl").click();
  await expect(dialog.locator('[data-collect-site="danbooru"]')).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator('[data-collect-site="pixiv"]')).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator('[data-collect-site="exhentai"]')).toHaveAttribute("aria-pressed", "true");

  // 2. 搜索关键词，进入多源工作台
  await dialog.getByTestId("collect-omnibox").fill("silver_hair");
  await dialog.getByTestId("collect-resolve-btn").click();

  const rail = dialog.getByTestId("collect-source-rail");
  await expect(rail.locator('[data-source-id="danbooru:search:silver_hair"]')).toBeVisible();
  await expect(rail.locator('[data-source-id="pixiv:timeline:42"]')).toBeVisible();
  await expect(rail.locator('[data-source-id="exhentai:gallery:9"]')).toBeVisible();

  // 在首屏未返回时切源，再切回来应重新加载，而不是永久显示加载中。
  await expect.poll(() => browseCalls).toBe(1);
  await rail.locator('[data-source-id="pixiv:timeline:42"]').getByRole("button").click();
  await expect(dialog.locator('[data-collect-card="pix-1"]')).toBeVisible();
  releaseFirstBrowse();
  await rail.locator('[data-source-id="danbooru:search:silver_hair"]').getByRole("button").click();
  await expect(dialog.locator('[data-collect-card="dan-1"]')).toBeVisible();
  // Danbooru 点第 1 项 + Shift 点第 3 项 -> 选中 1..3 项
  await dialog.locator('[data-collect-card="dan-1"]').click();
  await dialog.locator('[data-collect-card="dan-3"]').click({ modifiers: ["Shift"] });
  await expect(dialog.locator('[data-collect-card="dan-1"]')).toHaveAttribute("data-selected", "true");
  await expect(dialog.locator('[data-collect-card="dan-2"]')).toHaveAttribute("data-selected", "true");
  await expect(dialog.locator('[data-collect-card="dan-3"]')).toHaveAttribute("data-selected", "true");

  // 切到 Pixiv，勾选启用（默认前 50），排除第 2 项
  const pixRow = rail.locator('[data-source-id="pixiv:timeline:42"]');
  await pixRow.getByRole("button").click();
  await pixRow.getByRole("checkbox").click();
  await expect(dialog.locator('[data-collect-card="pix-1"]')).toHaveAttribute("data-selected", "true");
  await dialog.locator('[data-collect-card="pix-2"]').click();
  await expect(dialog.locator('[data-collect-card="pix-2"]')).toHaveAttribute("data-excluded", "true");

  // 切到 EH，开启页码范围 5–42（无需翻完 45 页缩略图），并记下 browse 次数未多出额外页
  const ehRow = rail.locator('[data-source-id="exhentai:gallery:9"]');
  await ehRow.getByRole("button").click();
  await ehRow.getByRole("checkbox").click();
  const browseBeforeRange = browseCalls;
  await dialog.getByTestId("collect-range-bar").getByRole("button", { name: "页码范围" }).click();
  await dialog.getByTestId("collect-page-start").fill("5");
  await dialog.getByTestId("collect-page-start").dispatchEvent("change");
  await dialog.getByTestId("collect-page-end").fill("42");
  await dialog.getByTestId("collect-page-end").dispatchEvent("change");
  await expect(ehRow).toContainText("P5–42");
  expect(browseCalls).toBe(browseBeforeRange);

  // 切回 Danbooru，之前的 3 张选中状态仍然保留
  await rail.locator('[data-source-id="danbooru:search:silver_hair"]').getByRole("button").click();
  await expect(dialog.locator('[data-collect-card="dan-1"]')).toHaveAttribute("data-selected", "true");
  await expect(dialog.locator('[data-collect-card="dan-3"]')).toHaveAttribute("data-selected", "true");

  // 3. 粘贴 @alice_x 链接模式自动隐藏站点勾选条并追加来源
  await dialog.getByTestId("collect-omnibox").fill("@alice_x");
  await expect(dialog.getByTestId("collect-site-pills")).toHaveCount(0);
  await dialog.getByTestId("collect-resolve-btn").click();
  await expect(rail.locator('[data-source-id="twitter:timeline:alice_x"]')).toBeVisible();

  // 4. 单次提交合并 4 个来源，Toast 点击跳转
  await dialog.getByTestId("collect-submit-btn").click();
  await expect(dialog).toHaveCount(0);
  expect(capturedSubmit).not.toBeNull();
  expect(capturedSubmit!.sources).toHaveLength(4);
  expect(capturedSubmit!.sources.find((s) => s.source.id === "danbooru:search:silver_hair")?.range).toMatchObject({
    mode: "explicit",
  });
  expect(capturedSubmit!.sources.find((s) => s.source.id === "pixiv:timeline:42")?.range).toEqual({
    mode: "top_n",
    top_n: 50,
    excluded_ids: ["pix-2"],
  });
  expect(capturedSubmit!.sources.find((s) => s.source.id === "exhentai:gallery:9")?.range).toEqual({
    mode: "pages",
    page_start: 5,
    page_end: 42,
  });
  expect(capturedSubmit!.sources.find((s) => s.source.id === "twitter:timeline:alice_x")?.range).toEqual({
    mode: "top_n",
    top_n: 50,
  });

  await page.getByRole("button", { name: "查看" }).click();
  await expect(page).toHaveURL("#/jobs/crawls/batch-7");
});
