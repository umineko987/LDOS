<script lang="ts">
  import BookmarkPlusIcon from "@lucide/svelte/icons/bookmark-plus";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import SearchIcon from "@lucide/svelte/icons/search";
  import TrashIcon from "@lucide/svelte/icons/trash-2";
  import XIcon from "@lucide/svelte/icons/x";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { tick, untrack } from "svelte";
  import { toast } from "svelte-sonner";

  import { goto } from "$app/navigation";
  import { useApi } from "#lib/api/context.ts";
  import { isAbortError } from "#lib/api/errors.ts";
  import { createIdempotencyKey } from "#lib/api/ids.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    browseDanbooru,
    canCollectDanbooruPost,
    clearDanbooruQuery,
    collectDanbooru,
    createDanbooruRequestScope,
    DANBOORU_COLLECT_LIMIT,
    danbooruCollectAttempt,
    danbooruMediaUrl,
    danbooruQueryText,
    deleteDanbooruRecipe,
    isDanbooruKind,
    isDanbooruExpired,
    mergeDanbooruPosts,
    readDanbooruRecipes,
    saveDanbooruRecipe,
    selectedDanbooruTokens,
    selectLoadedDanbooruPosts,
    type DanbooruCollectAttempt,
    type DanbooruBrowseResponse,
    type DanbooruKind,
    type DanbooruPost,
    type DanbooruQueryDraft,
    type DanbooruRecipe,
  } from "#lib/api/queries/danbooru.ts";
  import { invalidateForDatasetEvent } from "#lib/api/queries/datasets.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import * as Tabs from "#lib/components/ui/tabs/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  import DanbooruFilters from "./danbooru-filters.svelte";
  import DanbooruPostCard from "./danbooru-post-card.svelte";

  let { open = $bindable(false), datasetId }: { open?: boolean; datasetId: string } = $props();
  const api = useApi();
  const client = useQueryClient();
  const uid = $props.id();
  const browsing = createDanbooruRequestScope();
  const collecting = createDanbooruRequestScope();

  let kind = $state<DanbooruKind>("search");
  let draft = $state.raw<DanbooruQueryDraft>(clearDanbooruQuery());
  let reference = $state("");
  let posts = $state.raw<DanbooruPost[]>([]);
  let selected = $state.raw<ReadonlySet<string>>(new Set());
  let source = $state.raw<DanbooruBrowseResponse["source"] | null>(null);
  let total = $state<number | null>(null);
  let nextCursor = $state("");
  let warnings = $state.raw<string[]>([]);
  let hasPage = $state(false);
  let searching = $state(false);
  let submitting = $state(false);
  let browseError = $state<string | null>(null);
  let retryAppend = $state(false);
  let submitError = $state<string | null>(null);
  let submitExpired = $state(false);
  let recipes = $state.raw<DanbooruRecipe[]>([]);
  let recipeName = $state("");
  let recipeError = $state<string | null>(null);
  let details = $state.raw<DanbooruPost | null>(null);
  let detailFailed = $state(false);
  let detailHost = $state<HTMLElement | null>(null);
  let detailTrigger: HTMLButtonElement | null = null;
  let submission: DanbooruCollectAttempt | undefined;

  const tokens = $derived(selectedDanbooruTokens(posts, selected));
  const query = $derived(kind === "search" ? danbooruQueryText(draft) : "");
  const canBrowse = $derived(!submitting && (kind === "search" || kind === "favorites" || reference.trim().length > 0));
  const detailImage = $derived(details ? danbooruMediaUrl(api, details.sample_url) || danbooruMediaUrl(api, details.preview_url) : "");
  const modes = $derived([
    { value: "search" as const, label: m.danbooru_mode_search() },
    { value: "favorites" as const, label: m.danbooru_mode_favorites() },
    { value: "favorite_group" as const, label: m.danbooru_mode_group() },
    { value: "pool" as const, label: m.danbooru_mode_pool() },
  ]);
  const categories = $derived([
    { key: "general", label: m.danbooru_tags_general() },
    { key: "character", label: m.danbooru_tags_character() },
    { key: "artist", label: m.danbooru_tags_artist() },
    { key: "copyright", label: m.danbooru_tags_copyright() },
    { key: "meta", label: m.danbooru_tags_meta() },
  ]);

  function cancelRequests() {
    browsing.cancel();
    collecting.cancel();
    searching = false;
    submitting = false;
  }

  function clearResults() {
    browsing.cancel();
    searching = false;
    posts = [];
    selected = new Set();
    source = null;
    total = null;
    nextCursor = "";
    hasPage = false;
    warnings = [];
    browseError = null;
    submitError = null;
    submitExpired = false;
    details = null;
    detailTrigger = null;
    submission = undefined;
  }

  function reset(id: string) {
    cancelRequests();
    clearResults();
    kind = "search";
    draft = clearDanbooruQuery();
    reference = "";
    recipeName = "";
    recipeError = null;
    recipes = [];
    try {
      recipes = readDanbooruRecipes(localStorage, id);
    } catch {
      recipeError = m.danbooru_storage_failed();
    }
  }

  // Parent-controlled opening and dataset changes are external lifecycle boundaries.
  $effect.pre(() => {
    const id = datasetId;
    if (open) untrack(() => reset(id));
    else untrack(cancelRequests);
    return () => untrack(cancelRequests);
  });

  function changeDraft(next: DanbooruQueryDraft) {
    const previous = danbooruQueryText(draft);
    draft = next;
    if (previous !== danbooruQueryText(next)) clearResults();
  }

  function changeMode(value: string) {
    if (!isDanbooruKind(value) || kind === value) return;
    clearResults();
    kind = value;
    reference = "";
  }

  function changeReference(value: string) {
    reference = value;
    clearResults();
  }

  async function browse(append = false) {
    if (!canBrowse || searching || (append && !nextCursor)) return;
    const request = browsing.begin();
    searching = true;
    browseError = null;
    retryAppend = append;
    submitError = null;
    try {
      const page = await browseDanbooru(api, {
        dataset_id: datasetId, kind, query, reference: kind === "search" ? "" : reference.trim(),
        cursor: append ? nextCursor : "", limit: 48, count: !append,
      }, request.signal);
      if (!request.isCurrent()) return;
      posts = mergeDanbooruPosts(append ? posts : [], page.items);
      if (!append) {
        selected = new Set();
        submitExpired = false;
        details = null;
        detailTrigger = null;
      }
      source = page.source;
      if (!append || page.total !== null) total = page.total;
      nextCursor = page.next_cursor;
      warnings = [...new Set([...(append ? warnings : []), ...page.warnings])];
      hasPage = true;
    } catch (error) {
      if (request.isCurrent() && !isAbortError(error)) {
        if (isDanbooruExpired(error)) {
          submitExpired = true;
          retryAppend = false;
          browseError = m.danbooru_expired();
        } else browseError = apiErrorMessage(error);
      }
    } finally {
      if (request.isCurrent()) searching = false;
    }
  }

  function stopBrowsing() {
    browsing.cancel();
    searching = false;
  }

  function toggle(post: DanbooruPost) {
    if (submitting || !canCollectDanbooruPost(post)) return;
    if (!selected.has(post.id) && tokens.length >= DANBOORU_COLLECT_LIMIT) return;
    selected = selected.has(post.id) ? new Set([...selected].filter((id) => id !== post.id)) : new Set([...selected, post.id]);
    submitError = null;
  }

  async function showDetails(post: DanbooruPost, trigger: HTMLButtonElement) {
    details = post;
    detailFailed = false;
    detailTrigger = trigger;
    await tick();
    if (open && details?.id === post.id) detailHost?.focus({ preventScroll: true });
  }

  function closeDetails() {
    details = null;
    detailTrigger?.focus({ preventScroll: true });
    detailTrigger = null;
  }

  function saveRecipe(event: SubmitEvent) {
    event.preventDefault();
    if (!recipeName.trim() || !canBrowse) return;
    try {
      recipes = saveDanbooruRecipe(localStorage, datasetId, {
        id: createIdempotencyKey("danbooru-source"), name: recipeName.trim(), kind, query,
        reference: kind === "search" ? "" : reference.trim(),
      });
      recipeName = "";
      recipeError = null;
      toast.success(m.danbooru_recipe_saved());
    } catch {
      recipeError = m.danbooru_storage_failed();
    }
  }

  function restoreRecipe(recipe: DanbooruRecipe) {
    clearResults();
    kind = recipe.kind;
    // Recipes restore into raw mode so advanced text can never be rewritten by controls.
    draft = { mode: "raw", text: recipe.query };
    reference = recipe.reference;
    recipeName = recipe.name;
  }

  function deleteRecipe(id: string) {
    try {
      recipes = deleteDanbooruRecipe(localStorage, datasetId, id);
      recipeError = null;
    } catch {
      recipeError = m.danbooru_storage_failed();
    }
  }

  async function submit() {
    const ordered = selectedDanbooruTokens(posts, selected);
    if (!ordered.length || ordered.length > DANBOORU_COLLECT_LIMIT || submitting || submitExpired) return;
    stopBrowsing();
    const id = datasetId;
    submission = danbooruCollectAttempt(submission, ordered);
    const request = collecting.begin();
    submitting = true;
    submitError = null;
    try {
      const result = await collectDanbooru(api, id, ordered, submission.key, request.signal);
      // A completed write still invalidates its original dataset if the dialog was closed.
      invalidateForDatasetEvent(client, "dataset.updated", { dataset_id: id, reason: "roots" });
      if (!request.isCurrent()) return;
      const message = m.danbooru_collect_result({ queued: result.queued_count, reused: result.reused_count, skipped: result.skipped_count });
      const batchId = result.batch_id;
      const options = batchId ? {
        action: { label: m.collect_crawl_view(), onClick: () => void goto(`#/jobs/crawls/${encodeURIComponent(batchId)}`) },
      } : undefined;
      if (result.queued_count + result.reused_count > 0) toast.success(message, options);
      else toast.info(message, options);
      open = false;
    } catch (error) {
      if (request.isCurrent() && !isAbortError(error)) {
        if (isDanbooruExpired(error)) submitExpired = true;
        else submitError = apiErrorMessage(error);
      }
    } finally {
      if (request.isCurrent()) submitting = false;
    }
  }

  useOverlay(() => open, { id: "collect-danbooru" });
