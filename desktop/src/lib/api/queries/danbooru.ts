import { data, idempotent, type Api } from "../client.ts";
import { ApiError } from "../errors.ts";
import { createIdempotencyKey } from "../ids.ts";
import type { components } from "../schema";

type Schemas = components["schemas"];
export type DanbooruBrowseRequest = Schemas["DanbooruBrowseRequest"];
export type DanbooruBrowseResponse = Schemas["DanbooruBrowseResponse"];
export type DanbooruPost = Schemas["DanbooruPost"];
export type DanbooruCollectResponse = Schemas["DanbooruCollectResponse"];
export type DanbooruKind = "search" | "pool" | "favorite_group" | "favorites";
export const DANBOORU_COLLECT_LIMIT = 1000;

export const isDanbooruExpired = (error: unknown): boolean => error instanceof ApiError && error.status === 410;

export interface DanbooruCollectAttempt {
  readonly tokens: readonly string[];
  readonly key: string;
}

export function danbooruCollectAttempt(previous: DanbooruCollectAttempt | undefined, tokens: readonly string[]): DanbooruCollectAttempt {
  if (previous && previous.tokens.length === tokens.length && tokens.every((token, index) => token === previous.tokens[index])) return previous;
  return { tokens: [...tokens], key: createIdempotencyKey("danbooru-collect") };
}

export function browseDanbooru(api: Api, body: DanbooruBrowseRequest, signal?: AbortSignal): Promise<DanbooruBrowseResponse> {
  return data(api.client.POST("/api/v1/danbooru/browse", { body, signal }));
}

