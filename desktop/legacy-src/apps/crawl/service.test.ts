import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../core/api/client";
import { sanitizeCrawlSearchResponse, type CrawlDraft, type SearchDraft } from "./model";
import { CRAWL_ENDPOINTS, autocompletePath, createCrawlService } from "./service";

const searchDraft: SearchDraft = {
  keyword: "stage 4",
  sites: ["danbooru"],
  limit: 20,
  proxyMode: "required",
  sourceProxyModes: {},
};
const crawlDraft: CrawlDraft = {
  concurrency: 20,
  maxTasks: 10_000,
  proxyMode: "required",
  outputDir: "",
  sourceProxyModes: {},
  ehDownload: { image_mode: "original", gp_policy: "stop" },
};

function client(responses: unknown[]) {
  return {
    get: vi.fn(async () => responses.shift()),
    post: vi.fn(async () => responses.shift()),
  } as unknown as ApiClient & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };
}

describe("Crawl API service", () => {
  it("uses only the three frozen endpoints and URL-encodes autocomplete", () => {
    expect(CRAWL_ENDPOINTS).toEqual({
      search: "/api/v1/search",
      autocomplete: "/api/v1/search/autocomplete",
      crawls: "/api/v1/crawls",
    });
    expect(autocompletePath("柠檬 静&x")).toBe(
      "/api/v1/search/autocomplete?q=%E6%9F%A0%E6%AA%AC%20%E9%9D%99%26x&limit=10",
    );
    expect(() => autocompletePath("x")).toThrow("invalid_autocomplete_query");
  });

  it("uses GET autocomplete, POST search, and POST create with exact bodies/signals", async () => {
    const rawSearch = {
      sources: [{
        site: "danbooru",
        status: "succeeded",
        enrichment_error_count: 7,
        addresses: [{
          id: "one",
          label: "One",
          address_type: "artist_tag",
          url: "https://danbooru.donmai.us/posts?tags=one",
          related_profile_count: 9,
        }],
        weak_evidence: [],
      }],
    };
    const api = client([
      { items: [{ value: "one", label: "One", category: "artist" }] },
      rawSearch,
      { id: "batch:stage4", output_dir: "/private/never" },
    ]);
    const service = createCrawlService(api);
    const controller = new AbortController();
    await expect(service.autocomplete("one", controller.signal)).resolves.toEqual([
      expect.objectContaining({ value: "one" }),
    ]);
    const projection = await service.search(searchDraft, controller.signal);
    const key = "candidate:danbooru:one" as const;
    expect(projection.snapshot.sources[projection.snapshot.sourceOrder[0]]?.enrichmentIssueCount).toBe(7);
    expect(projection.snapshot.candidates[key]?.relatedProfileCount).toBe(9);
    const selected = {
      ...projection.snapshot,
      candidates: {
        ...projection.snapshot.candidates,
        [key]: { ...projection.snapshot.candidates[key], selected: true },
      },
    };
    await expect(service.create(selected, projection.operations, crawlDraft, controller.signal))
      .resolves.toEqual({ id: "batch:stage4" });
    expect(api.get).toHaveBeenCalledWith(
      "/api/v1/search/autocomplete?q=one&limit=10",
      { signal: controller.signal },
    );
    expect(api.post.mock.calls).toEqual([
      [`${CRAWL_ENDPOINTS.search}?view=desktop`, {
        keyword: "stage 4",
        sites: ["danbooru"],
        limit: 20,
        proxy_mode: "required",
        source_options: {},
      }, { signal: controller.signal }],
      [`${CRAWL_ENDPOINTS.crawls}?view=desktop`, {
        sources: [{
          site: "danbooru",
          addresses: [{
            url: "https://danbooru.donmai.us/posts?tags=one",
            id: "one",
            label: "One",
            address_type: "artist_tag",
          }],
        }],
        concurrency: 20,
        max_tasks: 10_000,
        proxy_mode: "required",
      }, { signal: controller.signal, idempotencyKey: true }],
    ]);
  });

  it("sanitizes before returning and rejects malformed authority responses", async () => {
    const api = client([{ sources: null }]);
    const service = createCrawlService(api);
    await expect(service.search(searchDraft, new AbortController().signal))
      .rejects.toThrow("invalid_crawl_search_response");
    expect(() => sanitizeCrawlSearchResponse({ sources: null })).toThrow();
  });
});
