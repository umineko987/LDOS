import { describe, expect, it } from "vitest";

import {
  clickCollectItem,
  compileSourceRange,
  compileSubmitSources,
  defaultSelectionForSource,
  describeSourceSelection,
  detectNewItemsBoundary,
  estimateSelectedCount,
  isCollectableItem,
  isItemExplicitlyExcluded,
  isItemSelected,
  mergeBrowseItems,
  patchDanbooruQueryFilters,
  selectOnlyNewItems,
  selectUntilItem,
  setPageRange,
  setRangeMode,
  setTopN,
  toggleSourceEnabled,
  type CollectBrowseItem,
  type CollectSourceSpec,
} from "./collect-range.ts";

function makeItem(index: number, overrides: Partial<CollectBrowseItem> = {}): CollectBrowseItem {
  const id = String(index + 1);
  return {
    id,
    title: `Item ${id}`,
    media_count: 1,
    url: `https://example.invalid/${id}`,
    downloadable: true,
    local_state: "none",
    ...overrides,
  };
}

const pixivSource: CollectSourceSpec = {
  id: "pixiv:timeline:42",
  site: "pixiv",
  kind: "timeline",
  label: "Artist 42",
  url: "https://www.pixiv.net/users/42/artworks",
  unit_kind: "work",
  default_mode: "top_n",
  default_top_n: 50,
};

const danbooruPool: CollectSourceSpec = {
  id: "danbooru:pool:7",
  site: "danbooru",
  kind: "pool",
  label: "Pool #7",
  url: "https://danbooru.donmai.us/pools/7",
  total: 12,
  unit_kind: "post",
  default_mode: "all",
};

const ehSource: CollectSourceSpec = {
  id: "exhentai:gallery:9",
  site: "exhentai",
  kind: "eh_gallery",
  label: "EH #9",
  url: "https://exhentai.org/g/9/0123456789/",
  total: 60,
  unit_kind: "page",
  default_mode: "all",
};

