<script lang="ts">
  import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import LockIcon from "@lucide/svelte/icons/lock";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { onDestroy } from "svelte";
  import { toast } from "svelte-sonner";

  import { resolve } from "$app/paths";
  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    assetThumbnailPath,
    captionBatchesQuery,
    captionsFromTagger,
    captionsQuery,
    type CaptionsFromTaggerRequest,
  } from "#lib/api/queries/captions.ts";
  import { useCaptionEvents } from "#lib/api/queries/captions-live.svelte.ts";
  import { datasetKeys, datasetStageRunsQuery } from "#lib/api/queries/datasets.ts";
  import {
    cancelTagger,
    candidatesQuery,
    invalidateCandidates,
    runTagStage,
    taggerModelsQuery,
  } from "#lib/api/queries/tagger.ts";
  import { useCaptionFeedback } from "#lib/components/captions/batch-feedback.svelte.ts";
  import TagDiff from "#lib/components/captions/tag-diff.svelte";
  import { TAG_CATEGORY_LABEL, TAG_TEXT_CLASS } from "#lib/components/captions/tag-colors.ts";
  import { useDataset } from "#lib/components/dataset/context.ts";
  import { ModelGate } from "#lib/components/model-install/index.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import ThresholdSlider from "#lib/components/tag/threshold-slider.svelte";
  import WriteDialog from "#lib/components/tag/write-dialog.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { Progress } from "#lib/components/ui/progress/index.ts";
  import { categoryIndex, type CaptionMode } from "#lib/domain/captions.ts";
  import {
    activeCategories,
    categoryOptions,
    composeTags,
    fromTaggerRequest,
    indexCandidates,
    lastRunInterrupted,
    latestTagBatch,
    planTagging,
    roundThreshold,
    savedTagSettings,
    sliderCategories,
    thresholdMin,
    thresholdOverrides,
    THRESHOLD_MAX,
    THRESHOLD_STEP,
    type OutputCategory,
    type TagSettings,
  } from "#lib/domain/tag-plan.ts";
  import { DEFAULT_TAG_FORMAT, type SelectionModel, type TagFormat, type Thresholds } from "#lib/domain/tagger-select.ts";
  import { useEvent } from "#lib/events/context.svelte.ts";
  import { isActiveJob, jobProgress } from "#lib/events/jobs.ts";
  import { useJobs } from "#lib/events/jobs.svelte.ts";
  import { useBindings } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 打标段：选模型 → 计算分数（tag 阶段运行，分数进缓存，不写 caption）→ 拖阈值，在浏览器里按候选分数
  // 实时重算每张图的标签、频率表和「相比现有 caption 改动几张」→ 预览写入（后端 dry-run）→ 写入，可撤销。
  // 设置不单独保存：打开页面时沿用最近一次打标写入的参数。
  const api = useApi();
  const client = useQueryClient();
  const dataset = useDataset();
  const jobs = useJobs();
  const id = $derived(dataset.id);
  const feedback = useCaptionFeedback(() => id);
  useCaptionEvents(() => id);

  const MAX_MODELS = 8;
  const FREQUENCY_ROWS = 60;
  const SAMPLE_ROWS = 6;

  const taggerModels = createQuery(() => taggerModelsQuery(api));
  const batches = createQuery(() => captionBatchesQuery(api, id));
  // 只在模型就绪后的分支里读 caption 列表：默认的属性追踪下，列表先于就绪返回就不会再通知，预览一直是 0 / 0。
  const captions = createQuery(() => ({ ...captionsQuery(api, id), notifyOnChangeProps: "all" as const }));

  let selected = $state.raw<readonly string[]>([]);
  let overrides = $state.raw<Readonly<Record<string, Thresholds>>>({});
  let chosenCategories = $state.raw<readonly string[] | null>(null);
  let format = $state.raw<TagFormat>(DEFAULT_TAG_FORMAT);
  let mode = $state<CaptionMode>("merge");
  let ready = $state(false);
  let showAll = $state(false);
  let writeOpen = $state(false);
  let initializedFor = "";

  // 模型表和批次历史都到了以后初始化一次：沿用最近一次打标写入的设置，否则选第一个已安装的模型。
  $effect(() => {
    const models = taggerModels.data;
    if (initializedFor === id || !models || batches.isPending) return;
    initializedFor = id;
    const known = new Set(models.map((model) => model.key));
    const latest = latestTagBatch(batches.data);
    const saved = latest ? savedTagSettings(latest.params) : null;
    if (saved && saved.models.every((key) => known.has(key))) {
      selected = saved.models;
      overrides = saved.thresholds;
      chosenCategories = saved.categories;
      format = saved.format;
      return;
    }
    const first = models.find((model) => model.installed) ?? models[0];
    selected = first ? [first.key] : [];
    overrides = {};
    chosenCategories = null;
    format = DEFAULT_TAG_FORMAT;
  });

  const candidates = createQuery(() => ({
    ...candidatesQuery(api, id, selected),
    enabled: ready && selected.length > 0,
  }));

  const index = $derived(candidates.data ? indexCandidates(candidates.data.candidates) : null);
  const models = $derived<readonly SelectionModel[]>(index?.models ?? []);
  const options = $derived(categoryOptions(models));
  const categories = $derived(activeCategories(options, chosenCategories));
  const stats = $derived(candidates.data?.candidates.stats);
  const floor = $derived(index?.floor ?? 0.01);
  const categoryOf = $derived(index ? categoryIndex(index.models.map((model) => model.tags)) : undefined);
  const entries = $derived(captions.data?.list.items ?? []);
  const names = $derived(new Map(entries.map((item) => [item.asset_id, item.name])));
  const nameOf = (assetId: string) => names.get(assetId) ?? assetId;

  // 拖动滑块时设置立即变（数值跟手），重算按帧合并：每帧最多算一次。
  const draft = $derived<TagSettings>({ thresholds: thresholdOverrides(models, overrides), categories, format });
  let live = $state.raw<TagSettings | null>(null);
  let frame = 0;
  $effect(() => {
    void draft;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      live = draft;
    });
  });
  onDestroy(() => cancelAnimationFrame(frame));
  const settings = $derived(live ?? draft);

  const composed = $derived(index && settings.categories?.length ? composeTags(index, settings) : null);
  const plan = $derived(
    composed ? planTagging(entries, composed, { mode, triggerWord: dataset.triggerWord, categoryOf }) : null,
  );
  const estimate = $derived(mode === "merge");
  const frequency = $derived(plan ? (showAll ? plan.frequency : plan.frequency.slice(0, FREQUENCY_ROWS)) : []);
  const request = $derived<CaptionsFromTaggerRequest | null>(
    models.length && categories.length ? fromTaggerRequest({ models, thresholds: overrides, categories, format, mode }) : null,
  );

  // ---- 模型和阈值 ----

  function toggleModel(key: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    selected = (taggerModels.data ?? []).map((model) => model.key).filter((item) => next.has(item)).slice(0, MAX_MODELS);
  }

  const thresholdOf = (model: SelectionModel, category: string) =>
    overrides[model.key]?.[category] ?? model.default_thresholds[category] ?? 0;

  function setThreshold(model: SelectionModel, category: string, value: number) {
    overrides = { ...overrides, [model.key]: { ...overrides[model.key], [category]: roundThreshold(value) } };
  }

  function toggleCategory(category: OutputCategory, on: boolean) {
    const next = new Set(categories);
    if (on) next.add(category);
    else next.delete(category);
    chosenCategories = options.filter((item) => next.has(item));
  }

  // ---- 计算分数（tag 阶段运行） ----

  let runJobId = $state<string | null>(null);
  let starting = $state(false);
  const tagJob = $derived(
    (runJobId ? jobs.get(runJobId) : undefined) ??
      jobs.active.find((job) => job.kind === "tagger.tag" && job.ref.dataset_id === id),
  );
  const tagging = $derived(tagJob !== undefined && isActiveJob(tagJob));
  const progress = $derived(tagJob ? jobProgress(tagJob) : null);
  const tagRuns = createQuery(() => datasetStageRunsQuery(api, id, "tag"));
  const interrupted = $derived(lastRunInterrupted(tagRuns.data));

  useEvent("job.updated", ({ job }) => {
    if (job.kind !== "tagger.tag" || job.ref.dataset_id !== id || isActiveJob(job)) return;
    void invalidateCandidates(client, id);
    void client.invalidateQueries({ queryKey: datasetKeys.stageRuns(id, "tag") });
    if (job.status === "succeeded" && job.id === runJobId) toast.success(m.tag_run_done());
  });

  async function runTagger() {
    if (!selected.length || starting || tagging) return;
    starting = true;
    try {
      const run = await runTagStage(api, id, { models: [...selected] });
      runJobId = run.ref_id || null;
    } catch (error) {
      toast.error(m.tag_run_failed({ reason: apiErrorMessage(error) }));
    } finally {
      starting = false;
    }
  }

  async function cancelRun() {
    try {
      await cancelTagger(api);
    } catch (error) {
      toast.error(m.tag_cancel_failed({ reason: apiErrorMessage(error) }));
    }
  }

  // ---- 写入 ----

  const previewWrite = (body: CaptionsFromTaggerRequest) =>
    captionsFromTagger(api, id, { ...body, dry_run: true, sample_limit: SAMPLE_ROWS });

  async function applyWrite(body: CaptionsFromTaggerRequest) {
    const result = await captionsFromTagger(api, id, { ...body, dry_run: false, sample_limit: 0 });
    feedback.written(result, m.tag_written({ count: result.stats.written }));
  }

  const canWrite = () => request !== null && plan !== null && !writeOpen;
  const group = m.keys_group_tag;
  useBindings("page", () => [
    {
      id: "tag.write",
      keys: "mod+enter",
      label: m.tag_key_write,
      group,
      palette: true,
      when: canWrite,
      run: () => {
        writeOpen = true;
      },
    },
    {
      id: "tag.run",
      label: m.tag_key_run,
      group,
      palette: true,
      when: () => ready && selected.length > 0 && !tagging,
      run: () => void runTagger(),
    },
  ]);

  const modes = [
    { value: "merge" as const, label: m.tag_mode_merge() },
    { value: "overwrite" as const, label: m.tag_mode_overwrite() },
    { value: "fill_empty" as const, label: m.tag_mode_fill_empty() },
  ];
  const modeHint = { merge: m.tag_mode_merge_hint, overwrite: m.tag_mode_overwrite_hint, fill_empty: m.tag_mode_fill_empty_hint };
  const formatDelta = (delta: number) => (delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : "");
