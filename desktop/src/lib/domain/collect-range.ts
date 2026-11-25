import type { components } from "../api/schema.d.ts";

type Schemas = components["schemas"];
export type CollectSourceSpec = Schemas["CollectSourceSpec"];
export type CollectBrowseItem = Schemas["CollectBrowseItem"];
export type CollectSubmitItem = Schemas["CollectSubmitItem"];
export type CollectSubmitRange = Schemas["CollectSubmitRange"];
export type CollectSubmitSource = Schemas["CollectSubmitSource"];
export type CollectSubmitRequest = Schemas["CollectSubmitRequest"];

export type CollectRangeMode = "all" | "top_n" | "pages" | "explicit";

export interface SourceSelectionState {
  readonly enabled: boolean;
  readonly mode: CollectRangeMode;
  readonly topN: number;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly includedItems: Readonly<Record<string, CollectSubmitItem>>;
  readonly excludedIds: readonly string[];
  readonly anchorId: string | null;
}

export type DanbooruSort = "newest" | "score" | "favcount";
export type DanbooruRating = "all" | "general" | "safe_questionable";

export interface DanbooruQueryFilters {
  readonly baseTags: string;
  readonly sort: DanbooruSort;
  readonly rating: DanbooruRating;
}

export function toSubmitItem(item: CollectBrowseItem): CollectSubmitItem {
  return {
    id: item.id,
    url: item.url,
    ...(item.title ? { title: item.title } : {}),
    ...(item.source_url ? { source_url: item.source_url } : {}),
    ...(item.file_ext ? { file_ext: item.file_ext } : {}),
    ...(item.media_count ? { media_count: item.media_count } : {}),
    ...(item.page != null ? { page: item.page } : {}),
    ...(item.local_asset_id != null ? { local_asset_id: item.local_asset_id } : {}),
  };
}

export function isCollectableItem(item: CollectBrowseItem): boolean {
  return item.downloadable && item.local_state !== "in_dataset";
}

