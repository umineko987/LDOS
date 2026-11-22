<script lang="ts">
  import FolderPlusIcon from "@lucide/svelte/icons/folder-plus";
  import GlobeIcon from "@lucide/svelte/icons/globe";
  import HashIcon from "@lucide/svelte/icons/hash";
  import LibraryIcon from "@lucide/svelte/icons/library";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import SearchIcon from "@lucide/svelte/icons/search";
  import { createInfiniteQuery, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";

  import { goto } from "$app/navigation";
  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    addDatasetRoot,
    applyFunnel,
    datasetCrawlsQuery,
    datasetHashingQuery,
    datasetKeys,
    datasetMembersQuery,
    datasetRootsQuery,
    decideMembers,
    invalidateForDatasetEvent,
    removeDatasetRoot,
    startDatasetCrawl,
    startHashing,
    type DatasetCrawlRequest,
    type DatasetMember,
    type DatasetMemberPage,
    type DatasetRoot,
    type DatasetRootCreate,
    type MemberFilter,
  } from "#lib/api/queries/datasets.ts";
  import CrawlDialog from "#lib/components/collect/crawl-dialog.svelte";
  import LibraryPicker from "#lib/components/collect/library-picker.svelte";
  import PathDialog from "#lib/components/collect/path-dialog.svelte";
  import RootsBar from "#lib/components/collect/roots-bar.svelte";
  import { useDataset } from "#lib/components/dataset/context.ts";
  import { GridSelection, ThumbCell, VirtualGrid } from "#lib/components/grid/index.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { Viewer, type ViewerItem } from "#lib/components/viewer/index.ts";
  import { useBindings, useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { PlatformCapabilityError } from "#lib/platform/adapter.ts";
  import { usePlatform } from "#lib/platform/context.ts";

  // 采集段：把图片挂进数据集（本机文件夹、图库目录、在线采集），浏览成员并排除不要的。
  // 排除只记在采集段：后面各段的输入随之减少，轨道计数立即更新（决定接口返回新漏斗）。
  const api = useApi();
  const client = useQueryClient();
  const platform = usePlatform();
  const dataset = useDataset();
  const id = $derived(dataset.id);

  type Filter = "all" | "kept" | "excluded";
  let filter = $state<Filter>("all");
  let search = $state("");
  let query = $state("");
  let thumbSize = $state(128);
  let focus = $state(-1);
  let searchInput = $state<HTMLInputElement | null>(null);
  let gridHost = $state<HTMLDivElement | null>(null);
  const selection = new GridSelection();

  let pathOpen = $state(false);
  let libraryOpen = $state(false);
  let crawlOpen = $state(false);
  let removing = $state<DatasetRoot | null>(null);
  let viewerOpen = $state(false);
  let viewerIndex = $state(0);

  // 搜索框停顿 250ms 再查。
  $effect(() => {
    const next = search.trim();
    const timer = setTimeout(() => (query = next), 250);
    return () => clearTimeout(timer);
  });

  const memberFilter = $derived<MemberFilter>({
    stage: "collect",
    decision: filter === "kept" ? "kept" : filter === "excluded" ? "excluded" : undefined,
    query,
  });

  const roots = createQuery(() => datasetRootsQuery(api, id));
  const crawls = createQuery(() => datasetCrawlsQuery(api, id));
  // 哈希进度靠 dataset.updated（reason=hashing）刷新，见 datasetInvalidation。
  const hashing = createQuery(() => datasetHashingQuery(api, id));
  const members = createInfiniteQuery(() => datasetMembersQuery(api, id, memberFilter));

  const items = $derived(members.data?.pages.flatMap((page) => page.items) ?? []);
  const total = $derived(members.data?.pages[0]?.total ?? 0);
  const order = $derived(items.map((member) => member.asset_id));
  const collect = $derived(dataset.stage("collect"));
  const rootList = $derived(roots.data ?? []);
  const hasSources = $derived(rootList.length > 0 || (crawls.data ?? []).some((crawl) => crawl.state !== "attached"));

  const isExcluded = (member: DatasetMember) =>
    member.decisions.some((decision) => decision.stage === "collect" && decision.decision === "exclude");

  const filters = $derived([
    { value: "all" as const, label: m.collect_filter_all({ count: collect?.input ?? 0 }) },
    { value: "kept" as const, label: m.collect_filter_kept({ count: collect?.output ?? 0 }) },
    { value: "excluded" as const, label: m.collect_filter_excluded({ count: collect?.removed ?? 0 }) },
  ]);
  const sizes = [
    { value: "96", label: m.collect_size_small() },
    { value: "128", label: m.collect_size_medium() },
    { value: "176", label: m.collect_size_large() },
  ] as const;

  const thumb = (member: DatasetMember) => api.resourceUrl(member.thumbnail_url);
  const viewerItems = $derived<ViewerItem[]>(
    items.map((member) => ({
      id: member.asset_id,
      name: member.name,
      src: api.resourceUrl(`/api/v1/gallery/assets/${encodeURIComponent(member.asset_id)}/content`),
      thumb: thumb(member),
      width: member.width,
      height: member.height,
      meta: `${member.width}×${member.height} · ${member.format.toUpperCase()}`,
    })),
  );

  // ---- 来源 ----

  function refreshSources() {
    invalidateForDatasetEvent(client, "dataset.updated", { dataset_id: id, reason: "roots" });
  }

  async function addRoot(body: DatasetRootCreate, label: string) {
    await addDatasetRoot(api, id, body);
    refreshSources();
    toast.success(m.collect_root_added({ name: label }));
  }

  async function pickFolder() {
    if (!platform.capabilities.selectDirectory) {
      pathOpen = true;
      return;
    }
    let path: string | null;
    try {
      path = await platform.selectDirectory("gallery_import");
    } catch (error) {
      if (error instanceof PlatformCapabilityError) pathOpen = true;
      else toast.error(apiErrorMessage(error));
      return;
    }
    if (!path) return;
    try {
      await addRoot({ path }, path);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  }

  async function confirmRemove() {
    const root = removing;
    if (!root) return;
    try {
      await removeDatasetRoot(api, id, root.root_id);
      removing = null;
      refreshSources();
      toast.success(m.collect_root_removed({ name: root.name || root.source_display_name }));
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  }

  async function submitCrawl(body: DatasetCrawlRequest, idempotencyKey: string) {
    const crawl = await startDatasetCrawl(api, id, body, idempotencyKey);
    void client.invalidateQueries({ queryKey: datasetKeys.crawls(id) });
    toast.success(m.collect_crawl_started(), {
      action: { label: m.collect_crawl_view(), onClick: () => void goto(`#/jobs/crawls/${encodeURIComponent(crawl.batch_id)}`) },
    });
  }

  async function hash() {
    try {
      client.setQueryData(datasetKeys.hashing(id), await startHashing(api, id));
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  }

  // ---- 排除 / 恢复 ----

  const DECISION_BATCH = 5000;

  function patchMembers(ids: ReadonlySet<string>, exclude: boolean) {
    client.setQueriesData<{ pages: DatasetMemberPage[]; pageParams: unknown[] }>(
      { queryKey: datasetKeys.membersAll(id) },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((member) =>
              ids.has(member.asset_id)
                ? {
                    ...member,
                    decisions: [
                      ...member.decisions.filter((decision) => decision.stage !== "collect"),
                      ...(exclude ? [{ stage: "collect" as const, decision: "exclude" as const, reason: "" }] : []),
                    ],
                  }
                : member,
            ),
          })),
        },
    );
  }

  async function decide(ids: readonly string[], exclude: boolean) {
    if (ids.length === 0) return;
    patchMembers(new Set(ids), exclude);
    try {
      for (let start = 0; start < ids.length; start += DECISION_BATCH) {
        const result = await decideMembers(api, id, {
          stage: "collect",
          asset_ids: ids.slice(start, start + DECISION_BATCH),
          decision: exclude ? "exclude" : "clear",
          reason: "",
        });
        applyFunnel(client, result.funnel);
      }
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      void client.invalidateQueries({ queryKey: datasetKeys.membersAll(id) });
      void client.invalidateQueries({ queryKey: datasetKeys.list() });
    }
  }

  /** X / Delete：目标全部已排除时恢复，否则排除。 */
  function toggleExclusion() {
    const targets = selection.targets(order, focus);
    if (targets.length === 0) return;
    const byId = new Map(items.map((member) => [member.asset_id, member]));
    const allExcluded = targets.every((target) => {
      const member = byId.get(target);
      return member !== undefined && isExcluded(member);
    });
    void decide(targets, !allExcluded);
  }

  function selectionExcluded(exclude: boolean) {
    const byId = new Map(items.map((member) => [member.asset_id, member]));
    const targets = selection.targets(order, focus).filter((target) => {
      const member = byId.get(target);
      return member !== undefined && isExcluded(member) !== exclude;
    });
    void decide(targets, exclude);
  }

  // ---- 查看器 ----

  function preview(_member: DatasetMember, index: number) {
    viewerIndex = index;
    viewerOpen = true;
  }

  function originOf(_item: ViewerItem, index: number) {
    return gridHost?.querySelector<HTMLElement>(`[data-index="${index}"] img`) ?? null;
  }

  const group = m.keys_group_collect;
  useBindings("page", () => [
    {
      id: "collect.toggle-exclude",
      keys: ["x", "delete"],
      label: m.collect_key_exclude,
      group,
      when: () => items.length > 0 && (selection.size > 0 || focus >= 0),
      run: toggleExclusion,
    },
    {
      id: "collect.search",
      keys: "/",
      label: m.collect_key_search,
      group,
      run: () => searchInput?.focus(),
    },
    { id: "collect.folder", label: m.collect_add_folder, group, palette: true, run: () => void pickFolder() },
    {
      id: "collect.library",
      label: m.collect_add_library,
      group,
      palette: true,
      run: () => {
        libraryOpen = true;
      },
    },
    {
      id: "collect.crawl",
      label: m.collect_add_crawl,
      group,
      palette: true,
      run: () => {
        crawlOpen = true;
      },
    },
  ]);

  useOverlay(() => removing !== null, { id: "collect-remove-root" });