export function collectDanbooru(
  api: Api,
  datasetId: string,
  tokens: readonly string[],
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<DanbooruCollectResponse> {
  return data(
    api.client.POST("/api/v1/datasets/{dataset_id}/danbooru/collect", {
      params: { path: { dataset_id: datasetId }, header: idempotent(idempotencyKey) },
      body: { tokens: [...tokens] },
      signal,
    }),
  );
}

export interface DanbooruFilters {
  include: string;
  exclude: string;
  rating: "" | "g" | "s" | "q" | "e";
  minWidth: string;
  minHeight: string;
  ratio: "" | "<1" | "1" | ">1";
  format: "" | "jpg" | "png" | "webp" | "gif" | "avif";
  order: "id_desc" | "id_asc" | "score" | "rank" | "random";
}

export const emptyDanbooruFilters = (): DanbooruFilters => ({
  include: "", exclude: "", rating: "", minWidth: "", minHeight: "", ratio: "", format: "", order: "id_desc",
});

export type DanbooruQueryDraft = { mode: "simple"; filters: DanbooruFilters } | { mode: "raw"; text: string };

export function composeDanbooruQuery(filters: DanbooruFilters): string {
  const tokens = [
    ...filters.include.trim().split(/\s+/).filter(Boolean),
    ...filters.exclude.trim().split(/\s+/).filter(Boolean).map((tag) => `-${tag.replace(/^-+/, "")}`),
  ];
  if (filters.rating) tokens.push(`rating:${filters.rating}`);
  for (const [name, value] of [["width", filters.minWidth], ["height", filters.minHeight]] as const) {
    if (/^\d+$/.test(value) && Number(value) > 0) tokens.push(`${name}:>=${Number(value)}`);
  }
  if (filters.ratio) tokens.push(`ratio:${filters.ratio}`);
  if (filters.format) tokens.push(`filetype:${filters.format}`);
  tokens.push(`order:${filters.order}`);
  return [...new Set(tokens)].join(" ");
}

export const danbooruQueryText = (draft: DanbooruQueryDraft): string =>
  draft.mode === "raw" ? draft.text : composeDanbooruQuery(draft.filters);

/** Raw text is never parsed back into controls. Only an explicit clear leaves raw mode. */
export const rawDanbooruQuery = (draft: DanbooruQueryDraft): DanbooruQueryDraft => ({ mode: "raw", text: danbooruQueryText(draft) });
export const clearDanbooruQuery = (): DanbooruQueryDraft => ({ mode: "simple", filters: emptyDanbooruFilters() });

export function mergeDanbooruPosts(previous: readonly DanbooruPost[], incoming: readonly DanbooruPost[]): DanbooruPost[] {
  const seen = new Set<string>();
  return [...previous, ...incoming].filter((post) => {
    if (seen.has(post.id)) return false;
    seen.add(post.id);
    return true;
  });
}

export const canCollectDanbooruPost = (post: DanbooruPost): boolean =>
  !post.in_dataset && Boolean(post.token) && (post.downloadable || Boolean(post.local_asset_id));

/** Selection is projected onto source order, never onto click order. */
export function selectedDanbooruTokens(posts: readonly DanbooruPost[], selected: ReadonlySet<string>): string[] {
  return mergeDanbooruPosts([], posts)
    .filter((post) => selected.has(post.id) && canCollectDanbooruPost(post))
    .map((post) => post.token);
}

export function selectLoadedDanbooruPosts(posts: readonly DanbooruPost[]): ReadonlySet<string> {
  return new Set(mergeDanbooruPosts([], posts).filter(canCollectDanbooruPost).slice(0, DANBOORU_COLLECT_LIMIT).map((post) => post.id));
}

/** The API rejects remote URLs; invalid media stays a visible placeholder. */
export function danbooruMediaUrl(api: Api, path: string): string {
  if (!path) return "";
  try {
    return api.resourceUrl(path);
  } catch {
    return "";
  }
}

/** Abort saves work; the sequence guard also rejects transports that finish after abort. */
export function createDanbooruRequestScope() {
  let sequence = 0;
  let controller: AbortController | undefined;
  function cancel() {
    sequence += 1;
    controller?.abort();
    controller = undefined;
  }
  return {
    cancel,
    begin() {
      cancel();
      controller = new AbortController();
      const current = sequence;
      const signal = controller.signal;
      return { signal, isCurrent: () => current === sequence && !signal.aborted };
    },
  };
}

export interface DanbooruTagSuggestion {
  value: string;
  label: string;
  category: string;
  count: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function autocompleteDanbooru(api: Api, q: string, signal?: AbortSignal): Promise<DanbooruTagSuggestion[]> {
  const response = await data(api.client.GET("/api/v1/search/autocomplete", { params: { query: { q, limit: 8 } }, signal }));
  // The existing autocomplete schema deliberately exposes items as unknown[].
  return (response.items ?? []).flatMap((item): DanbooruTagSuggestion[] => {
    if (!isRecord(item) || typeof item.value !== "string" || !item.value) return [];
    return [{
      value: item.value,
      label: typeof item.label === "string" ? item.label : item.value,
      category: typeof item.category === "string" ? item.category : "",
      count: typeof item.post_count === "number" ? item.post_count : null,
    }];
  });
}

export function replaceLastDanbooruTag(text: string, tag: string): string {
  return text.replace(/\S*$/, tag);
}

export interface DanbooruRecipe {
  id: string;
  name: string;
  kind: DanbooruKind;
  query: string;
  reference: string;
}

type RecipeStorage = Pick<Storage, "getItem" | "setItem">;
const recipeKey = (datasetId: string) => `ldos:danbooru:sources:${encodeURIComponent(datasetId)}`;
export const isDanbooruKind = (value: unknown): value is DanbooruKind =>
  value === "search" || value === "pool" || value === "favorite_group" || value === "favorites";

export function readDanbooruRecipes(storage: RecipeStorage, datasetId: string): DanbooruRecipe[] {
  const stored = storage.getItem(recipeKey(datasetId));
  if (!stored) return [];
  let values: unknown;
  try {
    values = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(values)) return [];
  return values.flatMap((value): DanbooruRecipe[] => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !isDanbooruKind(value.kind)
      || typeof value.query !== "string" || typeof value.reference !== "string") return [];
    return [{ id: value.id, name: value.name, kind: value.kind, query: value.query, reference: value.reference }];
  });
}

export function saveDanbooruRecipe(storage: RecipeStorage, datasetId: string, recipe: DanbooruRecipe): DanbooruRecipe[] {
  // Explicit projection excludes tokens, media, credentials and future response fields.
  const { id, name, kind, query, reference } = recipe;
  const recipes = [...readDanbooruRecipes(storage, datasetId).filter((item) => item.id !== id), { id, name, kind, query, reference }];
  storage.setItem(recipeKey(datasetId), JSON.stringify(recipes));
  return recipes;
}

export function deleteDanbooruRecipe(storage: RecipeStorage, datasetId: string, id: string): DanbooruRecipe[] {
  const recipes = readDanbooruRecipes(storage, datasetId).filter((item) => item.id !== id);
  storage.setItem(recipeKey(datasetId), JSON.stringify(recipes));
  return recipes;
}
