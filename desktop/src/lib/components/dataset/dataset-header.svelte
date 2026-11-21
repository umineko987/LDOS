<script lang="ts">
  import DownloadIcon from "@lucide/svelte/icons/download";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import { useQueryClient } from "@tanstack/svelte-query";
  import type { Snippet } from "svelte";
  import { toast } from "svelte-sonner";

  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { datasetKeys, deleteDataset, updateDataset, type DatasetDetail } from "#lib/api/queries/datasets.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  import type { DatasetContext, DatasetFormValues } from "./context.ts";
  import DatasetDialog from "./dataset-dialog.svelte";

  // 数据集标题栏：名称 · 类型 · 触发词（点击编辑），右侧菜单里是编辑和删除。阶段轨道放在 children。
  let { dataset, showExport, children }: { dataset: DatasetContext; showExport: boolean; children?: Snippet } = $props();

  const api = useApi();
  const client = useQueryClient();

  let menuOpen = $state(false);
  let editOpen = $state(false);
  let editFocus = $state<"name" | "trigger">("name");
  let deleteOpen = $state(false);
  let deleting = $state(false);

  const KIND_LABELS = {
    character: m.dataset_kind_character,
    style: m.dataset_kind_style,
    concept: m.dataset_kind_concept,
  } as const;

  function edit(field: "name" | "trigger") {
    editFocus = field;
    editOpen = true;
  }

  async function save(values: DatasetFormValues) {
    const updated = await updateDataset(api, dataset.id, {
      name: values.name,
      kind: values.kind,
      trigger_word: values.triggerWord,
    });
    client.setQueryData<DatasetDetail>(datasetKeys.detail(dataset.id), updated);
    void client.invalidateQueries({ queryKey: datasetKeys.list() });
  }

  async function remove() {
    deleting = true;
    try {
      await deleteDataset(api, dataset.id);
      client.removeQueries({ queryKey: datasetKeys.dataset(dataset.id) });
      void client.invalidateQueries({ queryKey: datasetKeys.list() });
      deleteOpen = false;
      toast.success(m.dataset_deleted({ name: dataset.name }));
      await goto("#/");
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      deleting = false;
    }
  }

  useOverlay(() => menuOpen, { id: "dataset-menu" });
  useOverlay(() => deleteOpen, { id: "dataset-delete" });
</script>

<header class="flex flex-col border-b border-line px-7 pt-4" data-testid="dataset-header">
  <div class="flex min-h-control items-center gap-3">
    <h1 class="truncate text-lg font-semibold tracking-[0.01em]">{dataset.name}</h1>
    {#if dataset.detail}
      <span class="flex min-w-0 items-center gap-2 text-xs text-fg3">
        {#if dataset.kind}<span data-testid="dataset-kind">{KIND_LABELS[dataset.kind]()}</span>{/if}
        <span aria-hidden="true">·</span>
        <button
          type="button"
          class="truncate rounded-sm font-mono text-fg2 transition-colors hover:text-fg"
          title={m.dataset_trigger_edit()}
          data-testid="dataset-trigger"
          onclick={() => edit("trigger")}
        >
          {dataset.triggerWord || m.dataset_trigger_empty()}
        </button>
      </span>
      <div class="ml-auto flex items-center gap-2">
        {#if showExport}
          <Button variant="outline" size="sm" href={resolve("/datasets/[id]/export", { id: dataset.id })} data-testid="dataset-export-direct">
            <DownloadIcon data-icon="inline-start" />{m.dataset_export_direct()}
          </Button>
        {/if}
        <DropdownMenu.Root bind:open={menuOpen}>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button variant="ghost" size="icon" aria-label={m.dataset_menu()} {...props}><EllipsisIcon /></Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="min-w-40">
            <DropdownMenu.Item onSelect={() => edit("name")}><PencilIcon />{m.dataset_edit()}</DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item class="text-danger" onSelect={() => (deleteOpen = true)}>
              <Trash2Icon />{m.dataset_delete()}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    {/if}
  </div>
  {@render children?.()}
</header>

<DatasetDialog
  bind:open={editOpen}
  mode="edit"
  focusField={editFocus}
  initial={{ name: dataset.name, kind: dataset.kind, triggerWord: dataset.triggerWord }}
  onsubmit={save}
/>

<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content data-testid="dataset-delete-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.dataset_delete_title({ name: dataset.name })}</Dialog.Title>
      <Dialog.Description>{m.dataset_delete_hint()}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="destructive" disabled={deleting} onclick={remove}>{m.dataset_delete_confirm()}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
