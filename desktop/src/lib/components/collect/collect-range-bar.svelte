<script lang="ts">
  import SparklesIcon from "@lucide/svelte/icons/sparkles";

  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import {
    detectNewItemsBoundary,
    parseDanbooruQueryFilters,
    type CollectBrowseItem,
    type CollectRangeMode,
    type CollectSourceSpec,
    type DanbooruRating,
    type DanbooruSort,
    type SourceSelectionState,
  } from "#lib/domain/collect-range.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  let {
    source,
    selection,
    loadedItems,
    onchangemode,
    onchangetopn,
    onchangepages,
    ononlynew,
    onchangedanboorufilters,
  }: {
    source: CollectSourceSpec;
    selection: SourceSelectionState;
    loadedItems: readonly CollectBrowseItem[];
    onchangemode: (mode: CollectRangeMode) => void;
    onchangetopn: (n: number) => void;
    onchangepages: (start: number, end: number) => void;
    ononlynew: () => void;
    onchangedanboorufilters?: (patch: { sort?: DanbooruSort; rating?: DanbooruRating }) => void;
  } = $props();

  const uid = $props.id();
  const TOP_N_PRESETS = [20, 50, 100, 200] as const;

  const newItemsBoundary = $derived(detectNewItemsBoundary(loadedItems));
  const isEH = $derived(source.unit_kind === "page");
  const isDanbooruSearch = $derived(source.site === "danbooru" && source.kind === "search");
  const danFilters = $derived(parseDanbooruQueryFilters(source.query ?? ""));

  function updatePageStart(value: string) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      onchangepages(parsed, Math.max(parsed, selection.pageEnd));
    }
  }

  function updatePageEnd(value: string) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      onchangepages(Math.min(selection.pageStart, parsed), parsed);
    }
  }

  function updateCustomTopN(value: string) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      onchangetopn(parsed);
    }
  }
</script>

<div
  class="flex flex-col gap-2 border-b border-line bg-bg1 px-3 py-2"
  data-testid="collect-range-bar"
