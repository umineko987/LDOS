<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import SearchIcon from "@lucide/svelte/icons/search";
  import SparklesIcon from "@lucide/svelte/icons/sparkles";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";

  import { useApi } from "#lib/api/context.ts";
  import { isAbortError } from "#lib/api/errors.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    browseCollect,
    collectMediaUrl,
    createCollectSubmitTracker,
    resolveCollect,
    submitCollect,
    type CollectSiteStatus,
  } from "#lib/api/queries/collect.ts";
  import {
    autocompleteDanbooru,
    createDanbooruRequestScope,
    replaceLastDanbooruTag,
    type DanbooruTagSuggestion,
  } from "#lib/api/queries/danbooru.ts";
  import { datasetKeys, invalidateForDatasetEvent } from "#lib/api/queries/datasets.ts";
  import { accounts, accountsQuery, networkKeys } from "#lib/api/queries/network.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Textarea } from "#lib/components/ui/textarea/index.ts";
  import {
    clickCollectItem,
    compileSubmitSources,
    defaultSelectionForSource,
    estimateSelectedCount,
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
    type CollectRangeMode,
    type CollectSourceSpec,
    type DanbooruRating,
    type DanbooruSort,
    type SourceSelectionState,
  } from "#lib/domain/collect-range.ts";
  import { accountsView, authorizingSite } from "#lib/domain/network.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { COLLECT_SITES, type CollectSite } from "#lib/prefs/prefs.ts";
  import { prefs } from "#lib/prefs/prefs.svelte.ts";
  import { cn } from "#lib/utils.ts";

  import CollectCard from "./collect-card.svelte";
  import CollectRangeBar from "./collect-range-bar.svelte";
  import CollectSourceRail from "./collect-source-rail.svelte";

  let {
    datasetId,
    open = $bindable(false),
    onjobs,
  }: {
    datasetId: string;
    open?: boolean;
    onjobs: (batchId: string) => void;
  } = $props();

  type SourcePageCache = {
    readonly items: readonly CollectBrowseItem[];
    readonly nextCursor: string;
    readonly total: number | null;
    readonly loading: boolean;
    readonly error: string | null;
  };

  const URL_OR_HANDLE_RE = /^(?:https?:\/\/|(?:www\.|mobile\.)?(?:pixiv\.net|x\.com|twitter\.com|danbooru\.donmai\.us|e-hentai\.org|exhentai\.org|pawchive\.(?:pw|st))|@[A-Za-z0-9_]{1,15})/i;

  const uid = $props.id();
  const api = useApi();
  const client = useQueryClient();
  const resolveScope = createDanbooruRequestScope();
  const browseScope = createDanbooruRequestScope();
  const autocompleteScope = createDanbooruRequestScope();
  const submitTracker = createCollectSubmitTracker();

  let input = $state("");
  let resolving = $state(false);
  let resolveError = $state<string | null>(null);
  let submitError = $state<string | null>(null);
  let submitting = $state(false);
  let pendingAuthSite = $state<string | null>(null);

  let sources = $state.raw<CollectSourceSpec[]>([]);
  let selections = $state.raw<Record<string, SourceSelectionState>>({});
  let pagesBySource = $state.raw<Record<string, SourcePageCache>>({});
  let siteStatuses = $state.raw<CollectSiteStatus[]>([]);
  let warnings = $state.raw<string[]>([]);
  let activeSourceId = $state<string | null>(null);

  let suggestions = $state.raw<DanbooruTagSuggestion[]>([]);
  let autocompleteTimer: ReturnType<typeof setTimeout> | undefined;

  useOverlay(() => open, { id: "collect-workbench" });

  const SITE_LABELS = $derived<Record<CollectSite, string>>({
    danbooru: m.collect_v2_site_danbooru(),
    pixiv: m.collect_v2_site_pixiv(),
    twitter: m.collect_v2_site_twitter(),
    exhentai: m.collect_v2_site_exhentai(),
    pawchive: m.collect_v2_site_pawchive(),
  });

  const isUrlInput = $derived.by(() => {
    const tokens = input.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((tok) => URL_OR_HANDLE_RE.test(tok));
  });

  const accountsQ = createQuery(() => ({
    ...accountsQuery(api),
    enabled: open,
    refetchInterval: (current) =>
      current.state.data && authorizingSite(accountsView(current.state.data)) ? 2000 : false,
  }));

  const accountStatuses = $derived.by(() => {
    if (!accountsQ.data) return [];
    const view = accountsView(accountsQ.data);
    return view.accounts;
  });

  const effectiveSiteStatuses = $derived.by(() => {
    const bySite = new Map<string, CollectSiteStatus>(
      siteStatuses.map((st) => [st.site, st]),
    );
    for (const acc of accountStatuses) {
      const existing = bySite.get(acc.site);
      if (existing) {
        bySite.set(acc.site, {
          ...existing,
          authorized: acc.authorized,
          state: acc.session ? "authorizing" : acc.state,
          summary: acc.summary || existing.summary,
        });
      }
    }
    return [...bySite.values()];
  });

  const activeSource = $derived(
    sources.find((s) => s.id === activeSourceId) ?? null,
  );
  const activeSelection = $derived(
    activeSource ? selections[activeSource.id] ?? null : null,
  );
  const activeCache = $derived(
    activeSource ? pagesBySource[activeSource.id] ?? null : null,
  );

  const compiledSubmit = $derived.by(() => {
    const entries: { source: CollectSourceSpec; state: SourceSelectionState }[] = [];
    for (const source of sources) {
      const state = selections[source.id];
      if (state) entries.push({ source, state });
    }
    return compileSubmitSources(entries);
  });

  const footerTotals = $derived.by(() => {
    let exactSum = 0;
    let approximate = false;
    let sourceCount = 0;
    for (const source of sources) {
      const state = selections[source.id];
      if (!state?.enabled) continue;
      const est = estimateSelectedCount(source, state);
      if (est.count === 0 && !est.approximate) continue;
      sourceCount += 1;
      if (est.count === null) {
        approximate = true;
      } else {
        exactSum += est.count;
        if (est.approximate) approximate = true;
      }
    }
    return { sourceCount, count: exactSum, approximate };
  });

  const footerCountLabel = $derived.by(() => {
    if (footerTotals.sourceCount === 0) return "";
    if (footerTotals.approximate && footerTotals.count === 0) {
      return m.collect_v2_count_unknown();
    }
    if (footerTotals.approximate) {
      return m.collect_v2_count_approx({ count: footerTotals.count });
    }
    return m.collect_v2_count_exact({ count: footerTotals.count });
  });

  function updateInput(next: string) {
    input = next;
    clearTimeout(autocompleteTimer);
    suggestions = [];
    const trimmed = next.trim();
    if (!trimmed || isUrlInput || !prefs.collectSites.includes("danbooru")) {
      autocompleteScope.cancel();
      return;
    }
    const lastToken = trimmed.split(/\s+/).at(-1) ?? "";
    if (lastToken.length < 2) return;
    autocompleteTimer = setTimeout(() => {
      void fetchSuggestions(lastToken);
    }, 180);
  }

  async function fetchSuggestions(q: string) {
    const req = autocompleteScope.begin();
    try {
      const items = await autocompleteDanbooru(api, q, req.signal);
      if (req.isCurrent()) {
        suggestions = items;
      }
    } catch (error) {
      if (!isAbortError(error) && req.isCurrent()) {
        suggestions = [];
      }
    }
  }

  function applySuggestion(tag: string) {
    input = `${replaceLastDanbooruTag(input, tag)} `;
    suggestions = [];
  }

  async function handleResolve(event?: SubmitEvent) {
    event?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || resolving) return;

    suggestions = [];
    resolveError = null;
    submitError = null;
    resolving = true;
    const req = resolveScope.begin();

    try {
      const res = await resolveCollect(
        api,
        datasetId,
        isUrlInput ? { input: trimmed } : { input: trimmed, sites: [...prefs.collectSites] },
        req.signal,
      );
      if (!req.isCurrent()) return;

      const byId = new Map<string, CollectSourceSpec>();
      const nextSelections: Record<string, SourceSelectionState> = { ...selections };

      if (res.resolved_mode === "url") {
        for (const existing of sources) {
          byId.set(existing.id, existing);
        }
        for (const incoming of res.sources) {
          byId.set(incoming.id, incoming);
          if (!nextSelections[incoming.id]) {
            nextSelections[incoming.id] = defaultSelectionForSource(
              incoming,
              incoming.auto_enable ?? true,
            );
          }
        }
      } else {
        // Keep previously enabled sources and replace unenabled keyword search candidates cleanly.
        for (const existing of sources) {
          if (selections[existing.id]?.enabled) {
            byId.set(existing.id, existing);
          } else {
            delete nextSelections[existing.id];
          }
        }
        for (const incoming of res.sources) {
          byId.set(incoming.id, incoming);
          if (!nextSelections[incoming.id]) {
            nextSelections[incoming.id] = defaultSelectionForSource(
              incoming,
              incoming.auto_enable ?? false,
            );
          }
        }
      }

      sources = [...byId.values()];
      selections = nextSelections;
      siteStatuses = res.site_statuses;
      warnings = res.warnings;

      const focusTarget = res.sources[0]?.id ?? sources[0]?.id ?? null;
      if (focusTarget) {
        selectSource(focusTarget);
      }
    } catch (error) {
      if (!isAbortError(error) && req.isCurrent()) {
        resolveError = apiErrorMessage(error);
      }
    } finally {
      if (req.isCurrent()) {
        resolving = false;
      }
    }
  }

  function selectSource(sourceId: string) {
    activeSourceId = sourceId;
    const cache = pagesBySource[sourceId];
    if (!cache || (!cache.loading && cache.items.length === 0 && !cache.error)) {
      void loadSourcePage(sourceId, false);
    }
  }

  async function loadSourcePage(sourceId: string, append: boolean) {
    const source = sources.find((s) => s.id === sourceId);
    if (!source) return;

    const prev = pagesBySource[sourceId] ?? {
      items: [],
      nextCursor: "",
      total: source.total ?? null,
      loading: false,
      error: null,
    };
    const cursor = append ? prev.nextCursor : "";
    if (append && !cursor) return;

    pagesBySource = {
      ...pagesBySource,
      [sourceId]: { ...prev, loading: true, error: null },
    };

    const req = browseScope.begin();
    try {
      const res = await browseCollect(
        api,
        datasetId,
        { source, cursor, limit: 48 },
        req.signal,
      );
      if (!req.isCurrent()) return;

      const mergedItems = append ? mergeBrowseItems(prev.items, res.items) : res.items;
      const total = res.total ?? res.source.total ?? prev.total;

      sources = sources.map((s) => (s.id === sourceId ? { ...s, total } : s));
      pagesBySource = {
        ...pagesBySource,
        [sourceId]: {
          items: mergedItems,
          nextCursor: res.next_cursor,
          total,
          loading: false,
          error: null,
        },
      };
    } catch (error) {
      if (!isAbortError(error) && req.isCurrent()) {
        pagesBySource = {
          ...pagesBySource,
          [sourceId]: { ...prev, loading: false, error: apiErrorMessage(error) },
        };
      }
    }
  }

  function patchSelection(sourceId: string, updater: (cur: SourceSelectionState) => SourceSelectionState) {
    const cur = selections[sourceId];
    if (!cur) return;
    selections = { ...selections, [sourceId]: updater(cur) };
    submitError = null;
  }

  function updateDanbooruFilters(patch: { sort?: DanbooruSort; rating?: DanbooruRating }) {
    if (!activeSource || activeSource.site !== "danbooru" || activeSource.kind !== "search") return;
    const nextQuery = patchDanbooruQueryFilters(activeSource.query ?? "", patch);
    const updatedSource: CollectSourceSpec = {
      ...activeSource,
      query: nextQuery,
      total: null,
    };
    sources = sources.map((s) => (s.id === activeSource.id ? updatedSource : s));
    const { [activeSource.id]: _dropped, ...restPages } = pagesBySource;
    pagesBySource = restPages;
    void loadSourcePage(activeSource.id, false);
  }

  async function authorizeSite(site: string) {
    const account = accountStatuses.find((item) => item.site === site);
    const kind = account?.authorize ?? (site === "pixiv" ? "oauth" : "managed_browser");
    pendingAuthSite = site;
    try {
      await accounts.authorize(api, site as "pixiv" | "twitter" | "exhentai", kind);
      await client.invalidateQueries({ queryKey: networkKeys.accounts() });
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      pendingAuthSite = null;
    }
  }

  function clearAll() {
    resolveScope.cancel();
    browseScope.cancel();
    submitTracker.reset();
    sources = [];
    selections = {};
    pagesBySource = {};
    siteStatuses = [];
    warnings = [];
    activeSourceId = null;
    resolveError = null;
    submitError = null;
  }

  async function handleSubmit() {
    if (compiledSubmit.length === 0 || submitting) return;
    submitting = true;
    submitError = null;

    const payload = { sources: compiledSubmit };
    const key = submitTracker.keyFor(payload);

    try {
      const res = await submitCollect(api, datasetId, payload, key);
      submitTracker.reset();

      void client.invalidateQueries({ queryKey: datasetKeys.crawls(datasetId) });
      invalidateForDatasetEvent(client, "dataset.updated", {
        dataset_id: datasetId,
        reason: "roots",
      });

      const baseMsg =
        res.queued_count > 0 && res.reused_count > 0
          ? m.collect_v2_result_reused({ reused: res.reused_count, queued: res.queued_count })
          : res.queued_count > 0
            ? m.collect_v2_result_queued({ queued: res.queued_count })
            : m.collect_v2_result_reused_only({ reused: res.reused_count });
      const skipSuffix =
        res.skipped_count > 0 ? m.collect_v2_result_skipped({ skipped: res.skipped_count }) : "";

      const batchId = res.batch_id;
      open = false;

      if (batchId) {
        toast.success(`${baseMsg}${skipSuffix}`, {
          action: {
            label: m.collect_crawl_view(),
            onClick: () => onjobs(batchId),
          },
        });
      } else {
        toast.success(`${baseMsg}${skipSuffix}`);
      }
    } catch (error) {
      if (!isAbortError(error)) {
        submitError = apiErrorMessage(error);
      }
    } finally {
      submitting = false;
    }
  }

  function onInputKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleResolve();
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="top-[3dvh] flex h-[92dvh] max-h-[92dvh] w-[min(1200px,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0"
    data-testid="collect-workbench"
  >
    <div class="flex flex-col gap-2.5 border-b border-line bg-bg1 px-4 py-3">
      <div class="flex items-start justify-between gap-4 pr-7">
        <div class="flex flex-col gap-0.5">
          <Dialog.Title class="text-base font-semibold">{m.collect_v2_title()}</Dialog.Title>
          <Dialog.Description class="text-xs text-fg3">{m.collect_v2_hint()}</Dialog.Description>
        </div>
      </div>

      <form class="flex flex-col gap-2" onsubmit={(event) => void handleResolve(event)}>
        <div class="relative flex flex-col gap-2 sm:flex-row sm:items-start">
          <div class="relative min-w-0 flex-1">
            <label for="{uid}-omnibox" class="sr-only">{m.collect_v2_title()}</label>
            <Textarea
              id="{uid}-omnibox"
              data-testid="collect-omnibox"
              rows={isUrlInput ? 2 : 1}
              class="min-h-control resize-none py-2 text-sm"
              placeholder={m.collect_v2_input_placeholder()}
              value={input}
              oninput={(event) => updateInput(event.currentTarget.value)}
              onkeydown={onInputKeydown}
            />
            {#if suggestions.length > 0}
              <ul
                class="absolute top-full left-0 z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-line2 bg-bg1 p-1 shadow-over"
                role="listbox"
              >
                {#each suggestions as suggestion (suggestion.value)}
                  <li>
                    <button
                      type="button"
                      class="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-bg2"
                      onclick={() => applySuggestion(suggestion.value)}
                    >
                      <span class="truncate font-medium text-fg">{suggestion.label}</span>
                      {#if suggestion.count !== null}
                        <span class="text-2xs text-fg3 tabular-nums">{suggestion.count}</span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <Button
            type="submit"
            size="sm"
            class="shrink-0 sm:mt-0.5"
            disabled={!input.trim() || resolving}
            data-testid="collect-resolve-btn"
          >
            {#if resolving}
              <LoaderCircleIcon class="size-4 animate-spin" data-icon="inline-start" />
              {m.collect_v2_resolving()}
            {:else}
              <SearchIcon class="size-4" data-icon="inline-start" />
              {m.collect_v2_resolve_btn()}
            {/if}
          </Button>
        </div>

        {#if !isUrlInput}
          <div class="flex flex-wrap items-center gap-1.5" data-testid="collect-site-pills">
            <span class="text-2xs text-fg3">{m.collect_v2_sites_label()}</span>
            {#each COLLECT_SITES as site (site)}
              {@const checked = prefs.collectSites.includes(site)}
              <button
                type="button"
                aria-pressed={checked}
                data-collect-site={site}
                class={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-gold",
                  checked
                    ? "border-line2 bg-bg3 font-medium text-fg"
                    : "border-line bg-bg0 text-fg3 hover:border-line2 hover:text-fg2",
                )}
                onclick={() => prefs.toggleCollectSite(site)}
              >
                {#if checked}<CheckIcon class="size-3" aria-hidden="true" />{/if}
                {SITE_LABELS[site]}
              </button>
            {/each}
          </div>
        {/if}

        {#if resolveError}
          <p class="text-xs text-danger" role="alert">{resolveError}</p>
        {/if}
        {#each warnings as warning (warning)}
          <p class="text-2xs text-warn">{warning}</p>
        {/each}
      </form>
    </div>

    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <CollectSourceRail
        {sources}
        {selections}
        {activeSourceId}
        siteStatuses={effectiveSiteStatuses}
        authorizingSite={pendingAuthSite}
        onselectsource={selectSource}
        ontoggleenabled={(sourceId) =>
          patchSelection(sourceId, (cur) => toggleSourceEnabled(cur))}
        onauthorizesite={(site) => void authorizeSite(site)}
        onclearall={clearAll}
      />

      <main class="flex min-h-0 min-w-0 flex-1 flex-col bg-bg0">
        {#if activeSource && activeSelection}
          <CollectRangeBar
            source={activeSource}
            selection={activeSelection}
            loadedItems={activeCache?.items ?? []}
            onchangemode={(mode: CollectRangeMode) =>
              patchSelection(activeSource.id, (cur) => setRangeMode(activeSource, cur, mode))}
            onchangetopn={(n: number) =>
              patchSelection(activeSource.id, (cur) => setTopN(cur, n))}
            onchangepages={(start: number, end: number) =>
              patchSelection(activeSource.id, (cur) => setPageRange(activeSource, cur, start, end))}
            ononlynew={() =>
              patchSelection(activeSource.id, (cur) =>
                selectOnlyNewItems(cur, activeCache?.items ?? []),
              )}
            onchangedanboorufilters={updateDanbooruFilters}
          />

          <div class="min-h-0 flex-1 overflow-y-auto p-3" data-testid="collect-grid-scroll">
            {#if activeCache?.error}
              <div class="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <p class="text-sm text-danger" role="alert">{activeCache.error}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onclick={() => void loadSourcePage(activeSource.id, false)}
                >
                  {m.collect_v2_resolve_btn()}
                </Button>
              </div>
            {:else if activeCache?.loading && activeCache.items.length === 0}
              <div class="flex items-center justify-center gap-2 py-16 text-sm text-fg3">
                <LoaderCircleIcon class="size-5 animate-spin" aria-hidden="true" />
                {m.collect_v2_loading()}
              </div>
            {:else if !activeCache || activeCache.items.length === 0}
              <div class="flex items-center justify-center py-16 text-sm text-fg3">
                {m.collect_v2_empty_grid()}
              </div>
            {:else}
              <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {#each activeCache.items as item, idx (item.id)}
                  <CollectCard
                    {item}
                    index={idx}
                    previewUrl={collectMediaUrl(api, item.preview_url)}
                    selected={isItemSelected(activeSource, activeSelection, item, idx)}
                    excluded={isItemExplicitlyExcluded(activeSource, activeSelection, item, idx)}
                    onclick={(itemIdx, shiftKey) =>
                      patchSelection(activeSource.id, (cur) =>
                        clickCollectItem(activeSource, cur, activeCache.items, itemIdx, shiftKey),
                      )}
                    onselectuntil={(itemIdx) =>
                      patchSelection(activeSource.id, (cur) =>
                        selectUntilItem(activeSource, cur, activeCache.items, itemIdx),
                      )}
                  />
                {/each}
              </div>

              {#if activeCache.nextCursor}
                <div class="mt-4 flex justify-center">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={activeCache.loading}
                    data-testid="collect-load-more"
                    onclick={() => void loadSourcePage(activeSource.id, true)}
                  >
                    {#if activeCache.loading}
                      <LoaderCircleIcon class="size-4 animate-spin" data-icon="inline-start" />
                    {/if}
                    {m.collect_v2_load_more()}
                  </Button>
                </div>
              {/if}
            {/if}
          </div>
        {:else}
          <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-fg3">
            <SparklesIcon class="size-6 text-fg3" aria-hidden="true" />
            <p class="max-w-md text-sm">{m.collect_v2_empty_rail()}</p>
          </div>
        {/if}
      </main>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-bg1 px-4 py-2.5">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        {#if footerTotals.sourceCount > 0}
          <span class="text-xs font-medium text-fg tabular-nums" data-testid="collect-footer-summary">
            {m.collect_v2_footer_summary({
              sources: footerTotals.sourceCount,
              count: footerCountLabel,
            })}
          </span>
        {:else}
          <span class="text-xs text-fg3">{m.collect_v2_footer_empty()}</span>
        {/if}
        {#if submitError}
          <span class="text-xs text-danger" role="alert">{submitError}</span>
        {/if}
      </div>

      <div class="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onclick={() => (open = false)}>
          {m.common_cancel()}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={compiledSubmit.length === 0 || submitting}
          data-testid="collect-submit-btn"
          onclick={() => void handleSubmit()}
        >
          {#if submitting}
            <LoaderCircleIcon class="size-4 animate-spin" data-icon="inline-start" />
            {m.collect_v2_submitting()}
          {:else}
            {m.collect_v2_submit()}
          {/if}
        </Button>
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
