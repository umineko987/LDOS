import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import { buildDatasetCrawl, searchDiscovery } from "./discovery.ts";

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

const candidate = {
  url: "https://danbooru.donmai.us/posts?tags=umehara_sei",
  label: "梅原生", address_type: "search", media_count: 12,
};

describe("discovery search failures", () => {
  it.each([
    { status: "failed", code: "search_timeout", message: "搜索超时，请检查网络连接或代理设置后重试" },
    { status: "partial", code: "search_incomplete", message: "扩展查询未完成，暂未取得候选；请重试或直接使用画师别名搜索" },
  ])("preserves $code separately from a successful search with no matches", async ({ status, code, message }) => {
    const api = createApi("http://127.0.0.1:8787", {
      fetchImpl: async () => json({
        response_profile: "desktop",
        sources: [
          { site: "exhentai", status, error: { code, message }, auth: { authorized: true }, addresses: [] },
          { site: "danbooru", status: "succeeded", error: { code: "", message: "" }, auth: { authorized: true }, addresses: [] },
        ],
      }),
    });
    const results = await searchDiscovery(api, { keyword: "梅原生", sites: ["exhentai", "danbooru"] });
    expect(results).toEqual([
      { site: "exhentai", status, error: message, needsAuth: false, candidates: [] },
      { site: "danbooru", status: "succeeded", error: null, needsAuth: false, candidates: [] },
    ]);
    expect(buildDatasetCrawl(results.flatMap((source) => source.candidates))).toBeNull();
  });

  it("retains usable candidates when another site times out and a partial site reports an error", async () => {
    const api = createApi("http://127.0.0.1:8787", {
      fetchImpl: async () => json({
        response_profile: "desktop",
        sources: [
          { site: "exhentai", status: "failed", error: { code: "search_timeout", message: "" }, auth: { authorized: true }, addresses: [] },
          { site: "danbooru", status: "succeeded", auth: { authorized: true }, addresses: [candidate] },
          {
            site: "pixiv", status: "partial", auth: { authorized: true },
            error: { code: "search_incomplete", message: "账号扩展未完成" },
            addresses: [{ url: "https://www.pixiv.net/users/123", id: "123", label: "画师", address_type: "user" }],
          },
        ],
      }),
    });
    const results = await searchDiscovery(api, { keyword: "梅原生", sites: ["exhentai", "danbooru", "pixiv"] });
    expect(results[0]).toMatchObject({ status: "failed", error: "search_timeout", needsAuth: false, candidates: [] });
    expect(results[1]).toMatchObject({ status: "succeeded", error: null });
    expect(results[2]).toMatchObject({ status: "partial", error: "账号扩展未完成" });
    const selected = results.flatMap((source) => source.candidates);
    expect(selected).toEqual([
      {
        key: "danbooru\nhttps://danbooru.donmai.us/posts?tags=umehara_sei", site: "danbooru",
        url: candidate.url, id: null, label: "梅原生", addressType: "search", mediaCount: 12, confidence: null,
      },
      {
        key: "pixiv\nhttps://www.pixiv.net/users/123", site: "pixiv",
        url: "https://www.pixiv.net/users/123", id: "123", label: "画师", addressType: "user", mediaCount: null, confidence: null,
      },
    ]);
    expect(buildDatasetCrawl(selected)?.sources).toEqual([
      {
        site: "danbooru", priority: 0, timeout_seconds: 180,
        addresses: [{ url: candidate.url, label: "梅原生", address_type: "search" }],
      },
      {
        site: "pixiv", priority: 0, timeout_seconds: 180,
        addresses: [{ url: "https://www.pixiv.net/users/123", id: "123", label: "画师", address_type: "user" }],
      },
    ]);
  });

  it("passes cancellation to fetch without turning it into empty results, and allows a fresh search", async () => {
    let started!: (request: Request) => void;
    const firstRequest = new Promise<Request>((resolve) => { started = resolve; });
    let requestCount = 0;
    const api = createApi("http://127.0.0.1:8787", {
      fetchImpl: async (request) => {
        requestCount++;
        if (requestCount === 1) {
          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
            started(request);
          });
        }
        return json({
          response_profile: "desktop",
          sources: [{ site: "danbooru", status: "succeeded", auth: { authorized: true }, addresses: [candidate] }],
        });
      },
    });
    const controller = new AbortController();
    const cancelled = searchDiscovery(api, { keyword: "old", sites: ["exhentai"] }, controller.signal);
    const rejection = expect(cancelled).rejects.toBeInstanceOf(DOMException);
    const request = await firstRequest;
    expect(request.signal.aborted).toBe(false);
    controller.abort();
    await rejection;
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(request.signal.aborted).toBe(true);

    const results = await searchDiscovery(api, { keyword: "梅原生", sites: ["danbooru"] });
    expect(requestCount).toBe(2);
    expect(results).toMatchObject([{ site: "danbooru", status: "succeeded", error: null, candidates: [{ addressType: "search", mediaCount: 12 }] }]);
  });
});
