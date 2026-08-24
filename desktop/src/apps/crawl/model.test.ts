import { describe, expect, it } from "vitest";

import {
  buildCrawlPayload,
  buildSearchPayload,
  candidateMatchesEhFilter,
  crawlErrorPresentation,
  parseEhTag,
  sanitizeAutocompleteResponse,
  sanitizeCreatedCrawl,
  sanitizeCrawlSearchResponse,
  selectedCandidateKeys,
  validateCrawlDraft,
  validateSearchDraft,
  visibleCandidateKeys,
  type CrawlDraft,
  type SearchDraft,
} from "./model";

const SECRET = "crawl-secret-token-314159";

function candidate(id: string, url: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: `候选 ${id}`,
    address_type: "account",
    url,
    confidence: "verified",
    media_count: 2,
    evidence_reasons: ["site_search_work_evidence"],
    metadata: {},
    ...overrides,
  };
}

function response() {
  return {
    keyword: "stage4",
    source_count: 2,
    sources: [{
      site: "danbooru",
      status: "succeeded",
      evidence_count: 2,
      preview_count: 2,
      attempts: 1,
      auth: { state: "public", authorized: true },
      addresses: [
        candidate("artist-one", "https://danbooru.donmai.us/posts?tags=artist_one"),
        candidate("artist-two", "https://danbooru.donmai.us/posts?tags=artist_two"),
      ],
      weak_evidence: [],
    }, {
      site: "exhentai",
      status: "partial",
      attempts: 2,
      auth: { state: "required", authorized: false, cookie: SECRET },
      error: { code: "preview_failed", message: `failed https://private.invalid/${SECRET}` },
      enrichment_errors: [{ message: SECRET }],
      addresses: [candidate(
        "gallery-one",
        `https://e-hentai.org/g/3001/a000000001/?token=${SECRET}`,
        {
          address_type: "gallery",
          thumbnail_url: "https://ehgt.org/w/stage4.webp",
          metadata: { tags: ["artist:stage4", "language:chinese"] },
        },
      )],
      weak_evidence: [candidate(
        "gallery-two",
        "https://e-hentai.org/g/3002/a000000002/",
        { confidence: "weak", metadata: { tags: ["artist:other"] } },
      )],
      tag_facets: [{
        namespace: "artist",
        label: "画师",
        gallery_count: 2,
        tags: [{ tag: "artist:stage4", count: 1 }, { tag: "artist:other", count: 1 }],
      }],
    }],
    related_profiles: [{
      artist_name: "Safe",
      platform: "pixiv",
      url: "https://www.pixiv.net/users/303",
    }, {
      artist_name: "Unsafe",
      platform: "twitter",
      url: `https://user:${SECRET}@x.com/private?token=${SECRET}`,
    }],
    raw: SECRET,
  };
}

const searchDraft = Object.freeze<SearchDraft>({
  keyword: " stage 4 ",
  sites: ["exhentai", "danbooru", "exhentai"],
  limit: 37,
  proxyMode: "prefer",
  sourceProxyModes: { danbooru: "direct", exhentai: "required", pixiv: "direct" },
});

const crawlDraft = Object.freeze<CrawlDraft>({
  concurrency: 20,
  maxTasks: 10_000,
  proxyMode: "required",
  outputDir: "stage4/output",
  sourceProxyModes: { danbooru: "direct" },
  ehDownload: { image_mode: "original", gp_policy: "stop" },
});

