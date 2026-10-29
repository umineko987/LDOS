<script lang="ts">
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import LibraryIcon from "@lucide/svelte/icons/library";
  import { createInfiniteQuery, createQuery } from "@tanstack/svelte-query";
  import { untrack } from "svelte";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import type { DatasetRootCreate } from "#lib/api/queries/datasets.ts";
  import { libraryDirectoryQuery, librarySourcesQuery, type LibrarySource } from "#lib/api/queries/library.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 从图库添加：先选来源，再逐级进入子目录；“添加”挂上当前位置（来源根目录挂整个来源）。
  let {
    open = $bindable(false),
    onsubmit,
  }: { open?: boolean; onsubmit: (root: DatasetRootCreate, label: string) => Promise<void> } = $props();

  const api = useApi();

  interface Crumb {
    readonly directoryId: string;
    readonly name: string;
  }

  let source = $state<LibrarySource | null>(null);
  let trail = $state<Crumb[]>([]);
  let error = $state<string | null>(null);
  let submitting = $state(false);

  const sources = createQuery(() => ({ ...librarySourcesQuery(api), enabled: open }));
  const here = $derived(trail.at(-1)?.directoryId ?? source?.root_directory_id ?? null);
  const directory = createInfiniteQuery(() => ({
    ...libraryDirectoryQuery(api, here ?? ""),
    enabled: open && here !== null,
  }));
  const children = $derived(directory.data?.pages.flatMap((page) => page.directories) ?? []);

  function reset() {
    source = null;
    trail = [];
    error = null;
    submitting = false;
  }

  // 父组件直接改 open 时 bits-ui 不调 onOpenChange，所以在这里按 open 的变化重置。
  $effect.pre(() => {
    if (open) untrack(reset);
  });

  function label() {
    const name = source?.display_name ?? "";
    return trail.length ? `${name} / ${trail.map((crumb) => crumb.name).join(" / ")}` : name;
  }

  async function add() {
    if (!source || submitting) return;
    submitting = true;
    error = null;
    const crumb = trail.at(-1);
    try {
      await onsubmit(crumb ? { directory_id: crumb.directoryId } : { source_id: source.source_id }, label());
      open = false;
    } catch (failure) {
      error = apiErrorMessage(failure);
    } finally {
      submitting = false;
    }
  }

  useOverlay(() => open, { id: "collect-library" });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-[min(640px,92vw)]" data-testid="collect-library-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.collect_library_title()}</Dialog.Title>
      <Dialog.Description>{m.collect_library_hint()}</Dialog.Description>
    </Dialog.Header>

    <nav class="flex min-h-6 flex-wrap items-center gap-1 text-xs text-fg2" aria-label={m.collect_library_path()}>
      <button type="button" class="hover:text-fg" onclick={reset}>{m.collect_library_sources()}</button>
      {#if source}
        <ChevronRightIcon class="size-3 text-fg3" />
        <button type="button" class="hover:text-fg" onclick={() => (trail = [])}>{source.display_name}</button>
        {#each trail as crumb, index (crumb.directoryId)}
          <ChevronRightIcon class="size-3 text-fg3" />
          <button type="button" class="hover:text-fg" onclick={() => (trail = trail.slice(0, index + 1))}>{crumb.name}</button>
        {/each}
      {/if}
    </nav>

    <div class="-mx-[18px] h-[300px] overflow-y-auto border-y border-line">
      {#if !source}
        {#if sources.isPending}
          <p class="px-[18px] py-3 text-xs text-fg3" role="status">{m.collect_library_loading()}</p>
        {:else if sources.isError}
          <p class="px-[18px] py-3 text-xs text-danger" role="alert">{apiErrorMessage(sources.error)}</p>
        {:else if (sources.data ?? []).length === 0}
          <p class="px-[18px] py-3 text-xs text-fg3">{m.collect_library_empty()}</p>
        {:else}
          <ul>
            {#each sources.data ?? [] as item (item.source_id)}
              <li>
                <button
                  type="button"
                  class="flex h-row w-full items-center gap-2.5 px-[18px] text-left text-sm hover:bg-bg2"
                  onclick={() => {
                    source = item;
                    trail = [];
                  }}
                >
                  <LibraryIcon class="size-3.5 text-fg3" />
                  <span class="min-w-0 flex-1 truncate">{item.display_name}</span>
                  <span class="text-2xs text-fg3 tabular-nums">{item.asset_count}</span>
                  <ChevronRightIcon class="size-3.5 text-fg3" />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else if directory.isPending && here !== null}
        <p class="px-[18px] py-3 text-xs text-fg3" role="status">{m.collect_library_loading()}</p>
      {:else if directory.isError}
        <p class="px-[18px] py-3 text-xs text-danger" role="alert">{apiErrorMessage(directory.error)}</p>
      {:else if children.length === 0}
        <p class="px-[18px] py-3 text-xs text-fg3">{m.collect_library_no_subdirectories()}</p>
      {:else}
        <ul>
          {#each children as child (child.directory_id)}
            <li>
              <button
                type="button"
                class="flex h-row w-full items-center gap-2.5 px-[18px] text-left text-sm hover:bg-bg2"
                onclick={() => (trail = [...trail, { directoryId: child.directory_id, name: child.name }])}
              >
                <FolderIcon class="size-3.5 text-fg3" />
                <span class="min-w-0 flex-1 truncate">{child.name}</span>
                <span class="text-2xs text-fg3 tabular-nums">{child.recursive_asset_count}</span>
                {#if child.direct_directory_count > 0}<ChevronRightIcon class="size-3.5 text-fg3" />{/if}
              </button>
            </li>
          {/each}
          {#if directory.hasNextPage}
            <li class="px-[18px] py-2">
              <Button variant="ghost" size="sm" disabled={directory.isFetchingNextPage} onclick={() => directory.fetchNextPage()}>
                {m.collect_library_more()}
              </Button>
            </li>
          {/if}
        </ul>
      {/if}
    </div>

    {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
    <Dialog.Footer>
      <span class="mr-auto truncate text-2xs text-fg3">{source ? label() : ""}</span>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="primary" disabled={!source || submitting} onclick={add}>
        {trail.length ? m.collect_library_add_directory() : m.collect_library_add_source()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
