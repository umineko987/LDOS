<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import SearchIcon from "@lucide/svelte/icons/search";
  import { createInfiniteQuery } from "@tanstack/svelte-query";
  import { untrack } from "svelte";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { datasetMembersQuery } from "#lib/api/queries/datasets.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 角色过滤的参考图：从数据集成员里挑几张能代表这个角色的。只列第一页（DOM 预算），用搜索缩小范围。
  let {
    open = $bindable(false),
    dataset,
    value,
    max,
    onsubmit,
  }: {
    open?: boolean;
    dataset: string;
    value: readonly string[];
    max: number;
    onsubmit: (ids: string[]) => void;
  } = $props();

  const api = useApi();

  let picked = $state.raw<string[]>([]);
  let search = $state("");
  let query = $state("");

  $effect.pre(() => {
    if (open)
      untrack(() => {
        picked = [...value];
        search = "";
        query = "";
      });
  });

  $effect(() => {
    const next = search.trim();
    const timer = setTimeout(() => (query = next), 250);
    return () => clearTimeout(timer);
  });

  const members = createInfiniteQuery(() => ({ ...datasetMembersQuery(api, dataset, { query }), enabled: open }));
  const items = $derived(members.data?.pages[0]?.items ?? []);
  const more = $derived((members.data?.pages[0]?.total ?? 0) > items.length);

  function toggle(assetId: string) {
    if (picked.includes(assetId)) picked = picked.filter((item) => item !== assetId);
    else if (picked.length < max) picked = [...picked, assetId];
  }

  function submit() {
    onsubmit(picked);
    open = false;
  }

  useOverlay(() => open, { id: "clean-references" });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-[min(760px,94vw)]" data-testid="clean-references-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.clean_references_title()}</Dialog.Title>
      <Dialog.Description>{m.clean_references_hint({ max })}</Dialog.Description>
    </Dialog.Header>

    <div class="relative">
      <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg3" />
      <Input bind:value={search} type="search" class="h-7 pl-7 text-xs" placeholder={m.clean_references_search()} aria-label={m.clean_references_search()} />
    </div>

    <div class="-mx-[18px] h-[360px] overflow-y-auto border-y border-line px-[18px] py-3">
      {#if members.isPending}
        <p class="text-xs text-fg3" role="status">{m.triage_loading()}</p>
      {:else if members.isError}
        <p class="text-xs text-danger" role="alert">{apiErrorMessage(members.error)}</p>
      {:else if items.length === 0}
        <p class="text-xs text-fg3">{m.clean_references_empty()}</p>
      {:else}
        <div class="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5">
          {#each items as member (member.asset_id)}
            {@const selected = picked.includes(member.asset_id)}
            <button
              type="button"
              class={cn(
                "relative aspect-square overflow-hidden rounded-md border transition-colors duration-(--t-color)",
                selected ? "border-(--gold-30) bg-gold-12" : "border-transparent bg-bg1 hover:border-line2",
              )}
              aria-pressed={selected}
              aria-label={member.name}
              title={member.name}
              data-testid="clean-reference"
              onclick={() => toggle(member.asset_id)}
            >
              <img src={api.resourceUrl(member.thumbnail_url)} alt="" loading="lazy" class="absolute inset-1 size-[calc(100%-8px)] rounded-[4px] object-cover" />
              {#if selected}
                <span class="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-gold text-gold-ink">
                  <CheckIcon class="size-3" />
                </span>
              {/if}
            </button>
          {/each}
        </div>
        {#if more}<p class="mt-3 text-2xs text-fg3">{m.clean_references_more()}</p>{/if}
      {/if}
    </div>

    <Dialog.Footer>
      <span class="mr-auto text-2xs text-fg3 tabular-nums">{m.clean_references_count({ count: picked.length, max })}</span>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="primary" onclick={submit} data-testid="clean-references-done">{m.clean_references_done()}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
