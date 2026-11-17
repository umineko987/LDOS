<script lang="ts">
  import { onDestroy } from "svelte";

  import { useApi } from "#lib/api/context.ts";
  import { isAbortError } from "#lib/api/errors.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    autocompleteDanbooru,
    clearDanbooruQuery,
    createDanbooruRequestScope,
    danbooruQueryText,
    rawDanbooruQuery,
    replaceLastDanbooruTag,
    type DanbooruFilters,
    type DanbooruQueryDraft,
    type DanbooruTagSuggestion,
  } from "#lib/api/queries/danbooru.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Textarea } from "#lib/components/ui/textarea/index.ts";
  import { m } from "#lib/paraglide/messages.js";

  let { draft, onchange }: { draft: DanbooruQueryDraft; onchange: (next: DanbooruQueryDraft) => void } = $props();
  const uid = $props.id();
  const api = useApi();
  const requests = createDanbooruRequestScope();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suggestions = $state.raw<DanbooruTagSuggestion[]>([]);
  let tagField = $state<"include" | "exclude">("include");
  let completionError = $state<string | null>(null);
  let completing = $state(false);
  const tagText = $derived(draft.mode === "simple" ? draft.filters[tagField] : "");

  function stopCompletion() {
    clearTimeout(timer);
    requests.cancel();
    suggestions = [];
    completionError = null;
    completing = false;
  }

  onDestroy(() => {
    clearTimeout(timer);
    requests.cancel();
  });

  async function complete(field: "include" | "exclude", text: string) {
    const query = text.match(/\S+$/)?.[0]?.replace(/^-/, "") ?? "";
    if (query.length < 2) return;
    const request = requests.begin();
    completing = true;
    completionError = null;
    try {
      const results = await autocompleteDanbooru(api, query, request.signal);
      if (request.isCurrent() && draft.mode === "simple" && draft.filters[field] === text) suggestions = results;
    } catch (error) {
      if (request.isCurrent() && !isAbortError(error)) completionError = apiErrorMessage(error);
    } finally {
      if (request.isCurrent()) completing = false;
    }
  }

  function change<K extends keyof DanbooruFilters>(key: K, value: DanbooruFilters[K]) {
    if (draft.mode !== "simple") return;
    onchange({ mode: "simple", filters: { ...draft.filters, [key]: value } });
    if (key === "include" || key === "exclude") {
      stopCompletion();
      tagField = key;
      timer = setTimeout(() => void complete(key, value), 300);
    }
  }

  function switchQueryMode() {
    stopCompletion();
    onchange(draft.mode === "simple" ? rawDanbooruQuery(draft) : clearDanbooruQuery());
  }
</script>

<div class="flex items-center justify-between gap-3">
  <span class="text-xs font-medium text-fg2">{draft.mode === "simple" ? m.danbooru_simple_query() : m.danbooru_raw_query()}</span>
  <Button type="button" variant="ghost" size="sm" onclick={switchQueryMode}>
    {draft.mode === "simple" ? m.danbooru_use_raw() : m.danbooru_clear_to_simple()}
  </Button>
</div>