describe("collect-range engine", () => {
  it("chooses smart defaults by source kind", () => {
    expect(defaultSelectionForSource(pixivSource, false)).toMatchObject({ enabled: false, mode: "top_n", topN: 50 });
    expect(defaultSelectionForSource(danbooruPool, true)).toMatchObject({ enabled: true, mode: "all" });
    expect(defaultSelectionForSource(ehSource, true)).toMatchObject({ enabled: true, mode: "all", pageEnd: 60 });
  });

  it("supports top_n exclude-within-range and extra-include-outside-range", () => {
    const items = Array.from({ length: 6 }, (_, i) => makeItem(i));
    let state = setTopN(defaultSelectionForSource(pixivSource, false), 3);

    expect(isItemSelected(pixivSource, state, items[0], 0)).toBe(true);
    expect(isItemSelected(pixivSource, state, items[4], 4)).toBe(false);

    // Exclude item 1 inside top_n
    state = clickCollectItem(pixivSource, state, items, 1, false);
    expect(isItemExplicitlyExcluded(pixivSource, state, items[1], 1)).toBe(true);
    expect(isItemSelected(pixivSource, state, items[1], 1)).toBe(false);

    // Include item 4 outside top_n
    state = clickCollectItem(pixivSource, state, items, 4, false);
    expect(isItemSelected(pixivSource, state, items[4], 4)).toBe(true);

    // Shift-click re-includes range
    state = clickCollectItem(pixivSource, state, items, 0, false); // uncheck 0 -> anchor 1
    state = clickCollectItem(pixivSource, state, items, 2, true); // shift-click to 2 (checked -> checks range or unchecks)
    expect(state.anchorId).toBe("3");

    const compiled = compileSourceRange(pixivSource, state);
    expect(compiled).toMatchObject({
      mode: "top_n",
      top_n: 3,
    });
    expect(compiled?.items?.some((it: { id: string }) => it.id === "5")).toBe(true);
  });

  it("auto-enables disabled source in explicit mode when clicking a card, and supports shift-range", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      makeItem(i, i === 2 ? { local_state: "in_dataset" } : {}),
    );
    expect(isCollectableItem(items[2])).toBe(false);

    let state = defaultSelectionForSource(pixivSource, false);
    state = clickCollectItem(pixivSource, state, items, 1, false);
    expect(state.enabled).toBe(true);
    expect(state.mode).toBe("explicit");
    expect(isItemSelected(pixivSource, state, items[1], 1)).toBe(true);

    state = clickCollectItem(pixivSource, state, items, 4, true);
    expect(isItemSelected(pixivSource, state, items[2], 2)).toBe(false); // in_dataset skipped
    expect(isItemSelected(pixivSource, state, items[3], 3)).toBe(true);
    expect(isItemSelected(pixivSource, state, items[4], 4)).toBe(true);

    expect(estimateSelectedCount(pixivSource, state)).toEqual({ count: 3, approximate: false });
    expect(describeSourceSelection(pixivSource, state)).toBe("手选 3");
  });

  it("handles select-until, page ranges, and only-new boundary detection", () => {
    const works = [
      makeItem(0, { local_state: "in_library", local_asset_id: "asset-0" }),
      makeItem(1),
      makeItem(2, { local_state: "in_dataset" }),
      makeItem(3),
    ];
    expect(detectNewItemsBoundary(works)).toBe(2);

    const onlyNew = selectOnlyNewItems(defaultSelectionForSource(pixivSource, true), works);
    expect(onlyNew).toMatchObject({ enabled: true, mode: "top_n", topN: 2 });

    const allInDataset = selectOnlyNewItems(onlyNew, [makeItem(0, { local_state: "in_dataset" })]);
    expect(allInDataset).toMatchObject({ enabled: false, mode: "explicit" });

    const until = selectUntilItem(pixivSource, defaultSelectionForSource(pixivSource, false), works, 2);
    expect(until).toMatchObject({ enabled: true, mode: "top_n", topN: 3 });

    const ehItems = Array.from({ length: 10 }, (_, i) => makeItem(i, { page: i + 1 }));
    let ehState = setPageRange(ehSource, defaultSelectionForSource(ehSource, true), 5, 42);
    expect(describeSourceSelection(ehSource, ehState)).toBe("P5–42");
    expect(isItemSelected(ehSource, ehState, ehItems[4], 4)).toBe(true);
    expect(isItemSelected(ehSource, ehState, ehItems[1], 1)).toBe(false);

    // Exclude page 6 and include page 2 outside range
    ehState = clickCollectItem(ehSource, ehState, ehItems, 5, false);
    ehState = clickCollectItem(ehSource, ehState, ehItems, 1, false);
    expect(compileSourceRange(ehSource, ehState)).toEqual({
      mode: "pages",
      page_start: 5,
      page_end: 42,
      excluded_pages: [6],
      extra_pages: [2],
    });

    const untilPage = selectUntilItem(ehSource, ehState, ehItems, 3);
    expect(untilPage).toMatchObject({ mode: "pages", pageStart: 1, pageEnd: 4 });
  });

  it("handles mode transitions, danbooru filter patching, merging, and compileSubmitSources", () => {
    const merged = mergeBrowseItems([makeItem(0), makeItem(1)], [makeItem(1), makeItem(2)]);
    expect(merged.map((i) => i.id)).toEqual(["1", "2", "3"]);

    const patched = patchDanbooruQueryFilters("silver_hair order:score rating:g", {
      sort: "favcount",
      rating: "safe_questionable",
    });
    expect(patched).toBe("silver_hair order:favcount -rating:e,q");
    expect(patchDanbooruQueryFilters(patched, { sort: "newest", rating: "all" })).toBe("silver_hair");

    let disabled = toggleSourceEnabled(defaultSelectionForSource(danbooruPool, true));
    expect(describeSourceSelection(danbooruPool, disabled)).toBe("已跳过");
    expect(estimateSelectedCount(danbooruPool, disabled)).toEqual({ count: 0, approximate: false });

    const pagesRejected = setRangeMode(pixivSource, disabled, "pages");
    expect(pagesRejected.mode).toBe("all");

    const unknownAll = setRangeMode({ total: null, unit_kind: "work" }, disabled, "all");
    expect(estimateSelectedCount({ total: null, unit_kind: "work" }, unknownAll)).toEqual({
      count: null,
      approximate: true,
    });
    expect(describeSourceSelection({ total: null, unit_kind: "work" }, unknownAll)).toBe("全部");
    expect(describeSourceSelection(danbooruPool, setRangeMode(danbooruPool, disabled, "all"))).toBe("全部 (12)");
    expect(describeSourceSelection(pixivSource, setTopN(disabled, 20))).toBe("前 20");

    const compiled = compileSubmitSources([
      { source: danbooruPool, state: disabled },
      { source: ehSource, state: defaultSelectionForSource(ehSource, true) },
      { source: pixivSource, state: setTopN(disabled, 25) },
    ]);
    expect(compiled).toHaveLength(2);
    expect(compiled[0].range).toEqual({ mode: "all" });
    expect(compiled[1].range).toEqual({ mode: "top_n", top_n: 25 });
  });
});
