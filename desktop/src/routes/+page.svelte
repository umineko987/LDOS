<script lang="ts">
  import PlusIcon from "@lucide/svelte/icons/plus";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { tick } from "svelte";

  import { goto } from "$app/navigation";
  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { createDataset, datasetKeys, datasetListQuery } from "#lib/api/queries/datasets.ts";
  import { useDatasetEvents } from "#lib/api/queries/datasets-live.svelte.ts";
  import type { DatasetFormValues } from "#lib/components/dataset/context.ts";
  import DatasetCard from "#lib/components/dataset/dataset-card.svelte";
  import DatasetDialog from "#lib/components/dataset/dataset-dialog.svelte";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { useBindings } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 首页：数据集列表。每行一张卡片（封面、名称、迷你漏斗、可导出张数），↑/↓ 或 J/K 移动，Enter 打开，N 新建。
  const api = useApi();
  const client = useQueryClient();
  const list = createQuery(() => datasetListQuery(api));
  useDatasetEvents();

  const datasets = $derived(list.data ?? []);
  let createOpen = $state(false);
  let focus = $state(-1);
  const cards: (HTMLAnchorElement | null | undefined)[] = $state([]);

  $effect(() => {
    if (focus >= datasets.length) focus = datasets.length - 1;
  });

  async function create(values: DatasetFormValues) {
    const dataset = await createDataset(api, {
      name: values.name,
      kind: values.kind,
      trigger_word: values.triggerWord,
    });
    void client.invalidateQueries({ queryKey: datasetKeys.list() });
    await goto(`#/datasets/${encodeURIComponent(dataset.dataset_id)}/collect`);
  }

  async function move(delta: number) {
    if (datasets.length === 0) return;
    focus = focus < 0 ? (delta > 0 ? 0 : datasets.length - 1) : Math.min(datasets.length - 1, Math.max(0, focus + delta));
    await tick();
    cards[focus]?.focus();
  }

  const group = m.keys_group_dataset;
  useBindings("page", () => [
    {
      id: "home.create",
      keys: "n",
      label: m.home_key_create,
      group,
      palette: true,
      run: () => {
        createOpen = true;
      },
    },
    {
      id: "home.next",
      keys: ["arrowdown", "j"],
      label: m.home_key_next,
      group,
      when: () => datasets.length > 0,
      run: () => void move(1),
    },
    {
      id: "home.prev",
      keys: ["arrowup", "k"],
      label: m.home_key_prev,
      group,
      when: () => datasets.length > 0,
      run: () => void move(-1),
    },
    {
      id: "home.open",
      keys: "enter",
      label: m.home_key_open,
      group,
      // 焦点已经在卡片（链接）上时让浏览器自己打开。
      when: () => focus >= 0 && document.activeElement !== cards[focus],
      run: () => cards[focus]?.click(),
    },
  ]);
</script>

<PageHeader title={m.nav_datasets()} subtitle={list.data ? m.home_count({ count: datasets.length }) : undefined}>
  {#snippet actions()}
    <Button variant="primary" onclick={() => (createOpen = true)} data-testid="dataset-create">
      <PlusIcon />{m.home_create()} <Kbd class="ml-1 bg-gold-ink/10 text-gold-ink">N</Kbd>
    </Button>
  {/snippet}
</PageHeader>

<div class="min-h-0 flex-1 overflow-y-auto px-7 py-5" data-testid="dataset-list">
  {#if list.isPending}
    <p class="text-sm text-fg3" role="status">{m.home_loading()}</p>
  {:else if list.isError}
    <div class="flex items-center gap-3 text-sm text-danger" role="alert">
      {m.home_load_failed({ reason: apiErrorMessage(list.error) })}
      <Button variant="outline" size="sm" onclick={() => list.refetch()}>{m.common_retry()}</Button>
    </div>
  {:else if datasets.length === 0}
    <div class="flex max-w-[460px] flex-col items-start gap-3 pt-10" data-testid="dataset-empty">
      <h2 class="text-base font-medium">{m.home_empty_title()}</h2>
      <p class="text-sm text-fg2">{m.home_empty_hint()}</p>
      <Button variant="outline" onclick={() => (createOpen = true)}><PlusIcon />{m.home_create()}</Button>
    </div>
  {:else}
    <ul class="flex max-w-[1080px] flex-col gap-2" aria-label={m.nav_datasets()}>
      {#each datasets as dataset, index (dataset.dataset_id)}
        <li>
          <DatasetCard {dataset} focused={focus === index} bind:ref={cards[index]} />
        </li>
      {/each}
    </ul>
  {/if}
</div>

<DatasetDialog bind:open={createOpen} mode="create" onsubmit={create} />