</script>

{#snippet section(title: string)}
  <h3 class="text-2xs font-medium tracking-wide text-fg3 uppercase">{title}</h3>
{/snippet}

<div class="flex min-h-0 flex-1" data-testid="tag-page">
  <aside class="flex w-[300px] flex-none flex-col border-r border-line" aria-label={m.tag_settings()}>
    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
      <section class="flex flex-col gap-2">
        {@render section(m.tag_models())}
        {#if taggerModels.isError}
          <p class="text-xs text-danger" role="alert">{apiErrorMessage(taggerModels.error)}</p>
        {:else if taggerModels.isPending}
          <p class="text-xs text-fg3" role="status">{m.tag_loading()}</p>
        {:else}
          <ul class="flex flex-col gap-1" data-testid="tag-models">
            {#each taggerModels.data ?? [] as model (model.key)}
              {@const on = selected.includes(model.key)}
              <li>
                <label class="flex h-6 cursor-pointer items-center gap-2 text-xs">
                  <Checkbox
                    checked={on}
                    disabled={!on && selected.length >= MAX_MODELS}
                    onCheckedChange={(next) => toggleModel(model.key, next === true)}
                    aria-label={model.key}
                    data-model={model.key}
                  />
                  <span class={cn("min-w-0 flex-1 truncate font-mono", on ? "text-fg" : "text-fg2")}>{model.key}</span>
                  {#if model.gated}<LockIcon class="size-3 text-fg3" aria-label={m.tag_model_gated()} />{/if}
                  {#if !model.installed}<span class="text-2xs text-fg3">{m.tag_model_missing()}</span>{/if}
                </label>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if models.length}
        <section class="flex flex-col gap-3" data-testid="tag-thresholds">
          {@render section(m.tag_thresholds())}
          {#each models as model (model.key)}
            <div class="flex flex-col gap-3">
              {#if models.length > 1}<span class="font-mono text-2xs text-fg2">{model.key}</span>{/if}
              {#each sliderCategories(model) as category (category)}
                {@const fallback = model.default_thresholds[category] ?? 0}
                <ThresholdSlider
                  label={TAG_CATEGORY_LABEL[category]()}
                  tone={TAG_TEXT_CLASS[category]}
                  value={thresholdOf(model, category)}
                  defaultValue={fallback}
                  min={thresholdMin(category, fallback, floor)}
                  max={THRESHOLD_MAX}
                  step={THRESHOLD_STEP}
                  muted={!categories.includes(category)}
                  onchange={(value) => setThreshold(model, category, value)}
                  testid={`tag-threshold-${model.key}-${category}`}
                />
              {/each}
            </div>
          {/each}
        </section>

        <section class="flex flex-col gap-2">
          {@render section(m.tag_categories())}
          <p class="text-2xs text-fg3">{m.tag_categories_hint()}</p>
          <div class="flex flex-wrap gap-x-3 gap-y-1.5" data-testid="tag-categories">
            {#each options as category (category)}
              <label class="flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox
                  checked={categories.includes(category)}
                  onCheckedChange={(next) => toggleCategory(category, next === true)}
                  data-category={category}
                />
                <span class={TAG_TEXT_CLASS[category]}>{TAG_CATEGORY_LABEL[category]()}</span>
              </label>
            {/each}
          </div>
          {#if !categories.length}<p class="text-2xs text-warn">{m.tag_categories_none()}</p>{/if}
        </section>

        <section class="flex flex-col gap-2">
          {@render section(m.tag_format())}
          <label class="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={format.underscore_to_space}
              onCheckedChange={(next) => (format = { ...format, underscore_to_space: next === true })}
            />
            {m.tag_format_spaces()}
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={format.escape_parens}
              onCheckedChange={(next) => (format = { ...format, escape_parens: next === true })}
            />
            {m.tag_format_escape()}
          </label>
        </section>
      {/if}

      <section class="flex flex-col gap-2">
        {@render section(m.tag_mode())}
        <Segmented options={modes} value={mode} onchange={(next) => (mode = next)} label={m.tag_mode()} size="sm" data-testid="tag-mode" />
        <p class="text-2xs text-fg3">{modeHint[mode]()}</p>
        {#if dataset.triggerWord}
          <p class="text-2xs text-fg3" data-testid="tag-trigger">
            {m.tag_trigger_pinned()} <span class="font-mono text-tag-character">{dataset.triggerWord}</span>
          </p>
        {/if}
      </section>
    </div>

    <div class="flex flex-none flex-col gap-1.5 border-t border-line px-5 py-3">
      <Button variant="primary" disabled={!canWrite()} onclick={() => (writeOpen = true)} data-testid="tag-write">
        {m.tag_write()}
      </Button>
      <p class="flex items-center justify-center gap-1 text-2xs text-fg3"><Kbd>Ctrl</Kbd><Kbd>↵</Kbd></p>
      {#if latestTagBatch(batches.data)}
        <Button variant="outline" href={resolve("/datasets/[id]/export", { id })}>
          {m.tag_next_stage()}<ArrowRightIcon data-icon="inline-end" />
        </Button>
      {/if}
    </div>
  </aside>

  <div class="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-7 py-4">
    <ModelGate keys={selected} block={false} bind:ready title={m.tag_gate_title()} />

    {#if !selected.length && taggerModels.isSuccess}
      <p class="text-sm text-fg2" data-testid="tag-no-model">{m.tag_pick_model()}</p>
    {:else if ready}
      <section class="flex items-center gap-3 rounded-lg border border-line bg-bg1 px-4 py-2.5" data-testid="tag-scores">
        {#if tagging && tagJob}
          <LoaderCircleIcon class="size-3.5 flex-none animate-spin text-fg3" />
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <span class="text-xs text-fg2">
              {m.tag_running({ done: tagJob.current ?? 0, total: tagJob.total ?? 0 })}
            </span>
            <Progress value={(progress ?? 0) * 100} max={100} />
          </div>
          <Button variant="ghost" size="sm" onclick={cancelRun}>{m.tag_cancel()}</Button>
        {:else}
          <span class="min-w-0 flex-1 text-xs text-fg2">
            {#if candidates.isError}
              <span class="text-danger" role="alert">{apiErrorMessage(candidates.error)}</span>
            {:else if !stats}
              {m.tag_loading()}
            {:else if stats.missing_scores}
              {m.tag_scores_missing({ count: stats.missing_scores, total: stats.total })}
            {:else}
              {m.tag_scores_ready({ count: stats.ok })}
            {/if}
            {#if stats && stats.decode_error + stats.unreadable + stats.unavailable > 0}
              <span class="text-fg3"> · {m.tag_scores_unreadable({ count: stats.decode_error + stats.unreadable + stats.unavailable })}</span>
            {/if}
          </span>
          <Button
            variant={!stats || stats.missing_scores ? "default" : "ghost"}
            size="sm"
            disabled={starting || !selected.length}
            onclick={runTagger}
            data-testid="tag-run"
          >
            {!stats || stats.missing_scores ? m.tag_run() : m.tag_run_again()}
          </Button>
        {/if}
      </section>
      <p class="-mt-3 text-2xs text-fg3">{m.tag_run_hint()}</p>
      {#if interrupted && !tagging}
        <p class="-mt-3 text-2xs text-warn" role="status" data-testid="tag-interrupted">{m.tag_run_interrupted()}</p>
      {/if}

      {#if plan}
        <section class="grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-line bg-line" data-testid="tag-stats">
          {#snippet tile(label: string, value: string, testid: string, count: number, tone = "text-fg")}
            <div class="flex flex-col gap-0.5 bg-bg0 px-4 py-3" data-testid={testid} data-count={count}>
              <span class="text-2xs text-fg3">{label}</span>
              <span class={cn("font-mono text-lg tabular-nums", tone)}>{value}</span>
            </div>
          {/snippet}
          {@render tile(
            estimate ? m.tag_stat_changed_estimate() : m.tag_stat_changed(),
            m.tag_stat_of({ count: plan.changes.length, total: plan.total }),
            "tag-changed",
            plan.changes.length,
          )}
          {@render tile(m.tag_stat_average(), plan.averageTags.toFixed(1), "tag-average", plan.averageTags)}
          {@render tile(m.tag_stat_added(), `+${plan.added}`, "tag-added", plan.added, "text-ok")}
          {@render tile(m.tag_stat_removed(), `−${plan.removed}`, "tag-removed", plan.removed, "text-danger")}
        </section>
        {#if estimate}<p class="-mt-3 text-2xs text-fg3">{m.tag_estimate_hint()}</p>{/if}
        {#if plan.skipped}<p class="-mt-3 text-2xs text-fg3">{m.tag_skipped({ count: plan.skipped })}</p>{/if}

        <section class="flex flex-col gap-2">
          <div class="flex items-baseline gap-3">
            {@render section(m.tag_frequency())}
            <span class="text-2xs text-fg3">{m.tag_frequency_count({ count: plan.frequency.length })}</span>
          </div>
          {#if plan.frequency.length}
            <ol class="grid grid-cols-2 gap-x-6" data-testid="tag-frequency">
              {#each frequency as row (row.tag)}
                <li
                  class="grid h-6 grid-cols-[minmax(0,1fr)_auto_3.5rem] items-center gap-2 border-b border-line text-xs"
                  data-tag={row.tag}
                  data-count={row.count}
                  data-delta={row.delta}
                >
                  <span class={cn("truncate", TAG_TEXT_CLASS[row.category])}>{row.tag}</span>
                  <span class="font-mono text-fg2 tabular-nums">{row.count}</span>
                  <span class={cn("text-right font-mono text-2xs tabular-nums", row.delta > 0 ? "text-ok" : "text-danger")}>
                    {formatDelta(row.delta)}
                  </span>
                </li>
              {/each}
            </ol>
            {#if plan.frequency.length > FREQUENCY_ROWS}
              <Button variant="ghost" size="xs" class="self-start" onclick={() => (showAll = !showAll)}>
                {showAll ? m.tag_frequency_less() : m.tag_frequency_all({ count: plan.frequency.length })}
              </Button>
            {/if}
          {:else}
            <p class="text-xs text-fg3">{m.tag_frequency_empty()}</p>
          {/if}
        </section>

        <section class="flex flex-col gap-2">
          {@render section(m.tag_samples())}
          {#if plan.changes.length}
            <ul class="flex flex-col" data-testid="tag-samples">
              {#each plan.changes.slice(0, SAMPLE_ROWS) as change (change.asset_id)}
                <li class="flex items-center gap-3 border-b border-line py-1.5">
                  <img
                    crossorigin="anonymous"
                    src={api.resourceUrl(assetThumbnailPath(change.asset_id, 128))}
                    alt=""
                    class="size-10 flex-none rounded-sm bg-bg2 object-cover"
                    loading="lazy"
                  />
                  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate text-xs text-fg2">{nameOf(change.asset_id)}</span>
                    <TagDiff added={change.added} removed={change.removed} />
                  </div>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-xs text-fg3" data-testid="tag-no-changes">{m.tag_no_changes()}</p>
          {/if}
        </section>
      {:else if index && !categories.length}
        <p class="text-xs text-fg3">{m.tag_categories_none()}</p>
      {:else if captions.isError}
        <p class="text-xs text-danger" role="alert">{apiErrorMessage(captions.error)}</p>
      {/if}
    {/if}
  </div>
</div>

<WriteDialog bind:open={writeOpen} {request} {nameOf} preview={previewWrite} apply={applyWrite} />
