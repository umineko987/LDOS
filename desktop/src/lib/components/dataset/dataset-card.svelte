<script lang="ts">
  import ImagesIcon from "@lucide/svelte/icons/images";

  import { resolve } from "$app/paths";
  import { useApi } from "#lib/api/context.ts";
  import type { DatasetSummary } from "#lib/api/queries/datasets.ts";
  import { outputBars } from "#lib/domain/funnel.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  import FunnelChart from "./funnel-chart.svelte";

  // 首页的一行数据集卡片：封面 | 名称、类型、触发词 | 迷你漏斗 | 可导出张数。
  let {
    dataset,
    focused = false,
    ref = $bindable(),
  }: { dataset: DatasetSummary; focused?: boolean; ref?: HTMLAnchorElement | null | undefined } = $props();

  const api = useApi();

  const KIND_LABELS = {
    character: m.dataset_kind_character,
    style: m.dataset_kind_style,
    concept: m.dataset_kind_concept,
  } as const;

  const bars = $derived(outputBars(dataset.member_count, dataset.stage_outputs));
  const cover = $derived(dataset.cover_thumbnail_url ? api.resourceUrl(dataset.cover_thumbnail_url) : null);
  const updated = $derived(
    new Intl.DateTimeFormat(i18n.current, { dateStyle: "medium" }).format(new Date(dataset.updated_at * 1000)),
  );
</script>

<a
  bind:this={ref}
  href={resolve("/datasets/[id]/collect", { id: dataset.dataset_id })}
  data-testid="dataset-card"
  data-dataset={dataset.dataset_id}
  data-focused={focused || undefined}
  class="grid grid-cols-[56px_minmax(0,1fr)_auto_120px] items-center gap-5 rounded-lg border border-line bg-bg1 px-4 py-3 transition-colors duration-(--t-color) hover:border-line2 data-focused:border-line3"
>
  <span class="flex h-[70px] w-14 items-center justify-center overflow-hidden rounded-md bg-bg2 text-fg3">
    {#if cover}
      <img crossorigin="anonymous" src={cover} alt="" loading="lazy" draggable="false" class="size-full object-cover" />
    {:else}
      <ImagesIcon class="size-4" />
    {/if}
  </span>
  <span class="flex min-w-0 flex-col gap-1">
    <span class="truncate text-sm font-medium text-fg">{dataset.name}</span>
    <span class="flex min-w-0 items-center gap-1.5 text-2xs text-fg3">
      <span>{KIND_LABELS[dataset.kind]()}</span>
      {#if dataset.trigger_word}<span aria-hidden="true">·</span><span class="truncate font-mono text-fg2">{dataset.trigger_word}</span>{/if}
      <span aria-hidden="true">·</span>
      <span>{m.home_card_roots({ count: dataset.root_count })}</span>
      <span aria-hidden="true">·</span>
      <span>{m.home_card_updated({ date: updated })}</span>
    </span>
  </span>
  <FunnelChart {bars} />
  <span class="flex flex-col items-end">
    <span class="text-[15px] font-medium text-fg tabular-nums" data-testid="dataset-output">{dataset.output_count}</span>
    <span class="text-2xs text-fg3">{m.home_card_output({ total: dataset.member_count })}</span>
  </span>
</a>
