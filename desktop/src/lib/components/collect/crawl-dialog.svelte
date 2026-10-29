<script lang="ts">
  import SearchIcon from "@lucide/svelte/icons/search";
  import { createQuery } from "@tanstack/svelte-query";
  import { untrack } from "svelte";

  import { useApi } from "#lib/api/context.ts";
  import { isAbortError } from "#lib/api/errors.ts";
  import { createIdempotencyKey } from "#lib/api/ids.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import type { DatasetCrawlRequest } from "#lib/api/queries/datasets.ts";
  import {
    buildDatasetCrawl,
    DISCOVERY_MAX_SITES,
    discoverySitesQuery,
    searchDiscovery,
    type DiscoveryCandidate,
    type DiscoverySourceResult,
  } from "#lib/api/queries/discovery.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 在线采集：按关键词在几个站点上找候选地址，勾选后作为一个采集批次提交。
  // 批次完成后后端自动把它挂成这个数据集的一个来源。
  let {
    open = $bindable(false),
    onsubmit,
  }: {
    open?: boolean;
    /** 提交批次；幂等键在一次打开里只生成一次，重试时复用。 */
    onsubmit: (body: DatasetCrawlRequest, idempotencyKey: string) => Promise<void>;
  } = $props();

  const api = useApi();
  const sites = createQuery(() => ({ ...discoverySitesQuery(api), enabled: open }));

  let keyword = $state("");
  let chosenSites = $state<string[]>([]);
  let results = $state.raw<readonly DiscoverySourceResult[] | null>(null);
  let selected = $state.raw<ReadonlyMap<string, DiscoveryCandidate>>(new Map());
  let searching = $state(false);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let idempotencyKey = "";
  let controller: AbortController | null = null;

  const canSearch = $derived(keyword.trim().length > 0 && chosenSites.length > 0 && !searching);

  function reset() {
    keyword = "";
    chosenSites = (sites.data ?? []).slice(0, 1).map((site) => site.site);
    results = null;
    selected = new Map();
    error = null;
    idempotencyKey = createIdempotencyKey("dataset-crawl");
  }

  // 父组件直接改 open 时 bits-ui 不调 onOpenChange，所以在这里按 open 的变化重置。
  // 关闭时放弃还在跑的搜索。
  $effect.pre(() => {
    if (open) untrack(reset);
    else untrack(() => controller?.abort());
  });

  $effect(() => {
    // 站点列表晚于对话框打开到达时，默认勾第一个。
    if (open && sites.data && chosenSites.length === 0 && results === null) {
      chosenSites = sites.data.slice(0, 1).map((site) => site.site);
    }
  });

  function toggleSite(site: string) {
    if (chosenSites.includes(site)) chosenSites = chosenSites.filter((item) => item !== site);
    else if (chosenSites.length < DISCOVERY_MAX_SITES) chosenSites = [...chosenSites, site];
  }

  function toggleCandidate(candidate: DiscoveryCandidate) {
    const next = new Map(selected);
    if (next.has(candidate.key)) next.delete(candidate.key);
    else next.set(candidate.key, candidate);
    selected = next;
  }

  async function search(event: SubmitEvent) {
    event.preventDefault();
    if (!canSearch) return;
    controller?.abort();
    controller = new AbortController();
    searching = true;
    error = null;
    try {
      results = await searchDiscovery(api, { keyword, sites: chosenSites }, controller.signal);
      selected = new Map();
    } catch (failure) {
      if (!isAbortError(failure)) error = apiErrorMessage(failure);
    } finally {
      searching = false;
    }
  }

  async function submit() {
    const body = buildDatasetCrawl([...selected.values()]);
    if (!body || submitting) return;
    submitting = true;
    error = null;
    try {
      await onsubmit(body, idempotencyKey);
      open = false;
    } catch (failure) {
      error = apiErrorMessage(failure);
    } finally {
      submitting = false;
    }
  }

  useOverlay(() => open, { id: "collect-crawl" });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-[min(720px,94vw)]" data-testid="collect-crawl-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.collect_crawl_title()}</Dialog.Title>
      <Dialog.Description>{m.collect_crawl_hint()}</Dialog.Description>
    </Dialog.Header>

    <form class="flex flex-col gap-3" onsubmit={search}>
      <div class="flex gap-2">
        <Input bind:value={keyword} placeholder={m.collect_crawl_keyword()} aria-label={m.collect_crawl_keyword()} maxlength={200} />
        <Button type="submit" variant="default" disabled={!canSearch}><SearchIcon />{m.collect_crawl_search()}</Button>
      </div>
      <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label={m.collect_crawl_sites()}>
        {#if sites.isError}
          <span class="text-xs text-danger">{apiErrorMessage(sites.error)}</span>
        {/if}
        {#each sites.data ?? [] as site (site.site)}
          <button
            type="button"
            aria-pressed={chosenSites.includes(site.site)}
            class="h-6 rounded-full border border-line2 px-2.5 text-xs text-fg3 transition-colors hover:text-fg2 aria-pressed:border-line3 aria-pressed:bg-bg3 aria-pressed:text-fg"
            onclick={() => toggleSite(site.site)}
          >
            {site.site}
          </button>
        {/each}
        <span class="ml-auto text-2xs text-fg3">{m.collect_crawl_site_limit({ max: DISCOVERY_MAX_SITES })}</span>
      </div>
    </form>

    <div class="-mx-[18px] h-[300px] overflow-y-auto border-y border-line" aria-busy={searching || undefined}>
      {#if searching}
        <p class="px-[18px] py-3 text-xs text-fg3" role="status">{m.collect_crawl_searching()}</p>
      {:else if results === null}
        <p class="px-[18px] py-3 text-xs text-fg3">{m.collect_crawl_idle()}</p>
      {:else if results.every((source) => source.candidates.length === 0 && !source.error)}
        <p class="px-[18px] py-3 text-xs text-fg3">{m.collect_crawl_no_results()}</p>
      {:else}
        {#each results as source (source.site)}
          <section class="border-b border-line last:border-b-0">
            <h3 class="flex items-center gap-2 px-[18px] pt-2.5 pb-1 text-2xs font-medium text-fg3">
              {source.site}
              {#if source.needsAuth}<span class="text-warn">{m.collect_crawl_needs_auth()}</span>{/if}
              {#if source.error}<span class="font-normal text-danger">{source.error}</span>{/if}
            </h3>
            <ul>
              {#each source.candidates as candidate (candidate.key)}
                {@const checked = selected.has(candidate.key)}
                <li>
                  <label
                    class={cn(
                      "flex min-h-row cursor-pointer items-center gap-2.5 px-[18px] py-1 text-sm hover:bg-bg2",
                      checked && "bg-bg2",
                    )}
                  >
                    <Checkbox checked={checked} onCheckedChange={() => toggleCandidate(candidate)} />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate">{candidate.label}</span>
                      <span class="block truncate font-mono text-2xs text-fg3">{candidate.url}</span>
                    </span>
                    {#if candidate.addressType}<span class="text-2xs text-fg3">{candidate.addressType}</span>{/if}
                    {#if candidate.mediaCount !== null}
                      <span class="text-2xs text-fg3 tabular-nums">{m.collect_crawl_media({ count: candidate.mediaCount })}</span>
                    {/if}
                  </label>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}
    </div>

    {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
    <Dialog.Footer>
      <span class="mr-auto text-2xs text-fg3">{m.collect_crawl_note()}</span>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="primary" disabled={selected.size === 0 || submitting} onclick={submit}>
        {m.collect_crawl_submit({ count: selected.size })}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