{#if draft.mode === "raw"}
  <label for="{uid}-raw" class="sr-only">{m.danbooru_raw_query()}</label>
  <Textarea id="{uid}-raw" value={draft.text} rows={2} oninput={(event) => onchange({ mode: "raw", text: event.currentTarget.value })} />
  <p class="text-2xs text-fg3">{m.danbooru_raw_preserved()}</p>
{:else}
  <fieldset class="grid min-w-0 gap-3 sm:grid-cols-2">
    <legend class="sr-only">{m.danbooru_tags()}</legend>
    <label for="{uid}-include" class="flex min-w-0 flex-col gap-1 text-xs text-fg2">
      {m.danbooru_include()}
      <Input id="{uid}-include" value={draft.filters.include} list={tagField === "include" ? `${uid}-tags` : undefined}
        autocomplete="off" placeholder={m.danbooru_tags_placeholder()} oninput={(event) => change("include", event.currentTarget.value)} />
    </label>
    <label for="{uid}-exclude" class="flex min-w-0 flex-col gap-1 text-xs text-fg2">
      {m.danbooru_exclude()}
      <Input id="{uid}-exclude" value={draft.filters.exclude} list={tagField === "exclude" ? `${uid}-tags` : undefined}
        autocomplete="off" placeholder={m.danbooru_exclude_placeholder()} oninput={(event) => change("exclude", event.currentTarget.value)} />
    </label>
  </fieldset>
  <datalist id="{uid}-tags">
    {#each suggestions as suggestion (suggestion.value)}
      <option value={replaceLastDanbooruTag(tagText, suggestion.value)}>{suggestion.label} · {suggestion.category}{suggestion.count === null ? "" : ` · ${suggestion.count}`}</option>
    {/each}
  </datalist>
  {#if completing}<p class="text-2xs text-fg3" role="status">{m.danbooru_completing()}</p>{/if}
  {#if completionError}
    <div class="flex items-center gap-2 text-2xs text-danger" role="alert">
      {m.danbooru_completion_error({ error: completionError })}
      <Button type="button" variant="ghost" size="sm" onclick={() => void complete(tagField, tagText)}>{m.common_retry()}</Button>
    </div>
  {/if}
  <details class="text-xs text-fg2">
    <summary class="w-fit cursor-pointer rounded-sm py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">{m.danbooru_filters()}</summary>
    <fieldset class="mt-2 grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <legend class="sr-only">{m.danbooru_filters()}</legend>
      <label class="flex min-w-0 flex-col gap-1">
        {m.danbooru_rating()}
        <select value={draft.filters.rating} onchange={(event) => change("rating", event.currentTarget.value as DanbooruFilters["rating"])}>
          <option value="">{m.danbooru_any()}</option>
          <option value="g">{m.danbooru_rating_g()}</option>
          <option value="s">{m.danbooru_rating_s()}</option>
          <option value="q">{m.danbooru_rating_q()}</option>
          <option value="e">{m.danbooru_rating_e()}</option>
        </select>
      </label>
      <label for="{uid}-width" class="flex min-w-0 flex-col gap-1">
        {m.danbooru_min_width()}
        <Input id="{uid}-width" type="number" min="1" step="1" value={draft.filters.minWidth} placeholder="—"
          oninput={(event) => change("minWidth", event.currentTarget.value)} />
      </label>
      <label for="{uid}-height" class="flex min-w-0 flex-col gap-1">
        {m.danbooru_min_height()}
        <Input id="{uid}-height" type="number" min="1" step="1" value={draft.filters.minHeight} placeholder="—"
          oninput={(event) => change("minHeight", event.currentTarget.value)} />
      </label>
      <label class="flex min-w-0 flex-col gap-1">
        {m.danbooru_ratio()}
        <select value={draft.filters.ratio} onchange={(event) => change("ratio", event.currentTarget.value as DanbooruFilters["ratio"])}>
          <option value="">{m.danbooru_any()}</option>
          <option value="<1">{m.danbooru_portrait()}</option>
          <option value="1">{m.danbooru_square()}</option>
          <option value=">1">{m.danbooru_landscape()}</option>
        </select>
      </label>
      <label class="flex min-w-0 flex-col gap-1">
        {m.danbooru_format()}
        <select value={draft.filters.format} onchange={(event) => change("format", event.currentTarget.value as DanbooruFilters["format"])}>
          <option value="">{m.danbooru_any()}</option>
          {#each ["jpg", "png", "webp", "gif", "avif"] as format (format)}<option value={format}>{format.toUpperCase()}</option>{/each}
        </select>
      </label>
      <label class="flex min-w-0 flex-col gap-1">
        {m.danbooru_order()}
        <select value={draft.filters.order} onchange={(event) => change("order", event.currentTarget.value as DanbooruFilters["order"])}>
          <option value="id_desc">{m.danbooru_order_newest()}</option>
          <option value="id_asc">{m.danbooru_order_oldest()}</option>
          <option value="score">{m.danbooru_order_score()}</option>
          <option value="rank">{m.danbooru_order_rank()}</option>
          <option value="random">{m.danbooru_order_random()}</option>
        </select>
      </label>
    </fieldset>
  </details>
  <p class="break-words font-mono text-2xs text-fg3" aria-label={m.danbooru_generated_query()}>{danbooruQueryText(draft)}</p>
{/if}

<style>
  select {
    height: var(--control);
    min-width: 0;
    border: 1px solid var(--color-input);
    border-radius: var(--radius-md);
    background: var(--color-bg1);
    padding: 0 9px;
    color: var(--color-fg);
    outline: none;
  }
  select:focus-visible { border-color: var(--color-ring); }
</style>
