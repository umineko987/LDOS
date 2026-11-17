// 在线采集的发现搜索：/api/v1/search/sites 列站点，POST /api/v1/search?view=desktop 按关键词找候选地址。
// 候选只取能直接交给 /datasets/{id}/crawls 的字段；远端缩略图不显示（CSP 只放行本机图片）。

import { queryOptions } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import type { components } from "../schema";
import type { DatasetCrawlRequest } from "./datasets.ts";

type Schemas = components["schemas"];
type SearchSource = Schemas["DesktopSearchSourceResponse"];
type SearchCandidate = Schemas["DesktopSearchCandidateResponse"];

export interface DiscoverySite {
  readonly site: string;
  readonly aliases: readonly string[];
  /** 站点是否要求登录（`required`、`optional`……原样给出）。 */
  readonly authentication: string;
}

export interface DiscoveryCandidate {
  /** 在一次搜索结果里唯一：`站点\n地址`。 */
  readonly key: string;
  readonly site: string;
  readonly url: string;
  readonly id: string | null;
  readonly label: string;
  readonly addressType: string | null;
  readonly mediaCount: number | null;
  readonly confidence: string | null;
}

export interface DiscoverySourceResult {
  readonly site: string;
  readonly status: string;
  /** 站点搜索失败时后端给的说明（已截断）。 */
  readonly error: string | null;
  readonly needsAuth: boolean;
  readonly candidates: readonly DiscoveryCandidate[];
}

export interface DiscoverySearch {
  readonly keyword: string;
  readonly sites: readonly string[];
  readonly limit?: number;
}

export const discoveryKeys = {
  all: ["discovery"] as const,
  sites: () => [...discoveryKeys.all, "sites"] as const,
};

/** 每次最多勾 5 个站点（后端 SearchRequest.sites 的上限）。 */
export const DISCOVERY_MAX_SITES = 5;

const text = (value: string | null | undefined, maximum = 200) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) : "";

function crawlableUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function candidate(site: string, raw: SearchCandidate): DiscoveryCandidate | null {
  const url = crawlableUrl(raw.url);
  if (!url) return null;
  return {
    key: `${site}\n${url}`,
    site,
    url,
    id: text(raw.id, 500) || null,
    label: text(raw.label) || text(raw.title) || text(raw.tag) || url,
    addressType: text(raw.address_type, 100) || null,
    mediaCount: typeof raw.media_count === "number" && raw.media_count >= 0 ? raw.media_count : null,
    confidence: text(raw.confidence, 32) || null,
  };
}

function sourceResult(raw: SearchSource): DiscoverySourceResult | null {
  const site = text(raw.site, 128);
  if (!site) return null;
  const seen = new Set<string>();
  const candidates: DiscoveryCandidate[] = [];
  for (const item of raw.addresses ?? []) {
    const next = candidate(site, item);
    if (!next || seen.has(next.key)) continue;
    seen.add(next.key);
    candidates.push(next);
  }
  return {
    site,
    status: text(raw.status, 32) || "ok",
    error: raw.error ? text(raw.error.message, 300) || text(raw.error.code, 128) || null : null,
    needsAuth: raw.auth?.authorized === false,
    candidates,
  };
}

/** 只认 desktop 视图；拿到旧版视图说明后端版本不对。 */
export function sanitizeDiscoveryResponse(value: unknown): readonly DiscoverySourceResult[] {
  const body = value as Schemas["DesktopSearchResponse"] | null;
  if (!body || typeof body !== "object" || body.response_profile !== "desktop") throw new TypeError("invalid_discovery_response");
  return (body.sources ?? []).flatMap((source) => {
    const result = source && typeof source === "object" ? sourceResult(source) : null;
    return result ? [result] : [];
  });
}

export function discoverySitesQuery(api: Api) {
  return queryOptions({
    queryKey: discoveryKeys.sites(),
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const body = await data(api.client.GET("/api/v1/search/sites", { signal }));
      return (body.items ?? []).flatMap((item): DiscoverySite[] => {
        const site = text(item.site, 128);
        return site
          ? [{ site, aliases: (item.aliases ?? []).map((alias) => text(alias, 64)).filter(Boolean), authentication: text(item.authentication, 32) }]
          : [];
      });
    },
  });
}

// 生成的 schema 把带默认值的字段标成必填；这里照后端（gdl_backend/schemas.py）的默认值填上。
const TIMEOUT_SECONDS = 180;
const SEARCH_TIMEOUT_SECONDS = 45;
const CRAWL_DEFAULTS = { concurrency: 20, max_tasks: 10_000, priority: 0, timeout_seconds: TIMEOUT_SECONDS } as const;
const SOURCE_DEFAULTS = { priority: 0, timeout_seconds: TIMEOUT_SECONDS } as const;

/** 搜索由按钮触发，每个站点在总预算内完成或返回超时。 */
export async function searchDiscovery(
  api: Api,
  { keyword, sites, limit = 20 }: DiscoverySearch,
  signal?: AbortSignal,
): Promise<readonly DiscoverySourceResult[]> {
  const body = await data(
    api.client.POST("/api/v1/search", {
      params: { query: { view: "desktop" } },
      body: {
        keyword: keyword.trim(),
        sites: [...sites].slice(0, DISCOVERY_MAX_SITES),
        limit,
        timeout_seconds: SEARCH_TIMEOUT_SECONDS,
      },
      signal,
    }),
  );
  return sanitizeDiscoveryResponse(body);
}

/** 选中的候选按站点分组，组成 /datasets/{id}/crawls 的请求体；没有选中返回 null。 */
export function buildDatasetCrawl(selected: readonly DiscoveryCandidate[]): DatasetCrawlRequest | null {
  const bySite = new Map<string, DiscoveryCandidate[]>();
  for (const item of selected) bySite.set(item.site, [...(bySite.get(item.site) ?? []), item]);
  if (bySite.size === 0) return null;
  return {
    ...CRAWL_DEFAULTS,
    sources: [...bySite].map(([site, items]) => ({
      ...SOURCE_DEFAULTS,
      site,
      addresses: items.slice(0, 500).map((item) => ({
        url: item.url,
        ...(item.id ? { id: item.id } : {}),
        ...(item.label && item.label !== item.url ? { label: item.label.slice(0, 500) } : {}),
        ...(item.addressType ? { address_type: item.addressType } : {}),
      })),
    })),
  };
}
