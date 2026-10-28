import type { ApiClient } from "../../core/api/client";
import {
  buildCrawlPayload,
  buildSearchPayload,
  sanitizeAutocompleteResponse,
  sanitizeCreatedCrawl,
  sanitizeCrawlSearchResponse,
  type CrawlDraft,
  type CrawlCandidateKey,
  type CrawlOperation,
  type CrawlSearchProjection,
  type CrawlSnapshot,
  type CrawlSuggestion,
  type SearchDraft,
} from "./model";

export const CRAWL_ENDPOINTS = Object.freeze({
  search: "/api/v1/search",
  autocomplete: "/api/v1/search/autocomplete",
  crawls: "/api/v1/crawls",
} as const);

export interface CrawlService {
  autocomplete(query: string, signal: AbortSignal): Promise<readonly CrawlSuggestion[]>;
  search(draft: SearchDraft, signal: AbortSignal): Promise<CrawlSearchProjection>;
  create(
    snapshot: CrawlSnapshot,
    operations: ReadonlyMap<CrawlCandidateKey, CrawlOperation>,
    draft: CrawlDraft,
    signal: AbortSignal,
  ): Promise<Readonly<{ id: string }>>;
}

export function autocompletePath(query: string): string {
  const value = query.trim();
  if (value.length < 2 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("invalid_autocomplete_query");
  }
  return `${CRAWL_ENDPOINTS.autocomplete}?q=${encodeURIComponent(value)}&limit=10`;
}

export function createCrawlService(api: ApiClient): CrawlService {
  const service: CrawlService = {
    async autocomplete(query, signal) {
      return sanitizeAutocompleteResponse(await api.get(autocompletePath(query), { signal }));
    },
    async search(draft, signal) {
      return sanitizeCrawlSearchResponse(
        await api.post(`${CRAWL_ENDPOINTS.search}?view=desktop`, buildSearchPayload(draft), { signal }),
      );
    },
    async create(snapshot, operations, draft, signal) {
      return sanitizeCreatedCrawl(await api.post(
        `${CRAWL_ENDPOINTS.crawls}?view=desktop`,
        buildCrawlPayload(snapshot, operations, draft),
        { signal, idempotencyKey: true },
      ));
    },
  };
  return Object.freeze(service);
}
