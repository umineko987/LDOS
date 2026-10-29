<script lang="ts">
  import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
  import { createInfiniteQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    emptyTrash,
    invalidateLibrary,
    libraryTrashQuery,
    purgeTrash,
    restoreTrash,
    type LibraryTrashOperation,
  } from "#lib/api/queries/library.ts";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { formatTimestamp } from "#lib/domain/elapsed.ts";
  import { formatBytes } from "#lib/domain/models.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { useBindings, useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 回收区：每次「移到回收区」是一组。可以整组恢复到原位置，或永久删除（不可撤销）。
  const api = useApi();
  const client = useQueryClient();

  const trash = createInfiniteQuery(() => libraryTrashQuery(api));
  const operations = $derived(trash.data?.pages.flatMap((page) => page.operations) ?? []);

  type Confirm = { readonly kind: "one"; readonly operation: LibraryTrashOperation } | { readonly kind: "all" };
  let confirming = $state<Confirm | null>(null);
  let busy = $state<string | null>(null);

  async function restore(operation: LibraryTrashOperation) {
    busy = operation.operation_id;
    try {
      const result = await restoreTrash(api, operation.operation_id);
      toast.success(m.library_trash_restored({ count: result.item_count }));
      void invalidateLibrary(client);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      busy = null;
    }
  }

  async function confirmPurge() {
    const target = confirming;
    if (!target) return;
    try {
      if (target.kind === "all") {
        const result = await emptyTrash(api);
        toast.success(m.library_trash_emptied({ count: result.purged_items }));
      } else {
        await purgeTrash(api, target.operation.operation_id);
        toast.success(m.library_trash_purged({ count: target.operation.item_count }));
      }
      confirming = null;
      void invalidateLibrary(client);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  }

  const group = m.keys_group_library;
  useBindings("page", () => [
    {
      id: "library.trash.empty",
      label: m.library_trash_empty,
      group,
      palette: true,
      when: () => operations.length > 0,
      run: () => {
        confirming = { kind: "all" };
      },
    },
  ]);

  useOverlay(() => confirming !== null, { id: "library-trash-confirm" });
</script>

<PageHeader title={m.library_trash()} subtitle={m.library_trash_subtitle()}>
  {#snippet actions()}
    <Button
      variant="destructive"
      size="sm"
      disabled={operations.length === 0}
      onclick={() => (confirming = { kind: "all" })}
      data-testid="library-trash-empty"
    >
      {m.library_trash_empty()}
    </Button>
  {/snippet}
</PageHeader>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="library-trash">
  {#if trash.isPending}
    <p class="px-7 py-4 text-sm text-fg3" role="status">{m.library_loading()}</p>
  {:else if trash.isError}
    <div class="flex items-center gap-3 px-7 py-4 text-sm text-danger" role="alert">
      {apiErrorMessage(trash.error)}
      <Button variant="outline" size="sm" onclick={() => trash.refetch()}>{m.common_retry()}</Button>
    </div>
  {:else if operations.length === 0}
    <p class="px-7 py-6 text-sm text-fg3" data-testid="library-trash-none">{m.library_trash_none()}</p>
  {:else}
    <ul class="flex flex-col" aria-label={m.library_trash()}>
      {#each operations as operation (operation.operation_id)}
        <li
          class="grid min-h-row grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-line px-7 py-2"
          data-operation={operation.operation_id}
        >
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-sm text-fg tabular-nums">{m.library_trash_items({ count: operation.item_count })}</span>
            <span class="flex flex-wrap gap-x-3 text-2xs text-fg3 tabular-nums">
              <span>{formatTimestamp(operation.created_at, i18n.current)}</span>
              {#if operation.has_txt_count}<span>{m.library_trash_txt({ count: operation.has_txt_count })}</span>{/if}
              <span>{formatBytes(operation.disk_usage_bytes, i18n.current)}</span>
              {#if operation.item_error_count}
                <span class="text-danger">{m.library_trash_errors({ count: operation.item_error_count })}</span>
              {/if}
            </span>
          </div>
          <div class="flex items-center gap-1">
            <Button
              variant="outline"
              size="xs"
              disabled={busy === operation.operation_id}
              onclick={() => restore(operation)}
              data-testid="library-trash-restore"
            >
              <RotateCcwIcon />{m.library_trash_restore()}
            </Button>
            <Button variant="ghost" size="xs" onclick={() => (confirming = { kind: "one", operation })} data-testid="library-trash-purge">
              {m.library_trash_purge()}
            </Button>
          </div>
        </li>
      {/each}
    </ul>
    {#if trash.hasNextPage}
      <div class="px-7 py-3">
        <Button variant="outline" size="sm" disabled={trash.isFetchingNextPage} onclick={() => trash.fetchNextPage()}>
          {m.library_load_more()}
        </Button>
      </div>
    {/if}
  {/if}
</div>

<Dialog.Root
  open={confirming !== null}
  onOpenChange={(next) => {
    if (!next) confirming = null;
  }}
>
  <Dialog.Content data-testid="library-trash-confirm">
    <Dialog.Header>
      <Dialog.Title>
        {#if confirming?.kind === "one"}
          {m.library_trash_purge_title({ count: confirming.operation.item_count })}
        {:else}
          {m.library_trash_empty_title()}
        {/if}
      </Dialog.Title>
      <Dialog.Description>{m.library_trash_purge_hint()}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="destructive" onclick={confirmPurge} data-testid="library-trash-confirm-submit">
        {confirming?.kind === "all" ? m.library_trash_empty() : m.library_trash_purge()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