>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex flex-wrap items-center gap-1.5">
      {#if isEH}
        <Button
          type="button"
          size="sm"
          variant={selection.mode === "all" && selection.enabled ? "secondary" : "ghost"}
          onclick={() => onchangemode("all")}
        >
          {m.collect_v2_mode_all()}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={selection.mode === "pages" && selection.enabled ? "secondary" : "ghost"}
          onclick={() => onchangemode("pages")}
        >
          {m.collect_v2_mode_pages()}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={selection.mode === "explicit" && selection.enabled ? "secondary" : "ghost"}
          onclick={() => onchangemode("explicit")}
        >
          {m.collect_v2_mode_explicit()}
        </Button>
      {:else}
        <Button
          type="button"
          size="sm"
          variant={selection.mode === "top_n" && selection.enabled ? "secondary" : "ghost"}
          onclick={() => onchangemode("top_n")}
        >
          {m.collect_v2_mode_top_n()}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={selection.mode === "all" && selection.enabled ? "secondary" : "ghost"}
          onclick={() => onchangemode("all")}
        >
          {m.collect_v2_mode_all()}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={selection.mode === "explicit" && selection.enabled ? "secondary" : "ghost"}
          onclick={() => onchangemode("explicit")}
        >
          {m.collect_v2_mode_explicit()}
        </Button>
      {/if}

      {#if newItemsBoundary !== null && newItemsBoundary > 0}
        <Button type="button" size="sm" variant="outline" onclick={ononlynew}>
          <SparklesIcon class="size-3.5" data-icon="inline-start" />
          {m.collect_v2_only_new({ count: newItemsBoundary })}
        </Button>
      {/if}
    </div>

    <div class="flex flex-wrap items-center gap-2 text-xs text-fg2">
      {#if selection.mode === "top_n" && !isEH}
        <div class="flex items-center gap-1">
          {#each TOP_N_PRESETS as preset (preset)}
            <button
              type="button"
              class={cn(
                "rounded border px-2 py-0.5 text-2xs tabular-nums transition-colors",
                selection.topN === preset
                  ? "border-line2 bg-bg3 font-medium text-fg"
                  : "border-line bg-bg0 text-fg2 hover:border-line2",
              )}
              onclick={() => onchangetopn(preset)}
            >
              {preset}
            </button>
          {/each}
          <label for="{uid}-topn" class="sr-only">{m.collect_v2_top_n_custom()}</label>
          <Input
            id="{uid}-topn"
            type="number"
            min="1"
            max="10000"
            class="h-7 w-20 px-2 text-xs tabular-nums"
            value={String(selection.topN)}
            onchange={(event) => updateCustomTopN(event.currentTarget.value)}
          />
        </div>
      {:else if isEH && selection.mode === "pages"}
        <div class="flex items-center gap-1.5">
          <label for="{uid}-pstart" class="text-2xs text-fg3">{m.collect_v2_page_start()}</label>
          <Input
            id="{uid}-pstart"
            data-testid="collect-page-start"
            type="number"
            min="1"
            max={source.total ?? 20000}
            class="h-7 w-20 px-2 text-xs tabular-nums"
            value={String(selection.pageStart)}
            onchange={(event) => updatePageStart(event.currentTarget.value)}
          />
          <span class="text-fg3">–</span>
          <label for="{uid}-pend" class="text-2xs text-fg3">{m.collect_v2_page_end()}</label>
          <Input
            id="{uid}-pend"
            data-testid="collect-page-end"
            type="number"
            min="1"
            max={source.total ?? 20000}
            class="h-7 w-20 px-2 text-xs tabular-nums"
            value={String(selection.pageEnd)}
            onchange={(event) => updatePageEnd(event.currentTarget.value)}
          />
          {#if source.total}
            <span class="text-2xs text-fg3 tabular-nums">
              {m.collect_v2_total_pages({ total: source.total })}
            </span>
          {/if}
        </div>
      {/if}

      {#if selection.excludedIds.length > 0}
        <span class="text-2xs text-fg3 tabular-nums">
          {m.collect_v2_excluded_summary({ count: selection.excludedIds.length })}
        </span>
      {/if}
      {#if selection.mode !== "explicit" && Object.keys(selection.includedItems).length > 0}
        <span class="text-2xs text-fg2 tabular-nums">
          {m.collect_v2_extra_summary({ count: Object.keys(selection.includedItems).length })}
        </span>
      {/if}
    </div>
  </div>

  {#if isDanbooruSearch && onchangedanboorufilters}
    <div class="flex flex-wrap items-center gap-2 border-t border-line/60 pt-1.5">
      <div class="flex items-center gap-1">
        {#each [
          { value: "newest" as const, label: m.collect_v2_danbooru_newest() },
          { value: "score" as const, label: m.collect_v2_danbooru_score() },
          { value: "favcount" as const, label: m.collect_v2_danbooru_fav() },
        ] as opt (opt.value)}
          <button
            type="button"
            class={cn(
              "rounded border px-2 py-0.5 text-2xs transition-colors",
              danFilters.sort === opt.value
                ? "border-line2 bg-bg3 font-medium text-fg"
                : "border-line bg-bg0 text-fg2 hover:border-line2",
            )}
            onclick={() => onchangedanboorufilters({ sort: opt.value })}
          >
            {opt.label}
          </button>
        {/each}
      </div>

      <div class="flex items-center gap-1">
        {#each [
          { value: "all" as const, label: m.collect_v2_danbooru_rating_all() },
          { value: "general" as const, label: m.collect_v2_danbooru_rating_general() },
          { value: "safe_questionable" as const, label: m.collect_v2_danbooru_rating_safe_q() },
        ] as opt (opt.value)}
          <button
            type="button"
            class={cn(
              "rounded border px-2 py-0.5 text-2xs transition-colors",
              danFilters.rating === opt.value
                ? "border-line2 bg-bg3 font-medium text-fg"
                : "border-line bg-bg0 text-fg2 hover:border-line2",
            )}
            onclick={() => onchangedanboorufilters({ rating: opt.value })}
          >
            {opt.label}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