</script>

<Dialog.Root bind:open onOpenChange={(next) => { if (!next) cancelRequests(); }}>
  <Dialog.Content class="top-[4vh] flex h-[92dvh] w-[min(1240px,96vw)] flex-col gap-0 overflow-hidden p-0" showCloseButton={false}
    data-testid="collect-danbooru-dialog" onEscapeKeydown={(event) => { if (details) { event.preventDefault(); closeDetails(); } }}>
    <Dialog.Header class="flex-none border-b border-line px-5 py-4 pr-14">
      <Dialog.Title>{m.danbooru_title()}</Dialog.Title>
      <Dialog.Description>{m.danbooru_hint()}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Close>
      {#snippet child({ props })}
        <Button variant="ghost" size="icon-sm" class="absolute top-3 right-3" aria-label={m.common_close()} {...props}><XIcon /></Button>
      {/snippet}
    </Dialog.Close>

    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div class="border-b border-line px-5 py-3">
        <Tabs.Root value={kind} onValueChange={changeMode}>
          <Tabs.List class="max-w-full flex-wrap group-data-horizontal/tabs:h-auto" aria-label={m.danbooru_source_type()}>
            {#each modes as mode (mode.value)}<Tabs.Trigger value={mode.value} disabled={submitting}>{mode.label}</Tabs.Trigger>{/each}
          </Tabs.List>
          <Tabs.Content value={kind}>
            <form class="flex flex-col gap-3" onsubmit={(event) => { event.preventDefault(); void browse(); }}>
              <fieldset class="flex min-w-0 flex-col gap-3" disabled={submitting}>
                <legend class="sr-only">{m.danbooru_source_type()}</legend>
                {#if open && kind === "search"}
                  <DanbooruFilters {draft} onchange={changeDraft} />
                {:else if kind !== "search"}
                  <label for="{uid}-reference" class="flex flex-col gap-1 text-xs text-fg2">
                    {kind === "favorites" ? m.danbooru_favorites_reference() : m.danbooru_collection_reference()}
                    <Input id="{uid}-reference" value={reference} autocomplete="off" oninput={(event) => changeReference(event.currentTarget.value)}
                      placeholder={kind === "favorites" ? m.danbooru_favorites_placeholder() : m.danbooru_collection_placeholder()} />
                  </label>
                  <p class="text-2xs text-fg3">{kind === "favorites" ? m.danbooru_favorites_hint() : m.danbooru_collection_hint()}</p>
                {/if}
              </fieldset>
              <div class="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" disabled={!canBrowse || searching}>
                  {#if searching}<LoaderCircleIcon class="animate-spin" data-icon="inline-start" />{:else}<SearchIcon data-icon="inline-start" />{/if}
                  {kind === "search" ? m.danbooru_search() : m.danbooru_load_collection()}
                </Button>
                {#if searching}<Button type="button" size="sm" variant="ghost" onclick={stopBrowsing}>{m.danbooru_stop_loading()}</Button>{/if}
                <span class="text-2xs text-fg3">{m.danbooru_snapshot_note()}</span>
              </div>
            </form>
          </Tabs.Content>
        </Tabs.Root>

        <details class="mt-3 text-xs text-fg2">
          <summary class="w-fit cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">{m.danbooru_saved_sources({ count: recipes.length })}</summary>
          <div class="mt-3 flex flex-col gap-2">
            <p class="text-2xs text-fg3">{m.danbooru_local_note()}</p>
            <form class="flex gap-2" onsubmit={saveRecipe}>
              <label for="{uid}-recipe" class="sr-only">{m.danbooru_recipe_name()}</label>
              <Input id="{uid}-recipe" bind:value={recipeName} maxlength={120} placeholder={m.danbooru_recipe_name()} disabled={submitting} />
              <Button type="submit" size="sm" variant="outline" disabled={!recipeName.trim() || !canBrowse}>
                <BookmarkPlusIcon data-icon="inline-start" />{m.danbooru_save_source()}
              </Button>
            </form>
            {#each recipes as recipe (recipe.id)}
              <div class="flex min-w-0 items-center gap-2">
                <Button size="sm" variant="ghost" class="min-w-0 flex-1 justify-start" disabled={submitting} onclick={() => restoreRecipe(recipe)}>
                  <span class="truncate">{recipe.name}</span>
                  <span class="ml-auto text-2xs text-fg3">{modes.find((mode) => mode.value === recipe.kind)?.label}</span>
                </Button>
                <Button size="icon-sm" variant="ghost" disabled={submitting} aria-label={m.danbooru_delete_recipe({ name: recipe.name })} onclick={() => deleteRecipe(recipe.id)}><TrashIcon /></Button>
              </div>
            {/each}
          </div>
        </details>
        {#if recipeError}<p class="mt-2 text-xs text-danger" role="alert">{recipeError}</p>{/if}
      </div>

      <div class="flex flex-col gap-3 px-5 py-3">
        {#if source}
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h3 class="min-w-0 break-words text-sm font-medium">{source.name || modes.find((mode) => mode.value === kind)?.label}</h3>
            <p class="text-xs text-fg3 tabular-nums">{total === null ? m.danbooru_count_unknown() : m.danbooru_count_reference({ count: total })} · {m.danbooru_loaded({ count: posts.length })}</p>
          </div>
          {#if source.url}<p class="break-all text-2xs text-fg3">{source.url}</p>{/if}
          <p class="text-2xs text-fg3">{m.danbooru_local_status_note()}</p>
        {/if}
        {#if warnings.length}
          <ul class="flex flex-col gap-1 text-xs text-warn" aria-label={m.danbooru_warnings()}>{#each warnings as warning (warning)}<li>{warning}</li>{/each}</ul>
        {/if}
        {#if browseError}
          <div class="flex flex-wrap items-center gap-2 text-xs text-danger" role="alert">
            <span>{posts.length ? m.danbooru_partial_error({ error: browseError }) : browseError}</span>
            <Button size="sm" variant="outline" disabled={searching || !canBrowse} onclick={() => void browse(retryAppend)}>{m.common_retry()}</Button>
          </div>
        {/if}
        {#if posts.length}
          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" disabled={submitting} onclick={() => (selected = selectLoadedDanbooruPosts(posts))}>{m.danbooru_select_loaded({ max: DANBOORU_COLLECT_LIMIT })}</Button>
            <Button size="sm" variant="ghost" disabled={submitting || selected.size === 0} onclick={() => (selected = new Set())}>{m.collect_clear_selection()}</Button>
          </div>
        {/if}
        <div class={cn("grid items-start gap-4", details && "md:grid-cols-[minmax(0,1fr)_280px]")} aria-busy={searching || undefined}>
          <div class="min-w-0">
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {#each posts as post (post.id)}
                <DanbooruPostCard {post} selected={selected.has(post.id)} disabled={submitting || (tokens.length >= DANBOORU_COLLECT_LIMIT && !selected.has(post.id))} active={details?.id === post.id} ontoggle={toggle} ondetails={showDetails} />
              {/each}
            </div>
            {#if !posts.length}
              <div class="flex min-h-48 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-fg3" role="status">
                {#if searching}<LoaderCircleIcon class="size-5 animate-spin" aria-hidden="true" />{m.danbooru_loading()}
                {:else if hasPage}{m.danbooru_empty()}
                {:else if !browseError}{m.danbooru_idle()}{/if}
              </div>
            {/if}
            {#if nextCursor}
              <div class="flex justify-center py-4"><Button variant="outline" size="sm" disabled={searching || submitting} onclick={() => void browse(true)}>
                {#if searching}<LoaderCircleIcon class="animate-spin" data-icon="inline-start" />{/if}{m.danbooru_load_more()}
              </Button></div>
            {:else if hasPage && posts.length}<p class="py-4 text-center text-2xs text-fg3">{m.danbooru_end()}</p>{/if}
          </div>
          {#if details}
            <aside bind:this={detailHost} tabindex="-1" aria-label={m.danbooru_details()} class="order-first flex min-w-0 flex-col gap-3 rounded-md border border-line bg-bg1 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring md:sticky md:top-3 md:order-last md:max-h-[70dvh] md:overflow-y-auto">
              <div class="flex items-start gap-2">
                <h3 class="min-w-0 flex-1 break-words text-sm font-medium">{details.title || m.danbooru_post({ id: details.id })}</h3>
                <Button size="icon-sm" variant="ghost" aria-label={m.danbooru_close_details()} onclick={closeDetails}><XIcon /></Button>
              </div>
              {#if detailImage && !detailFailed}
                <img src={detailImage} alt={details.title || m.danbooru_post({ id: details.id })} crossorigin="anonymous" loading="lazy" class="max-h-72 w-full object-contain" onerror={() => (detailFailed = true)} />
              {:else}<p class="py-4 text-center text-xs text-fg3">{detailFailed ? m.danbooru_preview_failed() : m.danbooru_no_preview()}</p>{/if}
              <p class="text-xs text-fg2 tabular-nums">{details.width}×{details.height} · {details.file_ext.toUpperCase()} · {m.danbooru_file_bytes({ count: details.file_size })}</p>
              <p class="text-xs text-fg2">{m.danbooru_post_meta({ rating: details.rating.toUpperCase(), score: details.score })}</p>
              <p class="text-xs text-fg2">{details.in_dataset ? m.danbooru_in_dataset() : details.local_asset_id ? m.danbooru_in_library() : canCollectDanbooruPost(details) ? m.danbooru_can_download() : details.unavailable_reason || m.danbooru_not_collectable()}</p>
              <dl class="flex flex-col gap-1 text-2xs">
                <dt class="font-medium text-fg2">{m.danbooru_post_link()}</dt><dd class="break-all text-fg3">{details.url || "—"}</dd>
                <dt class="mt-2 font-medium text-fg2">{m.danbooru_original_source()}</dt><dd class="break-all text-fg3">{details.source_url || "—"}</dd>
              </dl>
              {#each categories as category (category.key)}
                <div class="flex flex-col gap-1">
                  <h4 class="text-2xs font-medium text-fg2">{category.label}</h4>
                  <p class="break-words text-2xs text-fg3">{(details.tags[category.key] ?? []).join(" · ") || "—"}</p>
                </div>
              {/each}
            </aside>
          {/if}
        </div>
      </div>
    </div>

    <Dialog.Footer class="mx-0 mb-0 flex-none flex-wrap items-center gap-2 border-t border-line bg-popover px-5 py-3">
      <div class="mr-auto flex min-w-0 flex-col gap-1" aria-live="polite">
        <span class="text-sm font-medium tabular-nums">{m.danbooru_selected({ count: tokens.length })}</span>
        <span class="text-2xs text-fg3">{m.danbooru_recheck_note()}</span>
        <span class="text-2xs text-fg3">{m.danbooru_limit_note({ max: DANBOORU_COLLECT_LIMIT })}</span>
        {#if submitExpired}<span class="text-xs text-danger" role="alert">{m.danbooru_expired()}</span>{/if}
        {#if submitError}<span class="text-xs text-danger" role="alert">{submitError}</span>{/if}
      </div>
      {#if submitExpired}<Button variant="outline" disabled={searching || submitting} onclick={() => void browse()}>{m.danbooru_reload()}</Button>{/if}
      <Dialog.Close>{#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}</Dialog.Close>
      <Button variant="primary" disabled={!tokens.length || tokens.length > DANBOORU_COLLECT_LIMIT || submitting || submitExpired} onclick={submit} data-testid="danbooru-collect-submit">
        {#if submitting}<LoaderCircleIcon class="animate-spin" data-icon="inline-start" />{/if}{m.danbooru_collect({ count: tokens.length })}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