</script>

{#snippet addButtons(size: "sm" | "default")}
  <Button variant="outline" {size} onclick={pickFolder} data-testid="collect-add-folder">
    <FolderPlusIcon />{m.collect_add_folder()}
  </Button>
  <Button variant="outline" {size} onclick={() => (libraryOpen = true)} data-testid="collect-add-library">
    <LibraryIcon />{m.collect_add_library()}
  </Button>
  <Button variant="outline" {size} onclick={() => (crawlOpen = true)} data-testid="collect-add-crawl">
    <GlobeIcon />{m.collect_add_crawl()}
  </Button>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col" data-testid="collect">
  {#if roots.isSuccess && !hasSources}
    <div class="flex flex-1 flex-col items-start justify-center gap-3 px-7" data-testid="collect-empty">
      <h2 class="text-base font-medium">{m.collect_empty_title()}</h2>
      <p class="max-w-[520px] text-sm text-fg2">{m.collect_empty_hint()}</p>
      <div class="flex gap-2">{@render addButtons("default")}</div>
    </div>
  {:else}
    <div class="flex items-start gap-3 border-b border-line px-7 py-2.5">
      <div class="min-w-0 flex-1">
        {#if roots.isError}
          <p class="text-xs text-danger" role="alert">{apiErrorMessage(roots.error)}</p>
        {:else}
          <RootsBar roots={rootList} crawls={crawls.data ?? []} onremove={(root) => (removing = root)} />
        {/if}
      </div>
      <div class="flex flex-none gap-1.5">{@render addButtons("sm")}</div>
    </div>

    <div class="flex h-11 flex-none items-center gap-3 border-b border-line px-7" data-testid="collect-toolbar">
      <Segmented
        options={filters}
        value={filter}
        onchange={(next) => {
          filter = next;
          focus = -1;
        }}
        label={m.collect_filter()}
        size="sm"
        data-testid="collect-filter"
      />
      {#if selection.size > 0}
        <span class="text-xs text-fg2" data-testid="collect-selection">{m.collect_selected({ count: selection.size })}</span>
        <Button variant="outline" size="sm" onclick={() => selectionExcluded(true)}>
          {m.collect_exclude()} <Kbd>X</Kbd>
        </Button>
        <Button variant="outline" size="sm" onclick={() => selectionExcluded(false)}>{m.collect_restore()}</Button>
        <Button variant="ghost" size="sm" onclick={() => selection.clear()}>{m.collect_clear_selection()} <Kbd>Esc</Kbd></Button>
      {/if}
      <div class="ml-auto flex items-center gap-3">
        {#if hashing.data && (hashing.data.pending > 0 || hashing.data.hashed_count < hashing.data.member_count)}
          {@const status = hashing.data}
          <span class="flex items-center gap-1.5 text-2xs text-fg3" data-testid="collect-hashing">
            {#if status.pending > 0}
              <LoaderCircleIcon class="size-3 animate-spin" />
              {m.collect_hashing_running({ done: status.hashed_count, total: status.member_count })}
            {:else if status.hashed_count < status.member_count}
              <HashIcon class="size-3" />
              {m.collect_hashing_partial({ done: status.hashed_count, total: status.member_count })}
              <Button variant="ghost" size="xs" onclick={hash}>{m.collect_hashing_start()}</Button>
            {/if}
          </span>
        {/if}
        <div class="relative w-[200px]">
          <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg3" />
          <Input
            bind:ref={searchInput}
            bind:value={search}
            type="search"
            class="h-7 pl-7 text-xs"
            placeholder={m.collect_search()}
            aria-label={m.collect_search()}
            onkeydown={(event) => {
              if (event.key === "Escape" && search) {
                event.stopPropagation();
                search = "";
              }
            }}
          />
        </div>
        <Segmented
          options={sizes}
          value={String(thumbSize) as "96" | "128" | "176"}
          onchange={(next) => (thumbSize = Number(next))}
          label={m.collect_size()}
        />
      </div>
    </div>

    <div bind:this={gridHost} class="flex min-h-0 flex-1 flex-col">
      {#if members.isError}
        <div class="flex items-center gap-3 px-7 py-4 text-sm text-danger" role="alert">
          {apiErrorMessage(members.error)}
          <Button variant="outline" size="sm" onclick={() => members.refetch()}>{m.common_retry()}</Button>
        </div>
      {:else}
        <VirtualGrid
          {items}
          key={(member) => member.asset_id}
          label={m.collect_members({ count: total })}
          itemLabel={(member) => (isExcluded(member) ? m.collect_member_excluded({ name: member.name }) : member.name)}
          {selection}
          bind:focus
          {thumbSize}
          hasMore={members.hasNextPage}
          loading={members.isFetchingNextPage}
          onendreached={() => void members.fetchNextPage()}
          onpreview={preview}
        >
          {#snippet cell({ item })}
            {@const excluded = isExcluded(item)}
            <ThumbCell
              src={thumb(item)}
              alt={item.name}
              dimmed={excluded}
              stamp={excluded ? m.collect_stamp_excluded() : undefined}
            />
          {/snippet}
          {#snippet empty()}
            {#if members.isPending}
              <span role="status">{m.collect_loading()}</span>
            {:else if query}
              {m.collect_no_match({ query })}
            {:else if filter === "excluded"}
              {m.collect_none_excluded()}
            {:else}
              {m.collect_no_members()}
            {/if}
          {/snippet}
        </VirtualGrid>
      {/if}
    </div>
  {/if}
</div>

<Viewer
  items={viewerItems}
  bind:index={viewerIndex}
  bind:open={viewerOpen}
  origin={originOf}
  hasMore={members.hasNextPage}
  onendreached={() => void members.fetchNextPage()}
  onclose={(index) => (focus = index)}
>
  {#snippet actions(item, index)}
    {@const member = items[index]}
    {#if member && member.asset_id === item.id}
      <Button variant="outline" size="sm" onclick={() => void decide([member.asset_id], !isExcluded(member))}>
        {isExcluded(member) ? m.collect_restore() : m.collect_exclude()}
      </Button>
    {/if}
  {/snippet}
</Viewer>

<PathDialog bind:open={pathOpen} onsubmit={(path) => addRoot({ path }, path)} />
<LibraryPicker bind:open={libraryOpen} onsubmit={addRoot} />
<CrawlDialog bind:open={crawlOpen} onsubmit={submitCrawl} />

<Dialog.Root
  open={removing !== null}
  onOpenChange={(next) => {
    if (!next) removing = null;
  }}
>
  <Dialog.Content data-testid="collect-remove-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.collect_remove_title({ name: removing?.name || removing?.source_display_name || "" })}</Dialog.Title>
      <Dialog.Description>{m.collect_remove_hint({ count: removing?.recursive_asset_count ?? 0 })}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="destructive" onclick={confirmRemove}>{m.collect_remove_confirm()}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
