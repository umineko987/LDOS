<script lang="ts">
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
  import ImagesIcon from "@lucide/svelte/icons/images";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import SearchIcon from "@lucide/svelte/icons/search";
  import XIcon from "@lucide/svelte/icons/x";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { tick, untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import type { Snippet } from "svelte";

  import { useApi } from "#lib/api/context.ts";
  import { ApiError, isAbortError } from "#lib/api/errors.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { browseDanbooru, canCollectDanbooruPost, clearDanbooruQuery, collectDanbooru, createDanbooruRequestScope, DANBOORU_COLLECT_LIMIT, danbooruMediaUrl, danbooruQueryText, mergeDanbooruPosts, selectedDanbooruTokens, type DanbooruKind, type DanbooruPost, type DanbooruQueryDraft } from "#lib/api/queries/danbooru.ts";
  import { invalidateForDatasetEvent } from "#lib/api/queries/datasets.ts";
  import { browseWorkbench, collectWorkbench, newWorkbenchAttempt, readWorkbenchCheckpoint, saveWorkbenchCheckpoint, workbenchCheckpointSource, WORKBENCH_BROWSE_LIMIT, WORKBENCH_EH_BROWSE_LIMIT, WORKBENCH_PAGE_SIZE, WORKBENCH_SUBMIT_LIMIT, type WorkbenchAddress, type WorkbenchAttempt, type WorkbenchPreview, type WorkbenchSource } from "#lib/api/queries/workbench.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  import DanbooruFilters from "./danbooru-filters.svelte";
  import WorkbenchCard from "./workbench-card.svelte";
  import { emptyScope, isStablePrefix, parsePageRange, projectScope, selectLoadedScope, toggleScopeItem, type CollectionScope, type ScopeItem } from "./workbench-selection.ts";

  let { datasetId, open = $bindable(false), address, ondiscovery, onlegacy, onjobs, dialogs }: {
    datasetId: string;
    open?: boolean;
    address: WorkbenchAddress | null;
    ondiscovery: () => void;
    onlegacy: () => void;
    dialogs: Snippet;
    onjobs: (batchId: string) => void;
  } = $props();

  type Item = ScopeItem & { title: string; author: string; preview: string; sample: string; meta: string; status: string };
  type RemotePage = { response: WorkbenchPreview; requested: number };
  const uid = $props.id();
  const api = useApi();
  const client = useQueryClient();
  const browsing = createDanbooruRequestScope();
  const collecting = createDanbooruRequestScope();
  const sources = $derived([
    { value: "danbooru" as const, label: "Danbooru" },
    { value: "pixiv" as const, label: "Pixiv" },
    { value: "twitter" as const, label: m.collect_workbench_source_x() },
    { value: "exhentai" as const, label: "EH" },
  ]);
  const danbooruKinds = $derived([
    { value: "search" as const, label: m.danbooru_mode_search() },
    { value: "pool" as const, label: m.danbooru_mode_pool() },
    { value: "favorite_group" as const, label: m.danbooru_mode_group() },
    { value: "favorites" as const, label: m.danbooru_mode_favorites() },
  ]);

  let site = $state<WorkbenchSource>("danbooru");
  let kind = $state<DanbooruKind>("search");
  let draft = $state<DanbooruQueryDraft>(clearDanbooruQuery());
  let location = $state("");
  let posts = $state.raw<DanbooruPost[]>([]);
  let cursor = $state("");
  let warnings = $state.raw<string[]>([]);
  let danbooruTotal = $state<number | null>(null);
  let remote = $state.raw<RemotePage | null>(null);
  let replacement = $state.raw<RemotePage | null>(null);
  let scope = $state.raw<CollectionScope>(emptyScope());
  let startPage = $state("1");
  let endPage = $state("");
  let rangeError = $state("");
  let focusedId = $state<string | null>(null);
  let inspector = $state<HTMLElement | null>(null);
  let gallery = $state<HTMLElement | null>(null);
  let previewFailed = $state("");
  let origin: HTMLButtonElement | null = null;
  let searching = $state(false);
  let loaded = $state(false);
  let saving = $state(false);
  let expired = $state(false);
  let browseError = $state("");
  let retryBrowse = $state<{ more: boolean; limit?: number } | null>(null);
  let submitError = $state("");
  let attempt = $state.raw<WorkbenchAttempt | null>(null);
  let checkpoint = $state<string | null>(null);

  const query = $derived(site === "danbooru" && kind === "search" ? danbooruQueryText(draft) : "");
  const sourceKey = $derived(workbenchCheckpointSource(site, kind, query, location));
  const canBrowse = $derived(site === "danbooru" && (kind === "search" || kind === "favorites") || location.trim().length > 0);
  const canEdit = $derived(!saving && !attempt && !replacement);
  const items = $derived<Item[]>(site === "danbooru" ? posts.map((post) => ({
    id: post.id,
    title: post.title || m.danbooru_post({ id: post.id }),
    author: (post.tags.artist ?? []).join(" · "),
    preview: danbooruMediaUrl(api, post.preview_url),
    sample: danbooruMediaUrl(api, post.sample_url),
    collectable: canCollectDanbooruPost(post),
    meta: `${post.width}×${post.height} · ${post.file_ext.toUpperCase()}`,
    status: post.in_dataset ? m.danbooru_in_dataset() : post.local_asset_id ? m.danbooru_in_library() : post.downloadable ? "" : post.unavailable_reason || m.danbooru_unavailable(),
  })) : (remote?.response.items ?? []).map((item) => ({
    id: item.id,
    page: item.page,
    title: item.title || (item.page != null ? m.collect_workbench_page({ page: item.page }) : item.id),
    author: item.author ?? "",
    preview: danbooruMediaUrl(api, item.preview_url),
    sample: "",
    collectable: true,
    meta: item.page != null ? m.collect_workbench_page({ page: item.page }) : m.collect_crawl_media({ count: item.media_count }),
    status: "",
  })));
  const projection = $derived(projectScope(items, scope));
  const selected = $derived(new Set(projection.ids));
  const total = $derived(site === "danbooru" ? danbooruTotal : remote?.response.total);
  const maxSelection = $derived(site === "danbooru" ? DANBOORU_COLLECT_LIMIT : WORKBENCH_SUBMIT_LIMIT);
  const browseLimit = $derived(site === "exhentai" ? WORKBENCH_EH_BROWSE_LIMIT : WORKBENCH_BROWSE_LIMIT);
  const hasMore = $derived(site === "danbooru" ? !!cursor : !!remote?.response.has_more);
  const canLoadMore = $derived(hasMore && !expired && (site === "danbooru" || (remote?.requested ?? 0) < browseLimit));
  const focused = $derived(items.find((item) => item.id === focusedId));
  const detailImage = $derived(focused?.sample || focused?.preview || "");
  const canSubmit = $derived(!saving && !searching && !expired && !replacement && !rangeError && projection.ready && projection.ids.length > 0 && projection.ids.length <= maxSelection);
  const newestFirst = $derived(site !== "danbooru" || (kind === "search" && !/(?:^|\s)order:(?!id_desc(?:\s|$))/i.test(query)));

  function clearSnapshot() {
    posts = [];
    cursor = "";
    warnings = [];
    danbooruTotal = null;
    remote = null;
    replacement = null;
    loaded = false;
    scope = emptyScope();
    focusedId = null;
    origin = null;
    checkpoint = null;
    expired = false;
    rangeError = "";
    submitError = "";
    attempt = null;
  }

  function clearSource() {
    browsing.cancel();
    searching = false;
    browseError = "";
    retryBrowse = null;
    startPage = "1";
    endPage = "";
    clearSnapshot();
  }

  $effect.pre(() => {
    const next = address;
    const id = datasetId;
    if (open) untrack(() => {
      clearSource();
      site = next?.site ?? "danbooru";
      kind = "search";
      draft = next?.site === "danbooru" ? { mode: "raw", text: next.query } : clearDanbooruQuery();
      location = next && next.site !== "danbooru" ? next.url : "";
      saving = false;
      if (next) void browse(false, undefined, id);
    });
    return () => { browsing.cancel(); collecting.cancel(); };
  });

  function changeSite(next: WorkbenchSource) {
    if (!canEdit || site === next) return;
    clearSource();
    site = next;
    kind = "search";
    location = "";
  }

  function changeKind(next: DanbooruKind) {
    if (!canEdit || kind === next) return;
    clearSource();
    kind = next;
    location = "";
  }

  function changeDraft(next: DanbooruQueryDraft) {
    if (danbooruQueryText(next) !== query) clearSource();
    draft = next;
  }

  function changeLocation(next: string) {
    if (next.trim() !== location.trim()) clearSource();
    location = next;
  }

  function stopBrowse() {
    browsing.cancel();
    searching = false;
  }

  function loadCheckpoint(key: string | null) {
    if (!key) return;
    try {
      checkpoint = readWorkbenchCheckpoint(localStorage, datasetId, key);
    } catch {
      checkpoint = null;
    }
  }

  async function browse(more = false, limit?: number, id = datasetId) {
    if (!canBrowse || !canEdit || searching || (more && !canLoadMore)) return;
    const request = browsing.begin();
    const key = sourceKey;
    const url = location.trim();
    searching = true;
    browseError = "";
    retryBrowse = { more, limit };
    try {
      if (site === "danbooru") {
        const page = await browseDanbooru(api, {
          dataset_id: id, kind, query, reference: url, cursor: more ? cursor : "", limit: WORKBENCH_PAGE_SIZE, count: !more,
        }, request.signal);
        if (!request.isCurrent()) return;
        if (!more) clearSnapshot();
        posts = mergeDanbooruPosts(more ? posts : [], page.items);
        cursor = page.next_cursor;
        if (!more || page.total !== null) danbooruTotal = page.total;
        warnings = [...new Set([...warnings, ...page.warnings])];
      } else {
        const previousLimit = remote?.requested ?? 0;
        const requested = limit ?? (more ? Math.min(previousLimit * 2, browseLimit) : WORKBENCH_PAGE_SIZE);
        const response = await browseWorkbench(api, id, site, url, requested, request.signal);
        if (!request.isCurrent()) return;
        if (more && remote && !isStablePrefix(remote.response.items, response.items)) {
          replacement = { response, requested };
          return;
        }
        if (!more) clearSnapshot();
        remote = { response, requested };
      }
      loaded = true;
      loadCheckpoint(key);
    } catch (error) {
      if (!request.isCurrent() || isAbortError(error)) return;
      if (error instanceof ApiError && error.status === 410) {
        expired = true;
        retryBrowse = { more: false };
        browseError = m.collect_workbench_expired();
      } else browseError = apiErrorMessage(error);
    } finally {
      if (request.isCurrent()) searching = false;
    }
  }

  function acceptReplacement(next: RemotePage) {
    clearSnapshot();
    remote = next;
    loaded = true;
    loadCheckpoint(sourceKey);
  }

  function setScope(next: CollectionScope) {
    scope = next;
    rangeError = "";
    submitError = "";
  }

  function canToggle(item: ScopeItem) {
    return canEdit && !expired && item.collectable && (scope.kind === "manual" || projection.eligible.has(item.id));
  }

  function toggle(item: ScopeItem) {
    if (canToggle(item)) setScope(toggleScopeItem(scope, item, projection.eligible));
  }

  function newer(item: ScopeItem) {
    setScope({ kind: "newer", boundary: item.id, includeBoundary: false, excluded: new Set() });
    closeInspector();
  }

  function interval(edge: "start" | "end", item: ScopeItem) {
    const previous = scope.kind === "interval" ? scope : null;
    setScope({ kind: "interval", start: previous?.start ?? null, end: previous?.end ?? null, [edge]: item.id, excluded: new Set() });
    closeInspector();
  }

  function applyPages(event: SubmitEvent) {
    event.preventDefault();
    const range = parsePageRange(startPage, endPage);
    if (!range) {
      rangeError = m.collect_workbench_page_invalid();
      return;
    }
    setScope({ kind: "pages", ...range, excluded: new Set() });
    if (range.end > browseLimit) rangeError = m.collect_workbench_page_limit({ max: browseLimit });
    else if (total != null && range.end > total) rangeError = m.collect_workbench_page_total({ total });
    else if (canLoadMore && range.end > (remote?.requested ?? 0)) void browse(true, range.end);
  }

  async function showInspector(item: ScopeItem, trigger: HTMLButtonElement) {
    focusedId = item.id;
    origin = trigger;
    previewFailed = "";
    await tick();
    if (focusedId === item.id) inspector?.focus({ preventScroll: true });
  }

  async function closeInspector() {
    const trigger = origin;
    focusedId = null;
    origin = null;
    await tick();
    trigger?.focus({ preventScroll: true });
  }

  function showCheckpoint() {
    if (!checkpoint) return;
    const trigger = gallery?.querySelector<HTMLButtonElement>(`[data-workbench-item="${CSS.escape(checkpoint)}"] > button`);
    trigger?.focus();
    trigger?.click();
  }

  async function submit() {
    if (!canSubmit) return;
    const id = datasetId;
    const key = sourceKey;
    if (!attempt) {
      if (site === "danbooru") {
        attempt = newWorkbenchAttempt({ site, ids: projection.ids, tokens: selectedDanbooruTokens(posts, selected) });
      } else if (remote) {
        attempt = newWorkbenchAttempt({ site, ids: projection.ids, snapshotId: remote.response.snapshot_id });
      }
    }
    const payload = attempt;
    if (!payload) return;
    const request = collecting.begin();
    saving = true;
    submitError = "";
    try {
      let message = m.collect_crawl_started();
      let batchId: string | null;
      let acceptedExactly = true;
      if (payload.site === "danbooru") {
        const result = await collectDanbooru(api, id, payload.tokens, payload.key, request.signal);
        batchId = result.batch_id;
        acceptedExactly = result.skipped_count === 0;
        message = m.danbooru_collect_result({ queued: result.queued_count, reused: result.reused_count, skipped: result.skipped_count });
      } else {
        batchId = (await collectWorkbench(api, id, payload, request.signal)).batch_id;
      }
      invalidateForDatasetEvent(client, "dataset.updated", { dataset_id: id, reason: "roots" });
      if (batchId && acceptedExactly && key) {
        try {
          saveWorkbenchCheckpoint(localStorage, id, key, payload.ids[0]);
        } catch {
          // Local history is optional. A failed write cannot undo an accepted batch.
        }
      }
      if (!request.isCurrent()) return;
      const batch = batchId;
      if (batch) toast.success(message, { action: { label: m.collect_crawl_view(), onClick: () => onjobs(batch) } });
      else toast.info(message);
      open = false;
    } catch (error) {
      if (!request.isCurrent() || isAbortError(error)) return;
      if (error instanceof ApiError && error.status === 410) {
        expired = true;
        attempt = null;
        submitError = m.collect_workbench_expired();
      } else submitError = apiErrorMessage(error);
    } finally {
      if (request.isCurrent()) saving = false;
    }
  }

  function scopeLabel() {
    if (scope.kind === "newer") return scope.includeBoundary
      ? m.collect_workbench_scope_through({ id: scope.boundary }) : m.collect_workbench_scope_before({ id: scope.boundary });
    if (scope.kind === "interval") return scope.start && scope.end
      ? m.collect_workbench_scope_interval({ start: scope.start, end: scope.end }) : m.collect_workbench_interval_pending();
    if (scope.kind === "pages") return m.collect_workbench_scope_pages({ start: scope.start, end: scope.end });
    return m.collect_workbench_scope_manual();
  }

  useOverlay(() => open, { id: "collect-workbench" });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="top-[2dvh] flex h-[96dvh] w-[97vw] flex-col gap-0 overflow-hidden p-0"
    showCloseButton={false} data-testid="collect-workbench" interactOutsideBehavior="ignore"
    onEscapeKeydown={(event) => {
      if (focused || saving) event.preventDefault();
      if (focused) closeInspector();
    }}>
    <Dialog.Header class="relative flex-none gap-1 border-b border-line px-3 py-3 pr-12 sm:px-5 sm:pr-14">
      <Dialog.Title class="text-lg">{m.collect_workbench_title()}</Dialog.Title>
      <Dialog.Description class="text-xs">{m.collect_workbench_hint()}</Dialog.Description>
      <Dialog.Close>
        {#snippet child({ props })}
          <Button variant="ghost" size="icon-sm" class="absolute top-3 right-3" aria-label={m.common_close()} disabled={saving} {...props}><XIcon /></Button>
        {/snippet}
      </Dialog.Close>
    </Dialog.Header>

    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <section class="source-panel min-h-0 flex-none overflow-y-auto border-b border-line bg-bg1 px-3 py-3 md:w-76 md:border-r md:border-b-0 md:px-4" aria-label={m.collect_workbench_sources()}>
        <div class="flex flex-col gap-3">
          <Segmented options={sources} value={site} onchange={changeSite} label={m.collect_workbench_sources()} size="sm" class="w-fit max-w-full flex-wrap" />
          <form class="flex flex-col gap-2.5" onsubmit={(event) => { event.preventDefault(); void browse(); }}>
            <fieldset class="flex min-w-0 flex-col gap-2.5" disabled={!canEdit}>
              <legend class="sr-only">{m.collect_workbench_sources()}</legend>
              {#if site === "danbooru"}
                <Segmented options={danbooruKinds} value={kind} onchange={changeKind} label={m.danbooru_source_type()} class="w-fit max-w-full flex-wrap" />
                {#if kind === "search"}
                  <DanbooruFilters {draft} onchange={changeDraft} compact />
                {:else}
                  <label class="flex flex-col gap-1 text-xs text-fg2" for="{uid}-address">
                    {kind === "favorites" ? m.danbooru_favorites_reference() : m.danbooru_collection_reference()}
                    <Input id="{uid}-address" autocomplete="off" value={location} oninput={(event) => changeLocation(event.currentTarget.value)} />
                  </label>
                {/if}
              {:else}
                <label for="{uid}-address" class="flex flex-col gap-1 text-xs text-fg2">
                  {site === "pixiv" ? m.collect_workbench_pixiv_address() : site === "twitter" ? m.collect_workbench_x_address() : m.collect_workbench_eh_address()}
                  <Input id="{uid}-address" type="url" autocomplete="off" placeholder="https://" value={location}
                    oninput={(event) => changeLocation(event.currentTarget.value)} />
                </label>
              {/if}
            </fieldset>
            <div class="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" variant="outline" disabled={!canBrowse || !canEdit || searching}>
                <SearchIcon data-icon="inline-start" />{loaded ? m.collect_workbench_refresh() : m.collect_workbench_preview()}
              </Button>
              {#if searching}<Button type="button" size="sm" variant="ghost" onclick={stopBrowse}>{m.danbooru_stop_loading()}</Button>{/if}
            </div>
          </form>
          <div class="flex flex-wrap gap-1.5 border-t border-line pt-2.5">
            <Button size="sm" variant="ghost" disabled={!canEdit} onclick={ondiscovery}>{m.collect_workbench_find_sources()}</Button>
            <Button size="sm" variant="ghost" disabled={!canEdit} onclick={onlegacy}>{m.collect_workbench_address_mode()}</Button>
          </div>
          {#if site === "exhentai" && loaded}
            <form class="flex flex-col gap-2 border-t border-line pt-2.5" onsubmit={applyPages}>
              <h3 class="text-sm font-medium">{m.collect_workbench_page_range()}</h3>
              <div class="grid grid-cols-2 gap-2">
                <label class="flex flex-col gap-0.5 text-xs text-fg2" for="{uid}-first">{m.collect_workbench_page_start()}
                  <Input id="{uid}-first" inputmode="numeric" bind:value={startPage} disabled={!canEdit || expired} />
                </label>
                <label class="flex flex-col gap-0.5 text-xs text-fg2" for="{uid}-last">{m.collect_workbench_page_end()}
                  <Input id="{uid}-last" inputmode="numeric" bind:value={endPage} disabled={!canEdit || expired} />
                </label>
              </div>
              <Button type="submit" size="sm" variant="outline" class="self-start" disabled={!canEdit || searching || expired}>{m.collect_workbench_apply_pages()}</Button>
              {#if rangeError}<p role="alert" class="text-xs text-danger">{rangeError}</p>{/if}
            </form>
          {/if}
        </div>
      </section>

      <section class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg0" aria-label={m.collect_workbench_canvas()}>
        <div class="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-bg1 px-3 py-2 sm:px-4">
          <div class="mr-auto flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-medium">{m.collect_workbench_canvas()}</h3>
            {#if loaded}<span class="text-xs text-fg2 tabular-nums" role="status">{m.danbooru_loaded({ count: items.length })}{#if total != null} · {m.collect_workbench_total({ count: total })}{/if}</span>{/if}
          </div>
          {#if items.length}
            <Button size="sm" variant="ghost" disabled={!canEdit || expired} onclick={() => setScope(selectLoadedScope(items))}>{m.collect_workbench_select_loaded()}</Button>
            <Button size="sm" variant="ghost" disabled={!canEdit || (scope.kind === "manual" && !selected.size)} onclick={() => setScope(emptyScope())}>{m.collect_clear_selection()}</Button>
          {/if}
        </div>

        <div bind:this={gallery} class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4" aria-busy={searching || undefined} inert={!!focused}>
          {#if checkpoint}
            <div class="mb-3 flex flex-wrap items-center gap-2 border-b border-line pb-2 text-xs text-fg2">
              <Badge variant="outline">{m.collect_workbench_last_submitted()}</Badge>
              <span class="font-mono">#{checkpoint}</span>
              {#if items.some(({ id }) => id === checkpoint)}
                <Button variant="ghost" size="sm" onclick={showCheckpoint}>{m.collect_workbench_find_checkpoint()}</Button>
              {:else}<span>{m.collect_workbench_checkpoint_missing()}</span>{/if}
            </div>
          {/if}
          {#if browseError}
            <div class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg1 p-3 text-xs text-danger" role="alert">
              <span>{loaded && !expired ? m.collect_workbench_browse_failed({ error: browseError }) : browseError}</span>
              {#if retryBrowse}
                {@const retry = retryBrowse}
                <Button size="sm" variant="outline" disabled={searching || !canEdit} onclick={() => void browse(retry.more, retry.limit)}>{expired ? m.danbooru_reload() : m.common_retry()}</Button>
              {/if}
            </div>
          {/if}
          {#if replacement}
            {@const next = replacement}
            <div class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg1 p-3" role="alert">
              <p class="w-full text-xs text-fg2">{m.collect_workbench_prefix_changed()}</p>
              <Button size="sm" variant="outline" onclick={() => acceptReplacement(next)}>{m.collect_workbench_use_updated()}</Button>
              <Button size="sm" variant="ghost" onclick={() => (replacement = null)}>{m.collect_workbench_keep_current()}</Button>
            </div>
          {/if}
          {#if warnings.length}
            <ul class="mb-3 grid gap-1 text-xs text-warn" aria-label={m.danbooru_warnings()}>{#each warnings as warning (warning)}<li>{warning}</li>{/each}</ul>
          {/if}
          {#if items.length}
            <div class="media-grid grid gap-2.5">
              {#each items as item (item.id)}
                <WorkbenchCard id={item.id} title={item.title} preview={item.preview} meta={item.meta} status={item.status}
                  selected={selected.has(item.id)} disabled={!canToggle(item)} focused={focusedId === item.id} checkpoint={checkpoint === item.id}
                  onfocusitem={(trigger) => void showInspector(item, trigger)} ontoggle={() => toggle(item)} />
              {/each}
            </div>
          {:else}
            <div class="flex min-h-28 flex-col items-center justify-center gap-2 px-3 text-center text-fg2" role="status">
              {#if searching}<LoaderCircleIcon class="size-5 animate-spin" aria-hidden="true" />
              {:else}<ImagesIcon class="size-6" aria-hidden="true" />{/if}
              <p class="max-w-sm text-sm">{searching ? m.danbooru_loading() : loaded ? m.collect_workbench_empty() : m.collect_workbench_idle()}</p>
            </div>
          {/if}
          {#if canLoadMore}
            <div class="flex justify-center py-4">
              <Button variant="outline" size="sm" disabled={searching || !canEdit} onclick={() => void browse(true)}>
                {#if searching}<LoaderCircleIcon class="animate-spin" data-icon="inline-start" />{:else}<ArrowDownIcon data-icon="inline-start" />{/if}{m.danbooru_load_more()}
              </Button>
            </div>
          {:else if hasMore && !expired}<p class="py-3 text-center text-xs text-fg2">{m.collect_workbench_browse_limit({ max: browseLimit })}</p>{/if}
        </div>

        {#if focused}
          <aside bind:this={inspector} tabindex="-1" aria-label={m.collect_workbench_inspector()} class="absolute inset-y-0 right-0 flex w-[min(100%,21rem)] flex-col gap-3 overflow-y-auto border-l border-line2 bg-bg1 p-3 shadow-over outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-4">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <p class="text-xs text-fg2">{m.collect_workbench_inspector()}</p>
                <h3 class="break-words text-base font-medium">{focused.title}</h3>
              </div>
              <Button size="icon-sm" variant="ghost" aria-label={m.danbooru_close_details()} onclick={closeInspector}><XIcon /></Button>
            </div>
            {#if detailImage && previewFailed !== detailImage}
              <img src={detailImage} alt={focused.title} crossorigin="anonymous" decoding="async" class="max-h-[38dvh] w-full rounded-md bg-bg0 object-contain" onerror={() => (previewFailed = detailImage)} />
            {:else}<p class="rounded-md bg-bg0 px-3 py-6 text-center text-xs text-fg2">{detailImage ? m.danbooru_preview_failed() : m.danbooru_no_preview()}</p>{/if}
            <p class="break-words text-xs text-fg2">{focused.meta}{#if focused.author} · {focused.author}{/if}{#if focused.status} · {focused.status}{/if}</p>
            <div class="flex flex-wrap gap-2 border-t border-line pt-3">
              <Button size="sm" variant="outline" disabled={!canToggle(focused)} onclick={() => focused && toggle(focused)}>{selected.has(focused.id) ? m.collect_exclude() : m.collect_workbench_select()}</Button>
              {#if site !== "exhentai"}
                <Button size="sm" variant="outline" disabled={!canEdit || expired} onclick={() => focused && newer(focused)}>{newestFirst ? m.collect_workbench_newer() : m.collect_workbench_before()}</Button>
                <Button size="sm" variant="outline" disabled={!canEdit || expired} onclick={() => focused && interval("start", focused)}>{m.collect_workbench_set_start()}</Button>
                <Button size="sm" variant="outline" disabled={!canEdit || expired} onclick={() => focused && interval("end", focused)}>{m.collect_workbench_set_end()}</Button>
              {/if}
            </div>
          </aside>
        {/if}
      </section>
    </div>

    <footer class="flex flex-none flex-wrap items-center gap-2 border-t border-line bg-bg1 px-3 py-3 sm:px-5" data-testid="collect-workbench-scope">
      <div class="mr-auto flex min-w-0 flex-col gap-0.5" aria-live="polite">
        <p class="font-medium tabular-nums">{m.collect_workbench_selected({ count: selected.size })}</p>
        <p class="break-words text-xs text-fg2">
          {scopeLabel()}
          {#if scope.kind !== "manual" && scope.excluded.size} · {m.collect_workbench_excluded({ count: scope.excluded.size })}{/if}
        </p>
        {#if scope.kind === "pages" && !projection.ready}<p class="text-xs text-warn">{m.collect_workbench_pages_missing()}</p>{/if}
        {#if selected.size > maxSelection}<p class="text-xs text-danger" role="alert">{m.collect_workbench_submit_limit({ max: maxSelection })}</p>{/if}
        {#if submitError}<p class="text-xs text-danger" role="alert">{submitError}</p>{/if}
        {#if attempt && submitError}<p class="text-xs text-fg2">{m.collect_workbench_retry_hint()}</p>{/if}
      </div>
      {#if scope.kind === "newer"}
        {@const current = scope}
        <label class="flex items-center gap-2 text-xs text-fg2">
          <Checkbox checked={current.includeBoundary} disabled={!canEdit || expired} onCheckedChange={(value) => setScope({ ...current, includeBoundary: value })} />
          {m.collect_workbench_include_boundary()}
        </label>
      {/if}
      {#if expired}
        <Button size="sm" variant="outline" disabled={searching} onclick={() => void browse()}>{m.danbooru_reload()}</Button>
      {:else if attempt && submitError}
        <Button size="sm" variant="ghost" onclick={() => { attempt = null; submitError = ""; }}>{m.collect_workbench_edit_scope()}</Button>
      {/if}
      <Button size="sm" variant="primary" disabled={!canSubmit} onclick={() => void submit()} data-testid="collect-workbench-submit">
        {#if saving}<LoaderCircleIcon class="animate-spin" data-icon="inline-start" />{/if}
        {attempt && submitError ? m.collect_workbench_retry_submit() : m.collect_workbench_submit({ count: selected.size })}
      </Button>
    </footer>
    {@render dialogs()}
  </Dialog.Content>
</Dialog.Root>

<style>
  .media-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 8rem), 1fr)); }
  @media (width < 48rem) {
    .source-panel { max-height: 39dvh; }
  }
</style>