describe("Crawl runtime sanitizer and payloads", () => {
  it("uses stable business keys, normalized entity maps, and a separate operational URL map", () => {
    const first = sanitizeCrawlSearchResponse(response());
    const second = sanitizeCrawlSearchResponse(response());
    expect(first.snapshot.sourceOrder).toEqual(["source:danbooru", "source:exhentai"]);
    expect(Object.keys(first.snapshot.sources)).toEqual(["source:danbooru", "source:exhentai"]);
    expect(first.snapshot.candidateOrder["source:danbooru"]).toEqual([
      "candidate:danbooru:artist-one",
      "candidate:danbooru:artist-two",
    ]);
    expect(first.snapshot.candidateOrder).toEqual(second.snapshot.candidateOrder);
    expect(first.snapshot).toMatchObject({ addressCount: 3, weakEvidenceCount: 1, showWeakEvidence: false });
    expect(first.operations.size).toBe(4);
    expect(first.operations.get("candidate:exhentai:gallery-one")?.url).toContain("token=");
    const serialized = JSON.stringify(first.snapshot);
    for (const forbidden of [SECRET, "e-hentai.org/g/", "danbooru.donmai.us/posts", "raw", "cookie"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(first.snapshot.candidates["candidate:exhentai:gallery-one"]).toMatchObject({
      displayEndpoint: "e-hentai.org · 画廊 3001 · 访问令牌已隐藏",
      thumbnailUrl: "https://ehgt.org/w/stage4.webp",
      selected: false,
    });
    expect(first.snapshot.sources["source:exhentai"].errorMessage).toContain("[地址已隐藏]");
    expect(first.snapshot.relatedProfiles).toEqual([expect.objectContaining({ artist: "Safe", host: "pixiv.net" })]);
  });

  it("builds the exact search body in canonical site order", () => {
    expect(buildSearchPayload(searchDraft)).toEqual({
      keyword: "stage 4",
      sites: ["danbooru", "exhentai"],
      limit: 37,
      proxy_mode: "prefer",
      source_options: {
        danbooru: { proxy_mode: "direct" },
        exhentai: { proxy_mode: "required" },
      },
    });
    expect(validateSearchDraft(searchDraft).valid).toBe(true);
    expect(validateSearchDraft({ ...searchDraft, keyword: "" }).field).toBe("keyword");
    expect(validateSearchDraft({ ...searchDraft, sites: [] }).field).toBe("sites");
    expect(validateSearchDraft({ ...searchDraft, limit: 201 }).field).toBe("search-limit");
    expect(validateSearchDraft({ ...searchDraft, proxyMode: "bad" as never }).field).toBe("search-proxy");
  });

  it("preserves selected source/candidate order in the exact create body", () => {
    const projection = sanitizeCrawlSearchResponse(response());
    const danbooru = "candidate:danbooru:artist-two" as const;
    const eh = "candidate:exhentai:gallery-one" as const;
    const snapshot = {
      ...projection.snapshot,
      sourceOrder: ["source:exhentai", "source:danbooru"] as const,
      candidates: {
        ...projection.snapshot.candidates,
        [danbooru]: { ...projection.snapshot.candidates[danbooru], selected: true },
        [eh]: { ...projection.snapshot.candidates[eh], selected: true },
      },
    };
    expect(selectedCandidateKeys(snapshot)).toEqual([eh, danbooru]);
    expect(buildCrawlPayload(snapshot, projection.operations, crawlDraft)).toEqual({
      sources: [{
        site: "exhentai",
        addresses: [{
          url: `https://e-hentai.org/g/3001/a000000001/?token=${SECRET}`,
          id: "gallery-one",
          label: "候选 gallery-one",
          address_type: "gallery",
        }],
        eh_download: { image_mode: "original", gp_policy: "stop" },
      }, {
        site: "danbooru",
        addresses: [{
          url: "https://danbooru.donmai.us/posts?tags=artist_two",
          id: "artist-two",
          label: "候选 artist-two",
          address_type: "account",
        }],
        proxy_mode: "direct",
      }],
      concurrency: 20,
      max_tasks: 10_000,
      proxy_mode: "required",
      output_dir: "stage4/output",
    });
    expect(() => buildCrawlPayload({ ...snapshot, candidates: {
      ...snapshot.candidates,
      [eh]: { ...snapshot.candidates[eh], selected: false },
      [danbooru]: { ...snapshot.candidates[danbooru], selected: false },
    } }, projection.operations, crawlDraft)).toThrow("至少选择一个采集来源");
    expect(() => buildCrawlPayload(snapshot, new Map(), crawlDraft)).toThrow("选中的地址已失效");
  });

  it("filters EH candidates with include/exclude semantics and weak visibility", () => {
    const projection = sanitizeCrawlSearchResponse(response());
    const source = "source:exhentai" as const;
    const candidate = projection.snapshot.candidates["candidate:exhentai:gallery-one"];
    expect(parseEhTag("a:Stage4")).toEqual({ namespace: "artist", value: "Stage4", key: "artist:stage4" });
    expect(candidateMatchesEhFilter(candidate, { "artist:stage4": "include" })).toBe(true);
    expect(candidateMatchesEhFilter(candidate, { "language:english": "include" })).toBe(false);
    expect(candidateMatchesEhFilter(candidate, {
      "artist:stage4": "include",
      "language:chinese": "exclude",
    })).toBe(false);
    expect(visibleCandidateKeys(projection.snapshot, source)).toEqual(["candidate:exhentai:gallery-one"]);
    expect(visibleCandidateKeys({ ...projection.snapshot, showWeakEvidence: true }, source)).toHaveLength(2);
  });

  it("sanitizes autocomplete/create responses, validation, and error feedback", () => {
    expect(sanitizeAutocompleteResponse({ items: [
      { value: "artist_one", label: "Artist One", category: "artist", post_count: 4 },
      { value: "artist_one", label: SECRET },
      { value: "general", category: "unknown" },
    ] })).toEqual([
      expect.objectContaining({ value: "artist_one", category: "artist", postCount: 4 }),
      expect.objectContaining({ value: "general", category: "general" }),
    ]);
    expect(sanitizeCreatedCrawl({ id: "batch:stage4", output_dir: `/private/${SECRET}` })).toEqual({ id: "batch:stage4" });
    expect(() => sanitizeCreatedCrawl({ id: "bad/path" })).toThrow("invalid_created_crawl");
    expect(validateCrawlDraft(crawlDraft).valid).toBe(true);
    expect(validateCrawlDraft({ ...crawlDraft, concurrency: 0 }).field).toBe("concurrency");
    expect(validateCrawlDraft({ ...crawlDraft, maxTasks: 100_001 }).field).toBe("max-tasks");
    expect(validateCrawlDraft({ ...crawlDraft, outputDir: `safe\n${SECRET}` }).field).toBe("output-dir");
    expect(validateCrawlDraft({ ...crawlDraft, ehDownload: { image_mode: "resample", gp_policy: "resized" } }).field)
      .toBe("eh-gp-policy");
    const guidance = crawlErrorPresentation(Object.assign(new Error(SECRET), {
      status: 503,
      code: "proxy_pool_unavailable",
      requestId: "request-safe",
      details: { path: `/private/${SECRET}` },
    }));
    expect(guidance).toMatchObject({ targetApp: "proxy", requestId: "request-safe" });
    expect(JSON.stringify(guidance)).not.toContain(SECRET);
  });
});
