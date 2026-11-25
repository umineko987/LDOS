<script lang="ts">
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
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
  import { resolveWorkbenchCreator, resolveWorkbenchSearch, type SearchResolution } from "./workbench-search.ts";
  import { emptyScope, isNewestFirst, isStablePrefix, parsePageRange, projectScope, selectLoadedScope, toggleScopeItem, type CollectionScope, type ScopeItem } from "./workbench-selection.ts";

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
  type BrowseSource = Exclude<WorkbenchAddress, { site: "danbooru" }> | { site: "danbooru"; kind: DanbooruKind; query: string; reference: string };
  type GalleryChoice = Extract<SearchResolution, { kind: "galleries" }>["choices"][number];
  type SearchRequest = { site: WorkbenchSource; input: string };
  type CreatorRequest = { site: "pixiv" | "twitter"; input: string };
  type CreatorOrigin = { request: CreatorRequest; source: BrowseSource; page: RemotePage; scrollTop: number };
  const uid = $props.id();
  const api = useApi();
  const client = useQueryClient();
  const resolvingSearch = createDanbooruRequestScope();
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
  let input = $state("");
  let searchInput = $state<HTMLInputElement | null>(null);
  let source = $state.raw<BrowseSource | null>(null);
  let resolving = $state(false);
  let searchError = $state<{ message: string; request: SearchRequest; retryable: boolean } | null>(null);
  let galleries = $state.raw<GalleryChoice[] | null>(null);
  let chosenGallery = $state.raw<GalleryChoice | null>(null);
  let backButton = $state<HTMLButtonElement | null>(null);
  let keywordSearch = $state.raw<CreatorRequest | null>(null);
  let creatorOrigin = $state.raw<CreatorOrigin | null>(null);
  let creatorButton = $state<HTMLButtonElement | null>(null);
  let optionsOpen = $state(false);
  let advancedKind = $state<DanbooruKind>("search");
  let advancedDraft = $state<DanbooruQueryDraft>(clearDanbooruQuery());
  let advancedReference = $state("");
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

  const kind = $derived(source?.site === "danbooru" ? source.kind : "search");
  const query = $derived(source?.site === "danbooru" ? source.query : "");
  const sourceKey = $derived(source && workbenchCheckpointSource(source.site, kind, query, source.site === "danbooru" ? source.reference : source.url));
  const searchPlaceholder = $derived({
    danbooru: m.collect_workbench_search_danbooru(),
    pixiv: m.collect_workbench_search_pixiv(),
    twitter: m.collect_workbench_search_x(),
    exhentai: m.collect_workbench_search_eh(),
  }[site]);
  const searchExample = $derived({ danbooru: "scenery rating:g", pixiv: "初音ミク", twitter: "watercolor", exhentai: "landscape" }[site]);
  const invalidInput = $derived(searchError?.retryable === false && searchError.request.input === input.trim());
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
    collectable: site === "exhentai" || item.media_count > 0,
    meta: item.page != null ? m.collect_workbench_page({ page: item.page }) : item.media_count > 0 ? m.collect_crawl_media({ count: item.media_count }) : "",
    status: site !== "exhentai" && item.media_count === 0 ? m.danbooru_unavailable() : "",
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
  const canSubmit = $derived(!saving && !resolving && !searching && !expired && !replacement && !rangeError && projection.ready && projection.ids.length > 0 && projection.ids.length <= maxSelection);
  const newestFirst = $derived(isNewestFirst(items, site, kind, query));
  const creatorLookup = $derived(!creatorOrigin && keywordSearch && source && remote && canEdit && !searching && !expired && !browseError && !selected.size && scope.kind === "manual"
    ? { request: keywordSearch, source, page: remote } : null);
  const creatorAction = $derived(site === "pixiv" ? m.collect_workbench_find_artist() : m.collect_workbench_find_account());

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

  function clearBrowse() {
    browsing.cancel();
    searching = false;
    browseError = "";
    retryBrowse = null;
    source = null;
    startPage = "1";
    endPage = "";
    clearSnapshot();
    if (gallery) gallery.scrollTop = 0;
  }

  function cancelResolution() {
    resolvingSearch.cancel();
    resolving = false;
    searchError = null;
  }

  function clearSearch() {
    cancelResolution();
    clearBrowse();
    galleries = null;
    chosenGallery = null;
    keywordSearch = null;
    creatorOrigin = null;
  }

  $effect.pre(() => {
    const next = address;
    const id = datasetId;
    if (open) untrack(() => {
      clearSearch();
      site = next?.site ?? "danbooru";
      input = next ? next.site === "danbooru" ? next.query : next.url : "";
      optionsOpen = false;
      advancedKind = "search";
      advancedDraft = clearDanbooruQuery();
      advancedReference = "";
      saving = false;
      if (next) browseAddress(next, id);
    });
    return () => { resolvingSearch.cancel(); browsing.cancel(); collecting.cancel(); };
  });

  function changeSite(next: WorkbenchSource) {
    if (!canEdit || site === next) return;
    clearSearch();
    site = next;
    optionsOpen = false;
  }

  function browseAddress(next: WorkbenchAddress, id = datasetId) {
    site = next.site;
    source = next.site === "danbooru" ? { ...next, kind: "search", reference: "" } : next;
    void browse(false, undefined, id);
  }

  function search(submitted: SearchRequest) {
    if (!canEdit || !submitted.input) return;
    clearSearch();
    optionsOpen = false;
    void resolveSearch(submitted);
  }

  async function resolveSearch(submitted: SearchRequest) {
    const creator = creatorOrigin?.request;
    cancelResolution();
    const request = resolvingSearch.begin();
    resolving = true;
    try {
      const result = creator
        ? await resolveWorkbenchCreator(api, creator.site, creator.input, request.signal)
        : await resolveWorkbenchSearch(api, submitted.site, submitted.input, request.signal);
      if (!request.isCurrent()) return;
      if (result.kind === "browse") {
        const { site, input } = submitted;
        // Search URLs can also be pasted. Offer name lookup only for typed keywords.
        if (!creator && (site === "pixiv" || site === "twitter") && result.address.site === site
          && !/^https?:\/\//i.test(input) && new URL(result.address.url).pathname === (site === "pixiv" ? "/search.php" : "/search")) {
          keywordSearch = { site, input };
        }
        browseAddress(result.address);
      } else if (result.kind === "galleries") {
        galleries = result.choices;
        if (result.choices.length === 1) {
          chosenGallery = result.choices[0];
          browseAddress(chosenGallery.address);
        }
      } else searchError = { message: m.collect_workbench_invalid_link(), request: submitted, retryable: false };
    } catch (error) {
      if (request.isCurrent() && !isAbortError(error)) searchError = { message: apiErrorMessage(error), request: submitted, retryable: true };
    } finally {
      if (request.isCurrent()) resolving = false;
    }
  }

  function useSearchExample() {
    input = searchExample;
    searchInput?.focus();
    search({ site, input });
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault();
    search({ site, input: input.trim() });
  }

  function submitAdvanced(event: SubmitEvent) {
    event.preventDefault();
    if (!canEdit) return;
    const query = advancedKind === "search" ? danbooruQueryText(advancedDraft) : "";
    const reference = advancedKind === "search" ? "" : advancedReference.trim();
    clearSearch();
    source = { site: "danbooru", kind: advancedKind, query, reference };
    input = query;
    optionsOpen = false;
    searchInput?.focus();
    void browse();
  }

  async function openGallery(choice: GalleryChoice) {
    if (!canEdit) return;
    chosenGallery = choice;
    if (gallery) gallery.scrollTop = 0;
    browseAddress(choice.address);
    await tick();
    if (chosenGallery === choice) backButton?.focus({ preventScroll: true });
  }

  async function backToGalleries() {
    if (!canEdit || !galleries || !chosenGallery) return;
    const index = galleries.indexOf(chosenGallery);
    cancelResolution();
    clearBrowse();
    chosenGallery = null;
    await tick();
    gallery?.querySelector<HTMLButtonElement>(`[data-gallery-index="${index}"]`)?.focus();
  }

  async function findCreator() {
    if (!creatorLookup) return;
    const origin = { ...creatorLookup, scrollTop: gallery?.scrollTop ?? 0 };
    creatorOrigin = origin;
    clearBrowse();
    optionsOpen = false;
    void resolveSearch(origin.request);
    await tick();
    if (creatorOrigin === origin) backButton?.focus({ preventScroll: true });
  }

  async function backToPictures() {
    if (!canEdit || !creatorOrigin) return;
    const origin = creatorOrigin;
    cancelResolution();
    clearBrowse();
    galleries = null;
    chosenGallery = null;
    creatorOrigin = null;
    source = origin.source;
    remote = origin.page;
    loaded = true;
    await tick();
    if (source === origin.source) {
      if (gallery) gallery.scrollTop = origin.scrollTop;
      creatorButton?.focus({ preventScroll: true });
    }
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
    const current = source;
    if (!current || !canEdit || searching || (more && !canLoadMore)) return;
    const request = browsing.begin();
    const key = sourceKey;
    searching = true;
    browseError = "";
    retryBrowse = { more, limit };
    try {
      if (current.site === "danbooru") {
        const page = await browseDanbooru(api, {
          dataset_id: id, kind: current.kind, query: current.query, reference: current.reference, cursor: more ? cursor : "", limit: WORKBENCH_PAGE_SIZE, count: !more,
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
        const response = await browseWorkbench(api, id, current.site, current.url, requested, request.signal);
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
    const trigger = gallery?.querySelector<HTMLButtonElement>(`[data-workbench-item="${CSS.escape(checkpoint)}"] [data-inspect]`);
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
    return "";
  }

  useOverlay(() => open, { id: "collect-workbench" });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="top-[2dvh] flex h-[96dvh] w-[97vw] flex-col gap-0 overflow-hidden p-0"
    showCloseButton={false} data-testid="collect-workbench" interactOutsideBehavior="ignore"
    onOpenAutoFocus={(event) => {
      event.preventDefault();
      searchInput?.focus();
    }}
    onEscapeKeydown={(event) => {
      if (focused || saving) event.preventDefault();
      if (focused) closeInspector();
    }}>
    <Dialog.Header class="relative flex-none gap-3 border-b border-line px-3 py-3 sm:px-5">
      <Dialog.Title class="pr-9 text-lg">{m.collect_workbench_title()}</Dialog.Title>
      <Dialog.Description class="sr-only">{m.collect_workbench_hint()}</Dialog.Description>
      <Dialog.Close>
        {#snippet child({ props })}
          <Button variant="ghost" size="icon-sm" class="absolute top-3 right-3" aria-label={m.common_close()} disabled={saving} {...props}><XIcon /></Button>
        {/snippet}
      </Dialog.Close>
      <form class="flex max-w-4xl flex-wrap items-center gap-2" onsubmit={submitSearch}>
        <fieldset disabled={!canEdit} class="min-w-0 max-w-full basis-full min-[44rem]:basis-auto">
          <legend class="sr-only">{m.collect_workbench_sources()}</legend>
          <Segmented options={sources} value={site} onchange={changeSite} label={m.collect_workbench_sources()} size="sm" class="h-control max-w-full" />
        </fieldset>
        <div class="flex min-w-0 flex-1 gap-2">
          <Input bind:ref={searchInput} bind:value={input} aria-label={searchPlaceholder} placeholder={searchPlaceholder}
            aria-invalid={invalidInput || undefined} aria-describedby={invalidInput ? uid + "-search-error" : undefined}
            autocomplete="off" spellcheck={false} enterkeyhint="search" class="flex-1" disabled={!canEdit} />
          <Button type="submit" variant="outline" disabled={!canEdit || !input.trim()}>
            <SearchIcon data-icon="inline-start" />{m.collect_crawl_search()}
          </Button>
        </div>
      </form>
    </Dialog.Header>

    <div class="flex min-h-0 flex-1 flex-col">
      <section class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg0" aria-label={m.collect_workbench_canvas()}>
        <div bind:this={gallery} class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-5" inert={!!focused}>
          {#if chosenGallery || creatorOrigin}
            <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              {#if chosenGallery && galleries && galleries.length > 1}
                <Button bind:ref={backButton} size="sm" variant="ghost" disabled={!canEdit} onclick={backToGalleries}>
                  <ArrowLeftIcon data-icon="inline-start" />{creatorOrigin ? m.collect_workbench_back_to_creators() : m.collect_workbench_back_to_galleries()}
                </Button>
              {:else if creatorOrigin}
                <Button bind:ref={backButton} size="sm" variant="ghost" disabled={!canEdit} onclick={backToPictures}>
                  <ArrowLeftIcon data-icon="inline-start" />{m.collect_workbench_back_to_pictures()}
                </Button>
              {/if}
              {#if chosenGallery}<h3 class="min-w-0 [overflow-wrap:anywhere] text-sm font-medium">{chosenGallery.label}</h3>{/if}
            </div>
          {/if}
          <details bind:open={optionsOpen} class="mb-3 text-sm">
            <summary class="w-fit cursor-pointer rounded-sm px-1 py-1 text-xs text-fg2 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring">{m.collect_workbench_options()}</summary>
            {#if optionsOpen}
              <div class="mt-2 flex max-w-3xl flex-col gap-3 rounded-md border border-line bg-bg1 p-3">
                {#if site === "danbooru"}
                  <form class="flex flex-col gap-2" onsubmit={submitAdvanced}>
                    <fieldset class="flex min-w-0 flex-col gap-2" disabled={!canEdit}>
                      <legend class="sr-only">{m.danbooru_source_type()}</legend>
                      <Segmented options={danbooruKinds} value={advancedKind} onchange={(next) => { advancedKind = next; advancedReference = ""; }} label={m.danbooru_source_type()} class="w-fit max-w-full flex-wrap" />
                      {#if advancedKind === "search"}
                        <DanbooruFilters draft={advancedDraft} onchange={(next) => (advancedDraft = next)} compact />
                      {:else}
                        <label class="flex flex-col gap-1 text-xs text-fg2" for="{uid}-address">
                          {advancedKind === "favorites" ? m.danbooru_favorites_reference() : m.danbooru_collection_reference()}
                          <Input id="{uid}-address" autocomplete="off" bind:value={advancedReference} />
                        </label>
                      {/if}
                    </fieldset>
                    <Button type="submit" size="sm" variant="outline" class="self-start"
                      disabled={!canEdit || (advancedKind !== "search" && advancedKind !== "favorites" && !advancedReference.trim())}>
                      {m.collect_workbench_apply_source()}
                    </Button>
                  </form>
                {/if}
                {#if site === "exhentai" && items.length}
                  <form class="flex max-w-sm flex-col gap-2" onsubmit={applyPages}>
                    <h3 class="text-sm font-medium">{m.collect_workbench_page_range()}</h3>
                    <div class="grid grid-cols-2 gap-2">
                      <label class="flex flex-col gap-1 text-xs text-fg2" for="{uid}-first">{m.collect_workbench_page_start()}
                        <Input id="{uid}-first" inputmode="numeric" bind:value={startPage} disabled={!canEdit || expired} />
                      </label>
                      <label class="flex flex-col gap-1 text-xs text-fg2" for="{uid}-last">{m.collect_workbench_page_end()}
                        <Input id="{uid}-last" inputmode="numeric" bind:value={endPage} disabled={!canEdit || expired} />
                      </label>
                    </div>
                    <Button type="submit" size="sm" variant="outline" class="self-start" disabled={!canEdit || searching || expired}>{m.collect_workbench_apply_pages()}</Button>
                  </form>
                {/if}
                <div class="flex flex-wrap gap-1.5">
                  {#if items.some((item) => item.collectable)}
                    <Button size="sm" variant="ghost" disabled={!canEdit || expired} onclick={() => setScope(selectLoadedScope(items))}>{m.collect_workbench_select_loaded()}</Button>
                  {/if}
                  {#if scope.kind !== "manual" && !selected.size}
                    <Button size="sm" variant="ghost" disabled={!canEdit} onclick={() => setScope(emptyScope())}>{m.collect_workbench_reset_range()}</Button>
                  {/if}
                  <Button size="sm" variant="ghost" disabled={!canEdit} onclick={ondiscovery}>{m.collect_workbench_find_sources()}</Button>
                  <Button size="sm" variant="ghost" disabled={!canEdit} onclick={onlegacy}>{m.collect_workbench_collect_by_link()}</Button>
                </div>
                {#if checkpoint}
                  <div class="flex flex-wrap items-center gap-2 border-t border-line pt-2 text-xs text-fg2">
                    <Badge variant="outline">{m.collect_workbench_last_submitted()}</Badge>
                    <span class="font-mono">#{checkpoint}</span>
                    {#if items.some(({ id }) => id === checkpoint)}
                      <Button variant="ghost" size="sm" onclick={showCheckpoint}>{m.collect_workbench_find_checkpoint()}</Button>
                    {:else}<span>{m.collect_workbench_checkpoint_missing()}</span>{/if}
                  </div>
                {/if}
              </div>
            {/if}
          </details>

          {#if searchError}
            {@const failure = searchError}
            <div id="{uid}-search-error" class="flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg1 p-3 text-sm text-danger" role="alert">
              <span>{failure.message}</span>
              {#if failure.retryable}
                <Button size="sm" variant="outline" disabled={!canEdit} onclick={() => creatorOrigin ? void resolveSearch(failure.request) : search(failure.request)}>{m.common_retry()}</Button>
              {/if}
            </div>
          {/if}
          {#if browseError}
            <div class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg1 p-3 text-xs text-danger" role="alert">
              <span>{loaded && !expired ? m.collect_workbench_browse_failed({ error: browseError }) : browseError}</span>
              {#if retryBrowse && !expired}
                {@const retry = retryBrowse}
                <Button size="sm" variant="outline" disabled={searching || !canEdit} onclick={() => void browse(retry.more, retry.limit)}>{m.common_retry()}</Button>
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
          {#if galleries && !chosenGallery && galleries.length}
            <h3 class="mb-2 text-sm font-medium" role="status">
              {creatorOrigin ? site === "pixiv" ? m.collect_workbench_choose_artist() : m.collect_workbench_choose_account() : m.collect_workbench_choose_gallery()}
            </h3>
            <ul class="grid max-w-3xl gap-2">
              {#each galleries as choice, index (choice.address)}
                <li>
                  <Button variant="outline" class="h-auto w-full justify-between py-2 text-left whitespace-normal" data-gallery-index={index}
                    disabled={!canEdit} onclick={() => void openGallery(choice)}>
                    <span class="min-w-0 [overflow-wrap:anywhere]">{choice.label}</span><ChevronRightIcon data-icon="inline-end" />
                  </Button>
                </li>
              {/each}
            </ul>
          {:else if items.length}
            <div class="mb-2 flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p class="text-xs text-fg2 tabular-nums" role="status">
                {m.danbooru_loaded({ count: items.length })}{#if total != null} · {m.collect_workbench_total({ count: total })}{/if}
              </p>
              {#if creatorLookup}
                <Button bind:ref={creatorButton} variant="link" size="sm" onclick={findCreator}>{creatorAction}</Button>
              {/if}
            </div>
            <div class="media-grid grid gap-2.5">
              {#each items as item (item.id)}
                <WorkbenchCard id={item.id} title={item.title} preview={item.preview} meta={item.meta} status={item.status}
                  selected={selected.has(item.id)} disabled={!canToggle(item)} focused={focusedId === item.id} checkpoint={optionsOpen && checkpoint === item.id}
                  onfocusitem={(trigger) => void showInspector(item, trigger)} ontoggle={() => toggle(item)} />
              {/each}
            </div>
          {:else if !searchError && !browseError}
            <div class="flex flex-col items-center gap-2 px-3 py-14 text-center sm:py-20">
              {#if resolving || searching}
                <LoaderCircleIcon class="size-5 motion-safe:animate-spin text-fg2" aria-hidden="true" />
                <p role="status" class="text-sm text-fg2">{resolving ? m.collect_workbench_searching() : m.collect_workbench_loading_pictures()}</p>
              {:else}
                <ImagesIcon class="size-6 text-fg2" aria-hidden="true" />
                <p role="status" class="text-sm font-medium">
                  {loaded ? m.collect_workbench_empty() : galleries ? creatorOrigin ? site === "pixiv" ? m.collect_workbench_no_artists() : m.collect_workbench_no_accounts() : m.collect_workbench_no_galleries() : m.collect_workbench_idle()}
                </p>
                {#if creatorLookup}
                  <Button bind:ref={creatorButton} variant="outline" onclick={findCreator}>{creatorAction}</Button>
                {:else if !loaded && !galleries}
                  <Button variant="link" onclick={useSearchExample}>{m.collect_workbench_example({ example: searchExample })}</Button>
                {/if}
              {/if}
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
            <p class="break-words text-xs text-fg2">{[focused.meta, focused.author, focused.status].filter(Boolean).join(" · ")}</p>
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
        {#if selected.size}
          <div class="flex flex-wrap items-center gap-x-2">
            <p class="font-medium tabular-nums">{m.collect_workbench_selected({ count: selected.size })}</p>
            <Button size="sm" variant="ghost" disabled={!canEdit} onclick={() => setScope(emptyScope())}>{m.collect_clear_selection()}</Button>
          </div>
        {/if}
        {#if scope.kind !== "manual"}
          <p class="break-words text-xs text-fg2">
            {scopeLabel()}{#if scope.excluded.size} · {m.collect_workbench_excluded({ count: scope.excluded.size })}{/if}
          </p>
        {/if}
        {#if rangeError}<p class="text-xs text-danger" role="alert">{rangeError}</p>
        {:else if scope.kind === "pages" && !projection.ready}<p class="text-xs text-warn">{m.collect_workbench_pages_missing()}</p>{/if}
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
      <Button variant="primary" disabled={!canSubmit} onclick={() => void submit()} data-testid="collect-workbench-submit">
        {#if saving}<LoaderCircleIcon class="animate-spin" data-icon="inline-start" />{/if}
        {attempt && submitError ? m.collect_workbench_retry_submit() : selected.size ? m.collect_workbench_submit({ count: selected.size }) : m.collect_workbench_start()}
      </Button>
    </footer>
    {@render dialogs()}
  </Dialog.Content>
</Dialog.Root>

<style>
  .media-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 8rem), 1fr)); }
</style>
