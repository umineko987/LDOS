<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { untrack } from "svelte";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    addDatasetRoot,
    createDataset,
    DATASET_KINDS,
    datasetKeys,
    datasetListQuery,
    invalidateForDatasetEvent,
    type DatasetKind,
    type DatasetRootCreate,
  } from "#lib/api/queries/datasets.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Label } from "#lib/components/ui/label/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 加入数据集：把当前文件夹（来源根目录时是整个来源）挂进一个已有的数据集，或就地新建一个。
  // 数据集只按文件夹引用图库（POST /datasets/{id}/roots），不能挂单张图片。
  let {
    open = $bindable(false),
    root,
    label,
    onadded,
  }: {
    open?: boolean;
    /** `{ directory_id }` 或 `{ source_id }`。 */
    root: DatasetRootCreate | null;
    /** 文件夹的显示名（来源名 / 路径）。 */
    label: string;
    onadded: (datasetId: string, datasetName: string) => void;
  } = $props();

  const api = useApi();
  const client = useQueryClient();

  const NEW = "__new__";
  let choice = $state<string | null>(null);
  let name = $state("");
  let kind = $state<DatasetKind>("character");
  let error = $state<string | null>(null);
  let submitting = $state(false);

  const datasets = createQuery(() => ({ ...datasetListQuery(api), enabled: open }));
  const list = $derived(datasets.data ?? []);
  const creating = $derived(choice === NEW);
  const ready = $derived(root !== null && choice !== null && (!creating || name.trim().length > 0));

  const KIND_LABELS: Record<DatasetKind, () => string> = {
    character: m.dataset_kind_character,
    style: m.dataset_kind_style,
    concept: m.dataset_kind_concept,
  };
  const kinds = $derived(DATASET_KINDS.map((value) => ({ value, label: KIND_LABELS[value]() })));

  // 父组件直接改 open 时 bits-ui 不调 onOpenChange，所以在这里按 open 的变化重置。
  $effect.pre(() => {
    if (!open) return;
    untrack(() => {
      choice = null;
      name = "";
      kind = "character";
      error = null;
      submitting = false;
    });
  });

  // 一个数据集都没有时直接进入新建。
  $effect(() => {
    if (open && datasets.isSuccess && list.length === 0 && choice === null) choice = NEW;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!ready || !root || submitting) return;
    submitting = true;
    error = null;
    try {
      let id = choice!;
      let datasetName = list.find((item) => item.dataset_id === id)?.name ?? "";
      if (creating) {
        const created = await createDataset(api, { name: name.trim(), kind });
        id = created.dataset_id;
        datasetName = created.name;
        void client.invalidateQueries({ queryKey: datasetKeys.list() });
      }
      await addDatasetRoot(api, id, root);
      invalidateForDatasetEvent(client, "dataset.updated", { dataset_id: id, reason: "roots" });
      open = false;
      onadded(id, datasetName);
    } catch (failure) {
      error = apiErrorMessage(failure);
    } finally {
      submitting = false;
    }
  }

  useOverlay(() => open, { id: "library-add-dataset" });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-[min(520px,92vw)]" data-testid="library-add-dataset">
    <Dialog.Header>
      <Dialog.Title>{m.library_add_title()}</Dialog.Title>
      <Dialog.Description>{m.library_add_hint({ name: label })}</Dialog.Description>
    </Dialog.Header>
    <form class="flex flex-col gap-3" id="library-add-form" onsubmit={submit}>
      <div class="flex max-h-[260px] flex-col overflow-y-auto rounded-md border border-line" role="radiogroup" aria-label={m.library_add_pick()}>
        {#if datasets.isPending}
          <p class="px-3 py-2 text-xs text-fg3" role="status">{m.library_loading()}</p>
        {:else if datasets.isError}
          <p class="px-3 py-2 text-xs text-danger" role="alert">{apiErrorMessage(datasets.error)}</p>
        {/if}
        {#each list as dataset (dataset.dataset_id)}
          {@const selected = choice === dataset.dataset_id}
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            class={cn(
              "flex min-h-row items-center gap-2.5 border-b border-line px-3 text-left text-sm last:border-b-0 hover:bg-bg2",
              selected && "bg-bg3",
            )}
            data-dataset={dataset.dataset_id}
            onclick={() => (choice = dataset.dataset_id)}
          >
            <span class="min-w-0 flex-1 truncate">{dataset.name}</span>
            <span class="flex-none text-2xs text-fg3 tabular-nums">{m.library_add_dataset_count({ count: dataset.member_count })}</span>
            <CheckIcon class={cn("size-3.5 flex-none", selected ? "opacity-100" : "opacity-0")} />
          </button>
        {/each}
        <button
          type="button"
          role="radio"
          aria-checked={creating}
          class={cn(
            "flex min-h-row items-center gap-2.5 px-3 text-left text-sm text-fg2 hover:bg-bg2",
            creating && "bg-bg3 text-fg",
          )}
          data-testid="library-add-new"
          onclick={() => (choice = NEW)}
        >
          <PlusIcon class="size-3.5 flex-none" />
          <span class="flex-1">{m.library_add_new()}</span>
        </button>
      </div>
      {#if creating}
        <div class="flex flex-col gap-1.5">
          <Label for="library-add-name">{m.dataset_field_name()}</Label>
          <Input
            id="library-add-name"
            bind:value={name}
            maxlength={120}
            autocomplete="off"
            placeholder={m.dataset_field_name_placeholder()}
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-fg2">{m.dataset_field_kind()}</span>
          <Segmented options={kinds} value={kind} onchange={(next) => (kind = next)} label={m.dataset_field_kind()} size="sm" />
        </div>
      {/if}
      {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
    </form>
    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="primary" type="submit" form="library-add-form" disabled={!ready || submitting} data-testid="library-add-submit">
        {m.library_add_submit()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
