<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";

  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { useApi } from "#lib/api/context.ts";
  import { isApiError } from "#lib/api/errors.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { datasetDetailQuery } from "#lib/api/queries/datasets.ts";
  import { useDatasetEvents } from "#lib/api/queries/datasets-live.svelte.ts";
  import { setDataset, type DatasetContext } from "#lib/components/dataset/context.ts";
  import DatasetHeader from "#lib/components/dataset/dataset-header.svelte";
  import StageRail from "#lib/components/dataset/stage-rail.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { adjacentStage, railStages } from "#lib/domain/funnel.ts";
  import { useBindings } from "#lib/keys/bindings.svelte.ts";
  import { STAGES, stageOf, type Stage } from "#lib/nav/routes.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 数据集外框：标题栏（名称 · 类型 · 触发词）+ 阶段轨道。每个阶段页只渲染自己的内容，放在下面的 children 里，
  // 通过 useDataset()（#lib/components/dataset/context.ts）拿数据集、触发词和各段计数。
  let { children } = $props();

  const api = useApi();
  const id = $derived(page.params.id ?? "");
  const current = $derived(stageOf(page.route.id));

  const detail = createQuery(() => datasetDetailQuery(api, id));
  useDatasetEvents(() => id);

  const stages = $derived(railStages(detail.data?.funnel));
  const notFound = $derived(isApiError(detail.error) && detail.error.status === 404);

  const dataset: DatasetContext = {
    get id() {
      return id;
    },
    get detail() {
      return detail.data;
    },
    get loading() {
      return detail.isPending;
    },
    get error() {
      return detail.error;
    },
    get name() {
      return detail.data?.name ?? m.page_dataset({ id });
    },
    get kind() {
      return detail.data?.kind;
    },
    get triggerWord() {
      return detail.data?.trigger_word ?? "";
    },
    get funnel() {
      return detail.data?.funnel ?? [];
    },
    get stages() {
      return stages;
    },
    stage: (name) => stages.find((item) => item.stage === name),
  };
  setDataset(dataset);

  // 连按 [ / ] 时从上一次要去的段算起，不等路由切换完。
  let pending: { from: Stage | null; to: Stage } | null = null;
  function step(delta: 1 | -1) {
    const from = pending && pending.from === current ? pending.to : current;
    const to = adjacentStage(STAGES, from, delta);
    pending = { from: current, to };
    void goto(`#/datasets/${encodeURIComponent(id)}/${to}`);
  }

  const group = m.keys_group_dataset;
  useBindings("page", () => [
    {
      id: "dataset.stage.prev",
      keys: "[",
      label: m.dataset_key_prev_stage,
      group,
      run: () => step(-1),
    },
    {
      id: "dataset.stage.next",
      keys: "]",
      label: m.dataset_key_next_stage,
      group,
      run: () => step(1),
    },
  ]);
</script>

<DatasetHeader {dataset} showExport={current !== "export"}>
  <StageRail {id} {current} {stages} />
</DatasetHeader>

<div class="flex min-h-0 flex-1 flex-col">
  {#if notFound}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-fg2" data-testid="dataset-missing">
      <p>{m.dataset_not_found()}</p>
      <Button variant="outline" href="#/">{m.dataset_back_home()}</Button>
    </div>
  {:else}
    {#if detail.isError}
      <p class="flex items-center gap-3 border-b border-line px-7 py-2 text-xs text-danger" role="alert">
        {m.dataset_load_failed({ reason: apiErrorMessage(detail.error) })}
        <Button variant="ghost" size="xs" onclick={() => detail.refetch()}>{m.common_retry()}</Button>
      </p>
    {/if}
    {@render children()}
  {/if}
</div>
