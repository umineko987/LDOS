<script lang="ts">
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import SearchIcon from "@lucide/svelte/icons/search";
  import Undo2Icon from "@lucide/svelte/icons/undo-2";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { tick, untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import { goto } from "$app/navigation";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import type { CaptionOpsRequest } from "#lib/api/queries/captions.ts";
  import {
    cacheGalleryCaptionEdit, dropGalleryCaption, editGalleryCaption, galleryCaptionBatchesQuery, galleryCaptionOps,
    galleryCaptionsQuery, galleryKeptQuery, galleryStudioDirectoryQuery, invalidateGalleryCaptions, saveGalleryKept,
  } from "#lib/api/queries/gallery-studio.ts";
  import {
    assetContentPath, assetThumbnailPath, invalidateLibrary, librarySourceQuery, trashItems, undoOperation,
  } from "#lib/api/queries/library.ts";
  import { useCaptionFeedback } from "#lib/components/captions/batch-feedback.svelte.ts";
  import { GridSelection, ThumbCell, VirtualGrid } from "#lib/components/grid/index.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { Progress } from "#lib/components/ui/progress/index.ts";
  import { Textarea } from "#lib/components/ui/textarea/index.ts";
  import { Viewer, type ViewerItem } from "#lib/components/viewer/index.ts";
  import { formatCaption, frequencyTable, normalizeTag, selectionSummary, type CaptionOp, type CaptionTarget } from "#lib/domain/captions.ts";
  import { libraryPath } from "#lib/domain/library.ts";
  import { EMPTY_DRAFT, expectedVersions, filterCaptions, indexCaptions, latestUndoable, toggleBlacklist, triageCursor, type OpDraft } from "#lib/domain/studio.ts";
  import { parseQuery, tokenizeQuery, toggleQueryTag, type QueryError } from "#lib/domain/tag-query.ts";
  import { useEvent } from "#lib/events/context.svelte.ts";
  import { useBindings, useEscape } from "#lib/keys/bindings.svelte.ts";
  import { isEditableTarget, type KeyboardEventLike } from "#lib/keys/keymap.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  import FrequencyPane from "./frequency-pane.svelte";
  import Inspector from "./inspector.svelte";
  import OpDialog from "./op-dialog.svelte";
  import PaneGutter from "./pane-gutter.svelte";
  import TriageView from "./triage-view.svelte";
  import {
    createGalleryReviewActions, galleryCategories, galleryStudioPath, matchesReviewFilter, readGalleryStudioPreferences,
    saveGalleryStudioPreferences, type GalleryStudioPreferences, type ReviewFilter,
  } from "./gallery-studio-state.ts";

  const props: { sourceId: string; directoryId: string | null } = $props();
  // This instance belongs to one route scope, even if an async write settles after navigation.
  const { sourceId, directoryId } = untrack(() => ({ sourceId: props.sourceId, directoryId: props.directoryId }));
  const api = useApi();
  const client = useQueryClient();
  const source = createQuery(() => librarySourceQuery(api, sourceId));
  const directory = createQuery(() => ({ ...galleryStudioDirectoryQuery(api, directoryId ?? ""), enabled: directoryId !== null }));
  const scopeName = $derived(directory.data?.source_id === sourceId ? directory.data.name : source.data?.display_name);
  const captions = createQuery(() => galleryCaptionsQuery(api, sourceId, directoryId));
  const batches = createQuery(() => galleryCaptionBatchesQuery(api, sourceId));
  const approvals = createQuery(() => galleryKeptQuery(api, sourceId));
  const back = $derived(libraryPath(sourceId, directoryId, source.data?.root_directory_id));

  const LEFT = { min: 220, max: 420 };
  const RIGHT = { min: 260, max: 480 };
  let leftWidth = $state(250);
  let rightWidth = $state(300);
  let search = $state("");
  let status = $state<ReviewFilter>("all");
  let searchInput = $state<HTMLInputElement | null>(null);
  let addInput = $state<HTMLInputElement | null>(null);
  let triageInput = $state<HTMLInputElement | null>(null);
  let triageHost = $state<HTMLDivElement | null>(null);
  let gridHost = $state<HTMLDivElement | null>(null);
  let focus = $state(-1);
  let triage = $state(false);
  let triageId = $state<string | null>(null);
  let triageHint = $state(0);
  let saving = $state(false);
  let canUndo = $state(false);
  const selection = new GridSelection();
  const actions = createGalleryReviewActions((busy) => (saving = busy), (available) => (canUndo = available));
  const refresh = () => invalidateGalleryCaptions(client, sourceId);
  const feedback = useCaptionFeedback(() => sourceId, { refresh: () => invalidateLibrary(client), runUndo: actions.run });
  useEvent("resync", () => void invalidateLibrary(client));

  let preferences = $state.raw(untrack(() => readGalleryStudioPreferences(sourceId)));
  let triggerDraft = $state(untrack(() => preferences.triggerWord));
  let categoryDraft = $state(untrack(() => preferences.categories));
  let settingsError = $state(false);
  let categoryError = $state(false);
  const triggerWord = $derived(preferences.triggerWord);
  const categories = $derived(galleryCategories(preferences.categories));
  const categoryOf = $derived(categories?.size ? (tag: string) => categories?.get(normalizeTag(tag)) : undefined);
  const items = $derived(captions.data?.items ?? []);
  const byId = $derived(new Map(items.map((item) => [item.asset_id, item])));
  const nameOf = (assetId: string) => byId.get(assetId)?.name ?? assetId;
  const indexed = $derived(indexCaptions(items));
  const approved = $derived(approvals.data ?? new Set<string>());
  const parsed = $derived(parseQuery(search));
  const categoryUnavailable = $derived(!categoryOf && parsed.terms.some((term) => term.kind === "category"));
  const results = $derived(filterCaptions(indexed, categoryUnavailable
    ? { ...parsed, terms: parsed.terms.filter((term) => term.kind !== "category") }
    : parsed, approved, { triggerWord, categoryOf }).filter((item) => matchesReviewFilter(approved, status, item.asset_id)));
  const order = $derived(results.map((item) => item.asset_id));
  const table = $derived(frequencyTable(results.map((item) => item.tags), { triggerWord, categoryOf }));
  const reviewed = $derived(items.reduce((count, item) => count + Number(approved.has(item.asset_id)), 0));
  const ready = $derived(captions.isSuccess && approvals.isSuccess);

  $effect(() => selection.retain(order));
  const selectedIds = $derived(order.filter((assetId) => selection.has(assetId)));
  const triageIndex = $derived(triageCursor(order, triageId, triageHint));
  const triageItem = $derived(results[triageIndex]);
  const scopeIds = $derived(!ready || categoryUnavailable ? [] : triage ? (triageItem ? [triageItem.asset_id] : []) : selectedIds.length ? selectedIds : order);
  const scopeItems = $derived(scopeIds.flatMap((assetId) => byId.get(assetId) ?? []));
  const summary = $derived(selectionSummary(scopeItems.map((item) => item.tags), triggerWord));
  const scopeApproved = $derived(scopeItems.filter((item) => approved.has(item.asset_id)).length);

  $effect(() => {
    if (!triage) return;
    const next = order[triageIndex + 1];
    if (!next) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = api.resourceUrl(assetContentPath(next));
  });

  function pointAt(assetId: string | null, index: number) {
    triageId = assetId;
    triageHint = index;
  }

  async function enterTriage(index = focus) {
    if (!ready || saving || !order.length) return;
    const start = index >= 0 ? index : Math.max(0, order.findIndex((assetId) => selection.has(assetId)));
    pointAt(order[start] ?? order[0]!, start);
    triage = true;
    await tick();
    triageHost?.focus();
  }

  function exitTriage() {
    if (saving) return;
    triage = false;
    focus = triageIndex;
  }

  function step(delta: number) {
    if (saving) return;
    const index = triageIndex + delta;
    const next = order[index];
    if (next) pointAt(next, index);
  }

  function advance(index: number, next: string | undefined, removed: boolean) {
    if (next) pointAt(next, index + (removed ? 0 : 1));
    else {
      if (removed) pointAt(null, index);
      toast(m.studio_triage_end());
    }
  }

  async function keepCurrent() {
    const item = triageItem;
    if (!item || !ready) return;
    const index = triageIndex;
    const next = order[index + 1];
    try {
      await actions.run(async () => {
        if (!approved.has(item.asset_id)) {
          await saveGalleryKept(api, client, sourceId, [item.asset_id], true);
          actions.remember({ kind: "keep", assetIds: [item.asset_id], kept: false, focusId: item.asset_id });
        }
        advance(index, next, order[index] !== item.asset_id);
      });
    } catch (error) {
      toast.error(m.studio_approve_failed({ reason: apiErrorMessage(error) }));
    }
  }

  async function trashCurrent() {
    const item = triageItem;
    if (!item || !ready) return;
    const index = triageIndex;
    const next = order[index + 1];
    try {
      await actions.run(async () => {
        const operation = await trashItems(api, { asset_ids: [item.asset_id] });
        await dropGalleryCaption(client, sourceId, item.asset_id);
        actions.remember({ kind: "trash", assetId: item.asset_id, operationId: operation.operation_id });
        advance(index, next, true);
        void invalidateLibrary(client);
        toast(m.studio_gallery_trashed({ name: item.name }));
      });
    } catch (error) {
      toast.error(m.studio_gallery_trash_failed({ reason: apiErrorMessage(error) }));
    }
  }

  async function editCurrent(tags: string[]): Promise<boolean> {
    const item = triageItem;
    if (!item || !ready) return false;
    try {
      return (await actions.run(async () => {
        const response = await editGalleryCaption(api, sourceId, item.asset_id, { text: formatCaption(tags), expected_version: item.version });
        await cacheGalleryCaptionEdit(client, sourceId, response);
        if (response.batch_id) actions.remember({ kind: "caption", assetId: item.asset_id, batchId: response.batch_id });
        return true;
      })) ?? false;
    } catch (error) {
      toast.error(m.studio_edit_failed({ reason: apiErrorMessage(error) }));
      void refresh();
      return false;
    }
  }

  async function decide(assetIds: readonly string[], kept: boolean) {
    const changed = assetIds.filter((assetId) => approved.has(assetId) !== kept);
    if (!ready || !changed.length) return;
    try {
      await actions.run(async () => {
        await saveGalleryKept(api, client, sourceId, changed, kept);
        actions.remember({ kind: "keep", assetIds: changed, kept: !kept });
      });
    } catch (error) {
      toast.error(m.studio_approve_failed({ reason: apiErrorMessage(error) }));
    }
  }

  function toggleApproval() {
    if (categoryUnavailable) return;
    const ids = selection.targets(order, focus);
    if (ids.length) void decide(ids, !ids.every((assetId) => approved.has(assetId)));
  }

  async function undoReview() {
    if (!canUndo) {
      toast(m.studio_undo_nothing());
      return;
    }
    try {
      await actions.undo(async (last) => {
        if (last.kind === "keep") {
          await saveGalleryKept(api, client, sourceId, last.assetIds, last.kept);
          if (last.focusId) pointAt(last.focusId, triageHint);
        } else if (last.kind === "trash") {
          await undoOperation(api, last.operationId);
          pointAt(last.assetId, triageHint);
          await invalidateLibrary(client);
        } else {
          if (batches.data?.some((batch) => batch.batch_id === last.batchId && batch.undone_at !== null)) return true;
          const complete = await feedback.undo(last.batchId, { lockHeld: true });
          if (complete && last.assetId) pointAt(last.assetId, triageHint);
          return complete;
        }
        toast(m.studio_gallery_undone());
      });
    } catch (error) {
      toast.error(m.studio_gallery_undo_failed({ reason: apiErrorMessage(error) }));
    }
  }

  let opOpen = $state(false);
  let opDraft = $state.raw<OpDraft>(EMPTY_DRAFT);
  let opIds = $state.raw<readonly string[]>([]);
  let opTargets = $state.raw<readonly CaptionTarget[]>([]);
  let opVersions = $state.raw<Record<string, string>>({});

  function openOp(partial: Partial<OpDraft>) {
    if (saving || !scopeIds.length) return;
    opIds = scopeIds;
    opTargets = scopeItems;
    opVersions = expectedVersions(scopeItems, scopeIds);
    opDraft = { ...EMPTY_DRAFT, ...partial };
    opOpen = true;
  }

  const opBody = (op: CaptionOp, dryRun: boolean): CaptionOpsRequest => ({
    asset_ids: [...opIds],
    ops: [op] as CaptionOpsRequest["ops"],
    expected_versions: opVersions,
    dry_run: dryRun,
    sample_limit: dryRun ? 6 : 0,
  });
  const previewOp = (op: CaptionOp) => galleryCaptionOps(api, sourceId, opBody(op, true));

  async function applyOp(op: CaptionOp) {
    // Use the same targets and versions as the dry run; concurrent edits are not overwritten.
    const applied = await actions.run(async () => {
      const result = await galleryCaptionOps(api, sourceId, opBody(op, false));
      if (result.batch_id && result.stats.written > 0) actions.remember({ kind: "caption", batchId: result.batch_id });
      await feedback.written(result, m.studio_op_done({ count: result.stats.written }));
      return true;
    });
    if (!applied) throw new Error(m.studio_gallery_busy());
  }

  async function undoLatest() {
    const latest = latestUndoable(batches.data);
    if (latest) await feedback.undo(latest.batch_id);
    else toast(m.studio_undo_nothing());
  }

  function persistPreferences(next: GalleryStudioPreferences) {
    try {
      saveGalleryStudioPreferences(sourceId, next);
      preferences = next;
      settingsError = false;
    } catch {
      settingsError = true;
    }
  }

  function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    categoryError = galleryCategories(categoryDraft) === null;
    if (!categoryError) persistPreferences({ ...preferences, triggerWord: triggerDraft.trim(), categories: categoryDraft });
  }

  function toggleBlacklisted(tag: string) {
    persistPreferences({ ...preferences, blacklist: toggleBlacklist(preferences.blacklist, tag) });
  }

  function toggleTag(tag: string, negate: boolean) {
    if (saving) return;
    search = toggleQueryTag(search, tag, negate);
    focus = -1;
  }

  function queryError(error: QueryError): string {
    return error.kind === "unknown_category"
      ? m.studio_query_unknown_category({ value: error.value })
      : m.studio_query_unknown_state({ value: error.value });
  }


  let viewerOpen = $state(false);
  let viewerIndex = $state(0);
  const thumb = (assetId: string) => api.resourceUrl(assetThumbnailPath(assetId));
  const viewerItems = $derived<ViewerItem[]>(
    results.map((item) => ({
      id: item.asset_id,
      name: item.name,
      src: api.resourceUrl(assetContentPath(item.asset_id)),
      thumb: thumb(item.asset_id),
      meta: item.text,
    })),
  );

  function originOf(_item: ViewerItem, index: number) {
    return gridHost?.querySelector<HTMLElement>(`[data-index="${index}"] img`) ?? null;
  }


  function toggleNoTags() {
    const tokens = tokenizeQuery(search);
    const existing = tokens.filter((token) => !token.quoted && token.text.toLowerCase() === "untagged");
    const next = tokens.filter((token) => !existing.includes(token)).map((token) => search.slice(token.start, token.end));
    if (!existing.some((token) => !token.negate)) next.push("untagged");
    search = next.join(" ");
    focus = -1;
  }

  function changeStatus(value: ReviewFilter) {
    status = value;
    focus = -1;
  }

  function focusAdd() {
    if (triage) return triageInput?.focus();
    if (!selection.size && order[focus]) selection.click(order, order[focus]!);
    requestAnimationFrame(() => addInput?.focus());
  }

  useEscape("selection", () => {
    if (isEditableTarget(document.activeElement)) return false;
    if (triage) {
      exitTriage();
      return true;
    }
    if (selection.size) return false;
    if (search) {
      search = "";
      return true;
    }
    return false;
  });
  useEscape("up", () => { void goto(`#${back}`); return true; });

  function keepShortcut(event?: KeyboardEventLike) {
    // A focused button or link still gets its native Enter action.
    if (event?.target instanceof Element && event.target.closest("button, a[href], summary")) return false;
    if (!(event instanceof KeyboardEvent && event.repeat)) void keepCurrent();
  }

  function trashShortcut(event?: KeyboardEventLike) {
    if (!(event instanceof KeyboardEvent && event.repeat)) void trashCurrent();
  }
  const group = m.keys_group_studio;
  const singleReady = () => triageItem !== undefined && ready && !saving;
  useBindings("page", () => [
    { id: "studio.search", keys: "/", label: m.studio_key_search, group, run: () => searchInput?.focus() },
    { id: "studio.add", keys: "t", label: m.studio_key_add, group, when: () => ready && !saving && order.length > 0, run: focusAdd },
    { id: "studio.approve", keys: "a", label: m.studio_key_approve, group, when: () => ready && !saving && !triage && (selection.size > 0 || focus >= 0), run: toggleApproval },
    { id: "studio.undo", keys: "z", label: m.studio_key_undo, group, when: () => !saving, run: () => void (triage || canUndo ? undoReview() : undoLatest()) },
    { id: "studio.triage", label: m.studio_key_triage, group, palette: true, when: () => ready && !saving && !triage && order.length > 0, run: () => void enterTriage() },
    ...(triage ? [
      { id: "studio.triage.keep", keys: "enter", label: m.studio_gallery_keep_next, group, when: singleReady, run: keepShortcut },
      { id: "studio.triage.trash", keys: "delete", label: m.studio_gallery_trash, group, when: singleReady, run: trashShortcut },
      { id: "studio.triage.prev", keys: ["arrowleft", "h"], label: m.studio_triage_prev, group, when: singleReady, run: () => step(-1) },
      { id: "studio.triage.next", keys: ["arrowright", "l"], label: m.studio_triage_next, group, when: singleReady, run: () => step(1) },
    ] : []),
  ]);

  const modes = $derived([
    { value: "grid" as const, label: m.studio_mode_grid() },
    { value: "triage" as const, label: m.studio_mode_triage() },
  ]);
  const statuses = $derived([
    { value: "all" as const, label: m.studio_gallery_status_all() },
    { value: "pending" as const, label: m.studio_gallery_status_pending() },
    { value: "reviewed" as const, label: m.studio_gallery_status_reviewed() },
  ]);
