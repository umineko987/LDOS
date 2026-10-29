import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import {
  buildDatasetCrawl,
  DISCOVERY_MAX_SITES,
  discoveryKeys,
  discoverySitesQuery,
  sanitizeDiscoveryResponse,
  searchDiscovery,
  type DiscoveryCandidate,
} from "./discovery.ts";

function fakeApi(body: unknown) {
  const requests: Request[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      requests.push(request.clone());
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  return { api, requests };
}

const RESPONSE = {
  response_profile: "desktop",
  sources: [
    {
      site: "pixiv",
      status: "ok",
      addresses: [
        {
          url: "https://www.pixiv.net/users/1",
          id: "1",
          label: "画师\u0007一",
          address_type: "user",
          media_count: 120,
          confidence: "high",
        },
        { url: "https://www.pixiv.net/users/1", label: "重复" },
        { url: "javascript:alert(1)", label: "坏地址" },
        { url: "not a url" },
        { url: "https://www.pixiv.net/tags/cat", title: "cat 标签", media_count: -1 },
        { url: "https://www.pixiv.net/tags/dog", tag: "dog" },
        { url: "http://example.com/x" },
      ],
    },
    { site: "danbooru", status: "failed", error: { code: "timeout", message: "" }, auth: { authorized: false } },
    { site: "gelbooru", error: { message: "超时了" } },
    { site: "", addresses: [] },
    null,
  ],
};

describe("sanitizeDiscoveryResponse", () => {
  it("只保留能采集的 http(s) 地址并去重", () => {
    const [pixiv, danbooru, gelbooru, ...rest] = sanitizeDiscoveryResponse(RESPONSE);
    expect(rest).toEqual([]);
    expect(pixiv).toMatchObject({ site: "pixiv", status: "ok", error: null, needsAuth: false });
    expect(pixiv!.candidates).toEqual([
      {
        key: "pixiv\nhttps://www.pixiv.net/users/1",
        site: "pixiv",
        url: "https://www.pixiv.net/users/1",
        id: "1",
        label: "画师 一",
        addressType: "user",
        mediaCount: 120,
        confidence: "high",
      },
      expect.objectContaining({ label: "cat 标签", mediaCount: null, id: null, addressType: null, confidence: null }),
      expect.objectContaining({ label: "dog" }),
      expect.objectContaining({ label: "http://example.com/x", url: "http://example.com/x" }),
    ]);
    expect(danbooru).toMatchObject({ status: "failed", error: "timeout", needsAuth: true, candidates: [] });
    expect(gelbooru).toMatchObject({ status: "ok", error: "超时了" });
  });

  it("拒绝非 desktop 视图", () => {
    expect(() => sanitizeDiscoveryResponse({ response_profile: "legacy" })).toThrow("invalid_discovery_response");
    expect(() => sanitizeDiscoveryResponse(null)).toThrow("invalid_discovery_response");
    expect(sanitizeDiscoveryResponse({ response_profile: "desktop" })).toEqual([]);
  });

  it("超长地址不要", () => {
    const long = `https://example.com/${"a".repeat(9000)}`;
    const [source] = sanitizeDiscoveryResponse({ response_profile: "desktop", sources: [{ site: "x", addresses: [{ url: long }] }] });
    expect(source!.candidates).toEqual([]);
  });
});

describe("discovery requests", () => {
  it("站点列表规范化别名，丢掉空站点", async () => {
    const { api, requests } = fakeApi({
      items: [
        { site: "pixiv", aliases: ["px", ""], authentication: "optional" },
        { site: "", aliases: [] },
        { site: "danbooru" },
      ],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(discoverySitesQuery(api))).resolves.toEqual([
      { site: "pixiv", aliases: ["px"], authentication: "optional" },
      { site: "danbooru", aliases: [], authentication: "" },
    ]);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/search/sites");
    expect(discoveryKeys.sites()).toEqual(["discovery", "sites"]);

    const empty = fakeApi({});
    await expect(client.fetchQuery({ ...discoverySitesQuery(empty.api), queryKey: ["other"] as never })).resolves.toEqual([]);
  });

  it("搜索带 view=desktop，关键词去空白，站点截到上限", async () => {
    const { api, requests } = fakeApi(RESPONSE);
    const sites = ["a", "b", "c", "d", "e", "f", "g"];
    const results = await searchDiscovery(api, { keyword: "  猫  ", sites });
    expect(results).toHaveLength(3);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).searchParams.get("view")).toBe("desktop");
    expect(await request.json()).toEqual({
      keyword: "猫",
      sites: sites.slice(0, DISCOVERY_MAX_SITES),
      limit: 20,
      timeout_seconds: 180,
    });
  });
});

describe("buildDatasetCrawl", () => {
  const candidate = (site: string, url: string, extra: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate => ({
    key: `${site}\n${url}`,
    site,
    url,
    id: null,
    label: url,
    addressType: null,
    mediaCount: null,
    confidence: null,
    ...extra,
  });

  it("按站点分组，只带有值的可选字段", () => {
    expect(buildDatasetCrawl([])).toBeNull();
    expect(
      buildDatasetCrawl([
        candidate("pixiv", "https://p/1", { id: "1", label: "画师", addressType: "user" }),
        candidate("danbooru", "https://d/cat"),
        candidate("pixiv", "https://p/2"),
      ]),
    ).toEqual({
      concurrency: 20,
      max_tasks: 10_000,
      priority: 0,
      timeout_seconds: 180,
      sources: [
        {
          site: "pixiv",
          priority: 0,
          timeout_seconds: 180,
          addresses: [
            { url: "https://p/1", id: "1", label: "画师", address_type: "user" },
            { url: "https://p/2" },
          ],
        },
        { site: "danbooru", priority: 0, timeout_seconds: 180, addresses: [{ url: "https://d/cat" }] },
      ],
    });
  });
});