export function itemPageNumber(item: Pick<CollectBrowseItem, "id" | "page">): number | null {
  if (typeof item.page === "number" && Number.isInteger(item.page) && item.page > 0) {
    return item.page;
  }
  const parsed = Number(item.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function defaultSelectionForSource(
  source: Pick<CollectSourceSpec, "kind" | "default_mode" | "default_top_n" | "unit_kind"> & { readonly total?: number | null },
  enabled: boolean,
): SourceSelectionState {
  const isAllDefault =
    source.default_mode === "all" ||
    source.kind === "eh_gallery" ||
    source.kind === "pool" ||
    source.kind === "favorite_group" ||
    source.kind === "single_work";
  const totalPages = source.unit_kind === "page" && source.total && source.total > 0 ? source.total : 50;
  return {
    enabled,
    mode: isAllDefault ? "all" : "top_n",
    topN: source.default_top_n && source.default_top_n > 0 ? source.default_top_n : 50,
    pageStart: 1,
    pageEnd: totalPages,
    includedItems: {},
    excludedIds: [],
    anchorId: null,
  };
}

export function isItemInBaseRange(
  source: Pick<CollectSourceSpec, "unit_kind">,
  state: SourceSelectionState,
  item: CollectBrowseItem,
  indexInLoaded: number,
): boolean {
  switch (state.mode) {
    case "all":
      return true;
    case "top_n":
      return indexInLoaded >= 0 && indexInLoaded < state.topN;
    case "pages": {
      if (source.unit_kind !== "page") return false;
      const p = itemPageNumber(item);
      return p !== null && p >= state.pageStart && p <= state.pageEnd;
    }
    case "explicit":
      return false;
  }
}

export function isItemExplicitlyExcluded(
  source: Pick<CollectSourceSpec, "unit_kind">,
  state: SourceSelectionState,
  item: CollectBrowseItem,
  indexInLoaded: number,
): boolean {
  if (!state.enabled || !isCollectableItem(item)) return false;
  return isItemInBaseRange(source, state, item, indexInLoaded) && state.excludedIds.includes(item.id);
}

export function isItemSelected(
  source: Pick<CollectSourceSpec, "unit_kind">,
  state: SourceSelectionState,
  item: CollectBrowseItem,
  indexInLoaded: number,
): boolean {
  if (!state.enabled || !isCollectableItem(item)) return false;
  if (state.mode === "explicit") {
    return item.id in state.includedItems;
  }
  if (isItemInBaseRange(source, state, item, indexInLoaded)) {
    return !state.excludedIds.includes(item.id);
  }
  return item.id in state.includedItems;
}

function setItemIncludedOrExcluded(
  source: Pick<CollectSourceSpec, "unit_kind">,
  item: CollectBrowseItem,
  indexInLoaded: number,
  wantSelected: boolean,
  mode: CollectRangeMode,
  topN: number,
  pageStart: number,
  pageEnd: number,
  included: Record<string, CollectSubmitItem>,
  excluded: Set<string>,
): void {
  if (!isCollectableItem(item)) return;
  const inBase =
    mode === "all" ||
    (mode === "top_n" && indexInLoaded >= 0 && indexInLoaded < topN) ||
    (mode === "pages" &&
      source.unit_kind === "page" &&
      (() => {
        const p = itemPageNumber(item);
        return p !== null && p >= pageStart && p <= pageEnd;
      })());

  if (mode !== "explicit" && inBase) {
    delete included[item.id];
    if (wantSelected) {
      excluded.delete(item.id);
    } else {
      excluded.add(item.id);
    }
    return;
  }

  excluded.delete(item.id);
  if (wantSelected) {
    included[item.id] = toSubmitItem(item);
  } else {
    delete included[item.id];
  }
}

export function clickCollectItem(
  source: Pick<CollectSourceSpec, "unit_kind">,
  state: SourceSelectionState,
  loadedItems: readonly CollectBrowseItem[],
  index: number,
  shiftKey = false,
): SourceSelectionState {
  const target = loadedItems[index];
  if (!target || !isCollectableItem(target)) return state;

  // Clicking inside a disabled source switches it straight into manual explicit mode for that item.
  const nextMode: CollectRangeMode = state.enabled ? state.mode : "explicit";
  const included: Record<string, CollectSubmitItem> = state.enabled ? { ...state.includedItems } : {};
  const excluded = new Set<string>(state.enabled ? state.excludedIds : []);

  const currentlySelected = state.enabled ? isItemSelected(source, state, target, index) : false;
  const wantSelected = !currentlySelected;

  if (shiftKey && state.anchorId) {
    const anchorIndex = loadedItems.findIndex((item) => item.id === state.anchorId);
    if (anchorIndex >= 0) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      for (let i = start; i <= end; i++) {
        setItemIncludedOrExcluded(
          source,
          loadedItems[i],
          i,
          wantSelected,
          nextMode,
          state.topN,
          state.pageStart,
          state.pageEnd,
          included,
          excluded,
        );
      }
      return {
        ...state,
        enabled: true,
        mode: nextMode,
        includedItems: included,
        excludedIds: [...excluded],
        anchorId: target.id,
      };
    }
  }

  setItemIncludedOrExcluded(
    source,
    target,
    index,
    wantSelected,
    nextMode,
    state.topN,
    state.pageStart,
    state.pageEnd,
    included,
    excluded,
  );
  return {
    ...state,
    enabled: true,
    mode: nextMode,
    includedItems: included,
    excludedIds: [...excluded],
    anchorId: target.id,
  };
}

export function selectUntilItem(
  source: Pick<CollectSourceSpec, "unit_kind">,
  state: SourceSelectionState,
  loadedItems: readonly CollectBrowseItem[],
  index: number,
): SourceSelectionState {
  const item = loadedItems[index];
  if (!item) return state;
  if (source.unit_kind === "page") {
    const endPage = itemPageNumber(item) ?? Math.max(1, index + 1);
    return {
      ...state,
      enabled: true,
      mode: "pages",
      pageStart: 1,
      pageEnd: endPage,
      includedItems: {},
      excludedIds: [],
      anchorId: item.id,
    };
  }
  return {
    ...state,
    enabled: true,
    mode: "top_n",
    topN: Math.max(1, index + 1),
    includedItems: {},
    excludedIds: [],
    anchorId: item.id,
  };
}

export function toggleSourceEnabled(state: SourceSelectionState): SourceSelectionState {
  return { ...state, enabled: !state.enabled };
}

export function setRangeMode(
  source: Pick<CollectSourceSpec, "unit_kind"> & { readonly total?: number | null },
  state: SourceSelectionState,
  mode: CollectRangeMode,
): SourceSelectionState {
  if (mode === "pages" && source.unit_kind !== "page") return state;
  const maxPages = source.total && source.total > 0 ? source.total : Math.max(state.pageEnd, 50);
  return {
    ...state,
    enabled: true,
    mode,
    pageEnd: mode === "pages" ? Math.min(state.pageEnd || maxPages, maxPages) : state.pageEnd,
    includedItems: mode === state.mode ? state.includedItems : {},
    excludedIds: mode === state.mode ? state.excludedIds : [],
  };
}

export function setTopN(state: SourceSelectionState, topN: number): SourceSelectionState {
  const clamped = Math.max(1, Math.min(10000, Math.round(topN)));
  return {
    ...state,
    enabled: true,
    mode: "top_n",
    topN: clamped,
    includedItems: {},
    excludedIds: [],
  };
}

export function setPageRange(
  source: { readonly total?: number | null },
  state: SourceSelectionState,
  start: number,
  end: number,
): SourceSelectionState {
  const s = Math.max(1, Math.min(20000, Math.round(start)));
  const ceiling = source.total && source.total > 0 ? source.total : 20000;
  const e = Math.max(s, Math.min(ceiling, Math.round(end)));
  return {
    ...state,
    enabled: true,
    mode: "pages",
    pageStart: s,
    pageEnd: e,
    includedItems: {},
    excludedIds: [],
  };
}

/**
 * Returns index of the first loaded item that is already in the dataset (`in_dataset`),
 * representing the boundary between new items `[0..idx-1]` and previously collected items.
 */
export function detectNewItemsBoundary(items: readonly CollectBrowseItem[]): number | null {
  const idx = items.findIndex((item) => item.local_state === "in_dataset");
  return idx >= 0 ? idx : null;
}

export function selectOnlyNewItems(
  state: SourceSelectionState,
  items: readonly CollectBrowseItem[],
): SourceSelectionState {
  const boundary = detectNewItemsBoundary(items);
  if (boundary === null) return state;
  if (boundary === 0) {
    return {
      ...state,
      enabled: false,
      mode: "explicit",
      includedItems: {},
      excludedIds: [],
    };
  }
  return {
    ...state,
    enabled: true,
    mode: "top_n",
    topN: boundary,
    includedItems: {},
    excludedIds: [],
  };
}

export function mergeBrowseItems(
  existing: readonly CollectBrowseItem[],
  incoming: readonly CollectBrowseItem[],
): CollectBrowseItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const merged = [...existing];
  for (const item of incoming) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

export function parseDanbooruQueryFilters(query: string): DanbooruQueryFilters {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  let sort: DanbooruSort = "newest";
  let rating: DanbooruRating = "all";
  const rest: string[] = [];

  for (const tok of tokens) {
    if (tok === "order:score") sort = "score";
    else if (tok === "order:favcount") sort = "favcount";
    else if (tok === "rating:g") rating = "general";
    else if (tok === "-rating:e,q") rating = "safe_questionable";
    else rest.push(tok);
  }
  return { baseTags: rest.join(" "), sort, rating };
}

export function patchDanbooruQueryFilters(
  query: string,
  patch: Partial<Pick<DanbooruQueryFilters, "sort" | "rating">>,
): string {
  const cur = parseDanbooruQueryFilters(query);
  const sort = patch.sort ?? cur.sort;
  const rating = patch.rating ?? cur.rating;
  const tokens = cur.baseTags ? cur.baseTags.split(/\s+/) : [];
  if (sort === "score") tokens.push("order:score");
  else if (sort === "favcount") tokens.push("order:favcount");
  if (rating === "general") tokens.push("rating:g");
  else if (rating === "safe_questionable") tokens.push("-rating:e,q");
  return tokens.join(" ");
}

export function estimateSelectedCount(
  source: Pick<CollectSourceSpec, "unit_kind"> & { readonly total?: number | null },
  state: SourceSelectionState,
): { count: number | null; approximate: boolean } {
  if (!state.enabled) return { count: 0, approximate: false };
  const extraCount = Object.keys(state.includedItems).length;
  const excludedCount = state.excludedIds.length;
  switch (state.mode) {
    case "explicit":
      return { count: extraCount, approximate: false };
    case "top_n":
      return {
        count: Math.max(0, state.topN - excludedCount) + extraCount,
        approximate: excludedCount > 0 || extraCount > 0 || (source.total ?? 0) === 0,
      };
    case "pages":
      return {
        count: Math.max(0, state.pageEnd - state.pageStart + 1 - excludedCount) + extraCount,
        approximate: false,
      };
    case "all":
      if (source.total && source.total > 0) {
        return {
          count: Math.max(0, source.total - excludedCount),
          approximate: false,
        };
      }
      return { count: null, approximate: true };
  }
}

export function describeSourceSelection(
  source: Pick<CollectSourceSpec, "unit_kind"> & { readonly total?: number | null },
  state: SourceSelectionState,
): string {
  if (!state.enabled) return "已跳过";
  const extraCount = Object.keys(state.includedItems).length;
  const excludedCount = state.excludedIds.length;
  switch (state.mode) {
    case "explicit":
      return `手选 ${extraCount}`;
    case "top_n": {
      const mod = excludedCount > 0 || extraCount > 0 ? "*" : "";
      return `前 ${state.topN}${mod}`;
    }
    case "pages":
      return `P${state.pageStart}–${state.pageEnd}`;
    case "all":
      return source.total && source.total > 0 ? `全部 (${Math.max(0, source.total - excludedCount)})` : "全部";
  }
}

export function compileSourceRange(
  source: CollectSourceSpec,
  state: SourceSelectionState,
): CollectSubmitRange | null {
  if (!state.enabled) return null;
  const items = Object.values(state.includedItems);

  if (source.site === "exhentai") {
    const excludedPages = state.excludedIds
      .map((id) => Number(id))
      .filter((n) => Number.isInteger(n) && n > 0);
    const extraPages = items
      .map((item) => item.page ?? Number(item.id))
      .filter((n) => Number.isInteger(n) && n > 0);

    if (state.mode === "explicit") {
      if (items.length === 0) return null;
      return { mode: "explicit", items };
    }
    if (state.mode === "pages") {
      if (state.pageEnd < state.pageStart && extraPages.length === 0) return null;
      return {
        mode: "pages",
        page_start: state.pageStart,
        page_end: state.pageEnd,
        ...(excludedPages.length > 0 ? { excluded_pages: excludedPages } : {}),
        ...(extraPages.length > 0 ? { extra_pages: extraPages } : {}),
      };
    }
    return {
      mode: "all",
      ...(excludedPages.length > 0 ? { excluded_pages: excludedPages } : {}),
    };
  }

  switch (state.mode) {
    case "explicit":
      return items.length > 0 ? { mode: "explicit", items } : null;
    case "top_n":
      return {
        mode: "top_n",
        top_n: state.topN,
        ...(state.excludedIds.length > 0 ? { excluded_ids: [...state.excludedIds] } : {}),
        ...(items.length > 0 ? { items } : {}),
      };
    case "all":
      return {
        mode: "all",
        ...(state.excludedIds.length > 0 ? { excluded_ids: [...state.excludedIds] } : {}),
      };
    default:
      return null;
  }
}

export function compileSubmitSources(
  entries: readonly { readonly source: CollectSourceSpec; readonly state: SourceSelectionState }[],
): CollectSubmitSource[] {
  const compiled: CollectSubmitSource[] = [];
  for (const { source, state } of entries) {
    const range = compileSourceRange(source, state);
    if (range) {
      compiled.push({ source, range });
    }
  }
  return compiled;
}