</script>

<PageHeader title={m.studio_gallery_review()}>
  {#snippet actions()}
    <Button variant="ghost" size="sm" href={`#${back}`} data-testid="studio-gallery-back">
      <ArrowLeftIcon data-icon="inline-start" />{m.studio_gallery_back()}
    </Button>
  {/snippet}
  <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg2" data-testid="studio-gallery-scope">
    <span class="font-medium text-fg">{scopeName ?? source.data?.display_name}</span>
    {#if directoryId}
      <span>{m.studio_gallery_subtree()}</span>
      <a class="underline underline-offset-2 hover:text-fg" href={`#${galleryStudioPath(sourceId)}`} data-testid="studio-gallery-source-scope">{m.studio_gallery_source_scope()}</a>
    {:else}
      <span>{m.studio_gallery_entire_source()}</span>
    {/if}
    <span>{m.studio_gallery_shared_txt()}</span>
  </div>
</PageHeader>

<div class="flex min-h-0 flex-1" data-testid="studio" data-source={sourceId} data-directory={directoryId}>
  <aside class="flex flex-none flex-col border-r border-line" style:width="min({leftWidth}px, 26vw)" aria-label={m.studio_frequency()}>
    <FrequencyPane {table} query={parsed} blacklist={preferences.blacklist} ontoggle={toggleTag} onblacklist={toggleBlacklisted} gallery>
      {#snippet settings()}
        <details class="max-h-[45%] flex-none overflow-y-auto border-t border-line px-4 py-2 text-xs" data-testid="studio-gallery-settings">
          <summary class="cursor-pointer font-medium">{m.studio_gallery_settings()}</summary>
          <p class="mt-2 text-2xs text-fg3">{m.studio_gallery_settings_hint()}</p>
          <form class="mt-2 flex flex-col gap-2" onsubmit={saveSettings}>
            <label class="flex flex-col gap-1">
              {m.studio_gallery_trigger()}
              <Input bind:value={triggerDraft} class="h-7 text-xs" />
            </label>
            <label class="flex flex-col gap-1">
              {m.studio_gallery_category()}
              <Textarea bind:value={categoryDraft} rows={2} placeholder="character: character_name" aria-invalid={categoryError} />
            </label>
            <p class="text-2xs text-fg3">{m.studio_gallery_category_help()}</p>
            {#if categoryError}<p class="text-2xs text-danger" role="alert">{m.studio_gallery_category_error()}</p>{/if}
            <Button type="submit" variant="outline" size="xs" class="self-start">{m.studio_gallery_save_settings()}</Button>
          </form>
        </details>
        {#if settingsError}<p class="px-4 pb-2 text-2xs text-danger" role="alert">{m.studio_gallery_settings_failed()}</p>{/if}
      {/snippet}
    </FrequencyPane>
  </aside>
  <PaneGutter bind:width={leftWidth} limits={LEFT} side="left" label={m.studio_resize_left()} />

  <section class="flex min-w-0 flex-1 flex-col" aria-label={m.studio_gallery_review()}>
    <fieldset disabled={saving} class="flex min-w-0 flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2" data-testid="studio-toolbar">
      <legend class="sr-only">{m.studio_gallery_view_controls()}</legend>
      <Segmented options={modes} value={triage ? "triage" : "grid"} onchange={(next) => next === "triage" ? enterTriage() : exitTriage()}
        label={m.studio_mode()} size="sm" data-testid="studio-mode" />
      <div class="relative min-w-32 flex-1">
        <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg3" />
        <Input bind:ref={searchInput} bind:value={search} type="search" class="h-7 pl-7 font-mono text-xs"
          placeholder={m.studio_gallery_query_placeholder()} aria-label={m.studio_query()} aria-invalid={parsed.errors.length > 0 || categoryUnavailable}
          data-testid="studio-query" oninput={() => (focus = -1)}
          onkeydown={(event) => {
            if (event.key === "Escape" && search) {
              event.stopPropagation();
              search = "";
            }
          }} />
      </div>
      <Button variant="outline" size="xs" aria-pressed={parsed.terms.some((term) => term.kind === "untagged" && !term.negate)}
        onclick={() => toggleNoTags()} data-testid="studio-gallery-no-tags">{m.studio_gallery_no_tags()}</Button>
    </fieldset>
    <div class="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5">
      <fieldset disabled={saving || !ready} class="min-w-0">
        <legend class="sr-only">{m.studio_gallery_status()}</legend>
        <Segmented options={statuses} value={status} onchange={changeStatus} label={m.studio_gallery_status()} data-testid="studio-gallery-status" />
      </fieldset>
      <span class="text-xs text-fg2 tabular-nums" data-testid="studio-count" data-count={results.length}>
        {m.studio_results({ count: results.length, total: items.length })}
      </span>
      <span class="flex items-center gap-1.5 text-2xs text-fg3" data-testid="studio-reviewed" data-count={reviewed}>
        <Progress value={reviewed} max={Math.max(1, items.length)} class="w-10" aria-label={m.studio_reviewed_label()} />
        {m.studio_reviewed({ count: reviewed, total: items.length })}
      </span>
      <Button variant="ghost" size="xs" class="ml-auto" disabled={!canUndo || saving} onclick={() => void undoReview()} data-testid="studio-gallery-undo">
        <Undo2Icon data-icon="inline-start" />{m.studio_gallery_undo()} <Kbd>Z</Kbd>
      </Button>
    </div>
    {#if parsed.errors.length || categoryUnavailable}
      <p class="flex-none border-b border-line px-4 py-1 text-2xs text-warn" role="status" data-testid="studio-query-errors">
        {[...parsed.errors.map(queryError), ...(categoryUnavailable ? [m.studio_gallery_category_unavailable()] : [])].join(" · ")}
      </p>
    {/if}
    {#if selectedIds.length > 0 && !triage}
      <div class="flex h-9 flex-none items-center gap-2 border-b border-line px-4 text-xs" data-testid="studio-selection">
        <span class="text-fg2">{m.studio_selected({ count: selectedIds.length })}</span>
        <Button variant="ghost" size="xs" onclick={() => selection.clear()}>{m.studio_clear_selection()} <Kbd>Esc</Kbd></Button>
      </div>
    {/if}
    {#if captions.isError || approvals.isError}
      <div class="flex items-center gap-3 px-4 py-4 text-sm text-danger" role="alert">
        {apiErrorMessage(captions.error ?? approvals.error)}
        <Button variant="outline" size="sm" onclick={() => { if (captions.isError) void captions.refetch(); if (approvals.isError) void approvals.refetch(); }}>
          {m.common_retry()}
        </Button>
      </div>
    {:else if !ready}
      <p class="px-4 py-6 text-sm text-fg3" role="status">{m.studio_loading()}</p>
    {:else if triage}
      {#if triageItem}
        <div bind:this={triageHost} role="region" aria-label={m.studio_mode_triage()} tabindex="-1" class="flex min-h-0 flex-1 flex-col outline-none">
          {#key triageItem.asset_id}
            <TriageView item={triageItem} position={triageIndex} total={order.length} approved={approved.has(triageItem.asset_id)}
              {triggerWord} {categoryOf} src={api.resourceUrl(assetContentPath(triageItem.asset_id))} {saving} bind:addInput={triageInput}
              onedit={editCurrent} onapprove={() => void keepCurrent()} ontrash={() => void trashCurrent()} onstep={step} />
          {/key}
        </div>
      {:else}
        <p class="px-4 py-6 text-sm text-fg3">{status === "all" ? m.studio_no_results() : m.studio_gallery_filter_empty()}</p>
      {/if}
    {:else}
      <div bind:this={gridHost} class="flex min-h-0 flex-1 flex-col">
        <VirtualGrid
          items={results}
          key={(item) => item.asset_id}
          label={m.studio_grid({ count: results.length })}
          itemLabel={(item) => (approved.has(item.asset_id) ? m.studio_item_approved({ name: item.name }) : item.name)}
          {selection}
          bind:focus
          thumbSize={152}
          aspect={1.35}
          onopen={(_item, index) => enterTriage(index)}
          onpreview={(_item, index) => {
            viewerIndex = index;
            viewerOpen = true;
          }}
        >
          {#snippet cell({ item })}
            <div class="flex size-full flex-col">
              <div class="min-h-0 flex-1">
                <ThumbCell src={thumb(item.asset_id)} alt={item.name}>
                  {#snippet topRight()}
                    {#if approved.has(item.asset_id)}
                      <CircleCheckIcon class="size-3.5 rounded-full bg-bg0/80 text-ok" aria-hidden="true" data-approved />
                    {/if}
                  {/snippet}
                </ThumbCell>
              </div>
              <p
                class={cn(
                  "line-clamp-2 h-8 flex-none px-1.5 pt-1 text-2xs leading-tight break-all",
                  item.tags.length ? "text-fg2" : "text-fg3 italic",
                )}
                data-caption
              >
                {item.tags.length ? item.text : m.studio_no_caption()}
              </p>
            </div>
          {/snippet}
          {#snippet empty()}
            {#if search}
              {m.studio_no_match({ query: search })}
            {:else if status !== "all"}
              {m.studio_gallery_filter_empty()}
            {:else}
              {m.studio_no_results()}
            {/if}
          {/snippet}
        </VirtualGrid>
      </div>
    {/if}
  </section>

  <PaneGutter bind:width={rightWidth} limits={RIGHT} side="right" label={m.studio_resize_right()} />
  <aside class="flex flex-none flex-col border-l border-line" style:width="min({rightWidth}px, 29vw)" aria-label={m.studio_inspector()}>
    {#if batches.isError}
      <p class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs text-danger" role="alert">
        {m.studio_gallery_history_failed({ reason: apiErrorMessage(batches.error) })}
        <Button variant="outline" size="xs" onclick={() => void batches.refetch()}>{m.common_retry()}</Button>
      </p>
    {/if}
    <Inspector {summary} scope={triage ? "current" : selectedIds.length > 0 ? "selection" : "results"} {categoryOf} approved={scopeApproved}
      batches={batches.data} historyLabel={m.studio_gallery_source_history()} locked={saving || !ready} quickAdd={!triage} bind:addInput onop={openOp}
      onapprove={(kept) => void decide(scopeIds, kept)} onundo={feedback.undo} />
  </aside>
</div>

<OpDialog
  bind:open={opOpen}
  initial={opDraft}
  targets={opTargets}
  triggerWord=""
  {nameOf}
  preview={previewOp}
  apply={applyOp}
/>

<Viewer
  items={viewerItems}
  bind:index={viewerIndex}
  bind:open={viewerOpen}
  origin={originOf}
  onclose={(index) => (focus = index)}
/>