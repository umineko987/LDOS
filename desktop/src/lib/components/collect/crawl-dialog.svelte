<script lang="ts">
  import SearchIcon from "@lucide/svelte/icons/search";
  import { createQuery } from "@tanstack/svelte-query";
  import { untrack } from "svelte";

  import { useApi } from "#lib/api/context.ts";
  import { isAbortError } from "#lib/api/errors.ts";
  import { createDanbooruRequestScope } from "#lib/api/queries/danbooru.ts";
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
  import { workbenchAddress, WORKBENCH_SUBMIT_LIMIT, type WorkbenchAddress } from "#lib/api/queries/workbench.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Textarea } from "#lib/components/ui/textarea/index.ts";
  import { useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  // 在线采集：按关键词在几个站点上找候选地址，勾选后作为一个采集批次提交。
  // 批次完成后后端自动把它挂成这个数据集的一个来源。
  let {
    open = $bindable(false),
    initialMode = "search",
    onsubmit,
    onpreview,
  }: {
    open?: boolean;
    initialMode?: "search" | "address";
    onsubmit: (body: DatasetCrawlRequest, idempotencyKey: string) => Promise<void>;
    onpreview: (address: WorkbenchAddress) => void;
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
  let attempt: { body: string; key: string } | null = null;
  const requests = createDanbooruRequestScope();
  const uid = $props.id();
  let mode = $state<"search" | "address">("search");
  let addresses = $state("");
  let addressSite = $state("pawchive");
  const legacySites = ["pawchive", "danbooru", "pixiv", "twitter", "exhentai"];
  const modes = $derived([
    { value: "search" as const, label: m.collect_workbench_find_sources() },
    { value: "address" as const, label: m.collect_workbench_address_mode() },
  ]);
  const addressLines = $derived([...new Set(addresses.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]);
  const submittedCount = $derived(mode === "address" ? addressLines.length : selected.size);

  const canSearch = $derived(keyword.trim().length > 0 && chosenSites.length > 0 && !searching);

  function reset() {
    keyword = "";
    chosenSites = (sites.data ?? []).slice(0, 1).map((site) => site.site);
    results = null;
    selected = new Map();
    error = null;
    mode = initialMode;
    addresses = "";
    addressSite = "pawchive";
    attempt = null;
    searching = false;
  }

  // 父组件直接改 open 时 bits-ui 不调 onOpenChange，所以在这里按 open 的变化重置。
  // 关闭时放弃还在跑的搜索。
  $effect.pre(() => {
    if (open) untrack(reset);
    return requests.cancel;
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
    const request = requests.begin();
    searching = true;
    error = null;
    try {
      const response = await searchDiscovery(api, { keyword, sites: chosenSites }, request.signal);
      if (!request.isCurrent()) return;
      results = response;
      selected = new Map();
    } catch (failure) {
      if (request.isCurrent() && !isAbortError(failure)) error = apiErrorMessage(failure);
    } finally {
      if (request.isCurrent()) searching = false;
    }
  }

  function changeMode(next: "search" | "address") {
    if (submitting || mode === next) return;
    requests.cancel();
    searching = false;
    error = null;
    mode = next;
  }

  function preview(address: WorkbenchAddress) {
    open = false;
    onpreview(address);
  }

  function addressCandidates(): DiscoveryCandidate[] | null {
    if (addressLines.length > WORKBENCH_SUBMIT_LIMIT) {
      error = m.collect_workbench_submit_limit({ max: WORKBENCH_SUBMIT_LIMIT });
      return null;
    }
    const candidates: DiscoveryCandidate[] = [];
    for (const [index, address] of addressLines.entries()) {
      try {
        const url = new URL(address);
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || address.length > 8192) throw new TypeError();
        candidates.push({ key: url.href, site: addressSite, url: url.href, id: null, label: url.href, addressType: null, mediaCount: null, confidence: null });
      } catch {
        error = m.collect_workbench_address_invalid({ line: index + 1 });
        return null;
      }
    }
    return candidates;
  }

  async function submit() {
    if (submitting) return;
    const candidates = mode === "address" ? addressCandidates() : [...selected.values()];
    const body = candidates && buildDatasetCrawl(candidates);
    if (!body) return;
    const serialized = JSON.stringify(body);
    if (attempt?.body !== serialized) attempt = { body: serialized, key: createIdempotencyKey("dataset-crawl") };
    submitting = true;
    error = null;
    try {
      await onsubmit(body, attempt.key);
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
  <Dialog.Content class="top-[5dvh] max-h-[90dvh] w-[min(720px,94vw)] overflow-y-auto" data-testid="collect-crawl-dialog"
    showCloseButton={false} interactOutsideBehavior="ignore" onEscapeKeydown={(event) => { if (submitting) event.preventDefault(); }}>
    <Dialog.Header>
      <Dialog.Title>{mode === "search" ? m.collect_workbench_find_sources() : m.collect_workbench_address_mode()}</Dialog.Title>
      <Dialog.Description>{mode === "search" ? m.collect_crawl_hint() : m.collect_workbench_address_hint()}</Dialog.Description>
    </Dialog.Header>

    <Segmented options={modes} value={mode} onchange={changeMode} label={m.collect_workbench_legacy_modes()} size="sm" class="w-fit" />
    {#if mode === "search"}
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
                {@const address = workbenchAddress(candidate)}
                <li class="flex items-center gap-2 pr-2">
                  <label
                    class={cn(
                      "flex min-h-row min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-[18px] py-1 text-sm hover:bg-bg2",
                      checked && "bg-bg2",
                    )}
                  >
                    <Checkbox checked={checked} disabled={submitting} onCheckedChange={() => toggleCandidate(candidate)} />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate">{candidate.label}</span>
                      <span class="block truncate font-mono text-2xs text-fg3">{candidate.url}</span>
                    </span>
                    {#if candidate.addressType}<span class="text-2xs text-fg3">{candidate.addressType}</span>{/if}
                    {#if candidate.mediaCount !== null}
                      <span class="text-2xs text-fg3 tabular-nums">{m.collect_crawl_media({ count: candidate.mediaCount })}</span>
                    {/if}
                  </label>
                  {#if address}
                    <Button size="sm" variant="outline" disabled={submitting} aria-label={m.collect_workbench_preview_candidate({ title: candidate.label })} onclick={() => preview(address)}>{m.collect_workbench_preview()}</Button>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}
    </div>
    {:else}
      <div class="flex flex-col gap-3">
        <label for="{uid}-site" class="flex flex-col gap-1 text-xs text-fg2">{m.collect_crawl_sites()}
          <select id="{uid}-site" bind:value={addressSite} disabled={submitting} class="h-control w-fit rounded-md border border-input bg-bg1 px-2 text-fg focus-visible:ring-2 focus-visible:ring-ring">
            {#each legacySites as site (site)}
              <option value={site}>{site === "pawchive" ? "Pawchive" : site === "danbooru" ? "Danbooru" : site === "pixiv" ? "Pixiv" : site === "exhentai" ? "EH" : m.collect_workbench_source_x()}</option>
            {/each}
          </select>
        </label>
        <label for="{uid}-urls" class="flex flex-col gap-1 text-xs text-fg2">{m.collect_workbench_addresses()}
          <Textarea id="{uid}-urls" rows={6} placeholder="https://" bind:value={addresses} disabled={submitting} />
        </label>
      </div>
    {/if}
    {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
    <Dialog.Footer>
      <span class="mr-auto text-2xs text-fg3">{m.collect_crawl_note()}</span>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" disabled={submitting} {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="primary" disabled={submittedCount === 0 || submitting || searching} onclick={submit}>
        {m.collect_crawl_submit({ count: submittedCount })}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
