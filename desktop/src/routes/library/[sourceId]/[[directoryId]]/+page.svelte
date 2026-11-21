<script lang="ts">
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import ClipboardCheckIcon from "@lucide/svelte/icons/clipboard-check";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import SearchIcon from "@lucide/svelte/icons/search";
  import SquarePlusIcon from "@lucide/svelte/icons/square-plus";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import { createInfiniteQuery, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";

  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import type { DatasetRootCreate } from "#lib/api/queries/datasets.ts";
  import {
    assetContentPath,
    assetThumbnailPath,
    invalidateLibrary,
    libraryEntriesQuery,
    libraryKeys,
    libraryPathQuery,
    librarySearchQuery,
    librarySourceQuery,
    nextEntriesCursor,
    renameAsset,
    startScan,
    trashItems,
    undoOperation,
    type EntriesCursor,
    type LibraryAsset,
    type LibrarySearchScope,
  } from "#lib/api/queries/library.ts";
  import { GridSelection, ThumbCell, VirtualGrid } from "#lib/components/grid/index.ts";
  import AddToDatasetDialog from "#lib/components/library/add-to-dataset-dialog.svelte";
  import AnnotationPanel from "#lib/components/library/annotation-panel.svelte";
  import RenameDialog from "#lib/components/library/rename-dialog.svelte";
  import { useScans } from "#lib/components/library/scans.svelte.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { galleryStudioPath } from "#lib/components/studio/gallery-studio-state.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Kbd } from "#lib/components/ui/kbd/index.ts";
  import { Viewer, type ViewerItem } from "#lib/components/viewer/index.ts";
  import { crumbs, libraryPath } from "#lib/domain/library.ts";
  import { formatBytes } from "#lib/domain/models.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { useBindings, useEscape } from "#lib/keys/bindings.svelte.ts";
  import { parentPath } from "#lib/nav/routes.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 浏览一个来源：面包屑、子文件夹、图片网格（翻页）、搜索、查看器（含同名 TXT），
  // 改名、移到回收区（可撤销），以及把当前文件夹加入数据集（数据集只按文件夹引用）。
  const api = useApi();
  const client = useQueryClient();
  const scans = useScans();

  const sourceId = $derived(page.params.sourceId ?? "");
  const directoryParam = $derived(page.params.directoryId ?? null);

  const source = createQuery(() => librarySourceQuery(api, sourceId));
  const rootId = $derived(source.data?.root_directory_id ?? null);
  const directoryId = $derived(directoryParam ?? rootId);
  const atRoot = $derived(directoryId !== null && directoryId === rootId);

  let includeDescendants = $state(false);
  let search = $state("");
  let query = $state("");
  let scope = $state<LibrarySearchScope>("directory");
  let thumbSize = $state(128);
  let focus = $state(-1);
  let searchInput = $state<HTMLInputElement | null>(null);
  let gridHost = $state<HTMLDivElement | null>(null);
  const selection = new GridSelection();

  let viewerOpen = $state(false);
  let viewerIndex = $state(0);
  let addOpen = $state(false);
  let renameOpen = $state(false);
  let renaming = $state<LibraryAsset | null>(null);

  // 搜索框停顿 250ms 再查。
  $effect(() => {
    const next = search.trim();
    const timer = setTimeout(() => (query = next), 250);
    return () => clearTimeout(timer);
  });

  // 换了文件夹：清掉选择、焦点和搜索。
  $effect(() => {
    void directoryId;
    untrack(() => {
      selection.clear();
      focus = -1;
      search = "";
      query = "";
      viewerOpen = false;
    });
  });

  const searching = $derived(query.length > 0);
  const path = createQuery(() => ({ ...libraryPathQuery(api, directoryId ?? ""), enabled: directoryId !== null }));
  const entries = createInfiniteQuery(() => ({
    ...libraryEntriesQuery(api, directoryId ?? "", { includeDescendants }),
    enabled: directoryId !== null && !searching,
  }));
  const results = createInfiniteQuery(() => ({
    ...librarySearchQuery(api, { query, scope, sourceId, directoryId: directoryId ?? undefined }),
    enabled: directoryId !== null && searching,
  }));

  const active = $derived(searching ? results : entries);
  const assets = $derived<LibraryAsset[]>(active.data?.pages.flatMap((item) => item.assets) ?? []);
  const folders = $derived(searching ? [] : (entries.data?.pages.flatMap((item) => item.directories) ?? []));
  const here = $derived(entries.data?.pages[0]?.directory);
  // 子目录超过一页时：网格滚到底也会接着取，这里另给一个按钮。
  const moreFolders = $derived.by(() => {
    const data = entries.data;
    const last = data?.pages.at(-1);
    if (searching || !data || !last) return false;
    return typeof nextEntriesCursor(last, data.pageParams.at(-1) as EntriesCursor)?.directories === "string";
  });
  const order = $derived(assets.map((asset) => asset.asset_id));
  // 上级没取到之前不显示面包屑：否则当前目录会被当成根目录、显示成来源名。
  const trail = $derived(
    path.data ? crumbs(sourceId, source.data?.display_name ?? "", here ? [...path.data, here] : path.data) : [],
  );
  const label = $derived(trail.map((crumb) => crumb.label).join(" / ") || (source.data?.display_name ?? ""));
  const total = $derived(here ? (includeDescendants ? here.recursive_asset_count : here.direct_asset_count) : 0);
  const scanning = $derived(source.data ? source.data.availability === "scanning" || scans.running(sourceId) : false);

  const sizes = [
    { value: "96", label: m.library_size_small() },
    { value: "128", label: m.library_size_medium() },
    { value: "176", label: m.library_size_large() },
  ] as const;
  const scopes = $derived([
    { value: "directory" as const, label: m.library_scope_directory() },
    { value: "source" as const, label: m.library_scope_source() },
    { value: "library" as const, label: m.library_scope_library() },
  ]);
  const depths = $derived([
    { value: "direct" as const, label: m.library_depth_direct() },
    { value: "all" as const, label: m.library_depth_all() },
  ]);

  const thumb = (asset: LibraryAsset) => api.resourceUrl(assetThumbnailPath(asset.asset_id));
  const viewerItems = $derived<ViewerItem[]>(
    assets.map((asset) => ({
      id: asset.asset_id,
      name: asset.name,
      src: api.resourceUrl(assetContentPath(asset.asset_id)),
      thumb: thumb(asset),
      width: asset.width,
      height: asset.height,
      meta: [`${asset.width}×${asset.height}`, asset.format.toUpperCase(), formatBytes(asset.size_bytes, i18n.current)]
        .filter(Boolean)
        .join(" · "),
    })),
  );

  // 删到一张不剩时关掉查看器。
  $effect(() => {
    if (viewerOpen && assets.length === 0 && !active.isFetching) untrack(() => (viewerOpen = false));
  });

  // ---- 导航 ----

  /** 回到上一层文件夹；在来源根目录返回 false，交给外壳回到图库。 */
  function up(): boolean {
    const parent = trail.at(-2);
    if (!directoryParam || !parent) return false;
    void goto(`#${parent.path}`);
    return true;
  }

  useEscape("up", up);

  // ---- 文件操作 ----

  function dropAssets(ids: ReadonlySet<string>) {
    const strip = <P extends { assets: LibraryAsset[] }>(data: { pages: P[]; pageParams: unknown[] } | undefined) =>
      data && { ...data, pages: data.pages.map((item) => ({ ...item, assets: item.assets.filter((asset) => !ids.has(asset.asset_id)) })) };
    client.setQueriesData({ queryKey: [...libraryKeys.all, "entries"] }, strip);
    client.setQueriesData({ queryKey: libraryKeys.searchAll() }, strip);
  }

  async function undo(operationId: string) {
    try {
      const result = await undoOperation(api, operationId);
      toast.success(m.library_undone({ count: result.item_count }));
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      void invalidateLibrary(client);
    }
  }

  async function trash(ids: readonly string[]) {
    if (ids.length === 0) return;
    try {
      const operation = await trashItems(api, { asset_ids: [...ids] });
      selection.clear();
      dropAssets(new Set(ids));
      toast.success(m.library_trashed({ count: operation.item_count }), {
        duration: 10_000,
        action: { label: m.library_undo(), onClick: () => void undo(operation.operation_id) },
      });
    } catch (error) {
      toast.error(apiErrorMessage(error));
    } finally {
      void invalidateLibrary(client);
    }
  }

  function trashTargets() {
    void trash(selection.targets(order, focus));
  }

  function askRename(asset: LibraryAsset | undefined) {
    if (!asset) return;
    renaming = asset;
    renameOpen = true;
  }

  async function rename(asset: LibraryAsset, stem: string) {
    await renameAsset(api, asset.asset_id, stem);
    void invalidateLibrary(client);
    toast.success(m.library_renamed({ name: `${stem}${asset.extension}` }));
  }

  async function scan() {
    try {
      await startScan(api, sourceId);
      scans.started(sourceId);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  }

  // ---- 加入数据集 ----

  const datasetRoot = $derived<DatasetRootCreate | null>(
    directoryId === null ? null : atRoot ? { source_id: sourceId } : { directory_id: directoryId },
  );

  function added(datasetId: string, name: string) {
    toast.success(m.library_added({ folder: label, dataset: name }), {
      action: { label: m.library_added_open(), onClick: () => void goto(`#/datasets/${encodeURIComponent(datasetId)}/collect`) },
    });
  }

  // ---- 查看器 ----

  function openViewer(_asset: LibraryAsset, index: number) {
    viewerIndex = index;
    viewerOpen = true;
  }

  function originOf(_item: ViewerItem, index: number) {
    return gridHost?.querySelector<HTMLElement>(`[data-index="${index}"] img`) ?? null;
  }

  const group = m.keys_group_library;
  useBindings("page", () => [
    {
      id: "library.up",
      keys: "backspace",
      label: m.library_key_up,
      group,
      run: () => {
        if (up()) return;
        const parent = parentPath(page.route.id, page.params);
        if (parent === null) return false;
        void goto(`#${parent}`);
      },
    },
    { id: "library.search", keys: "/", label: m.library_key_search, group, run: () => searchInput?.focus() },
    {
      id: "library.trash-selected",
      keys: "delete",
      label: m.library_key_trash,
      group,
      when: () => assets.length > 0 && (selection.size > 0 || focus >= 0),
      run: trashTargets,
    },
    {
      id: "library.rename",
      keys: "f2",
      label: m.library_rename,
      group,
      when: () => focus >= 0 && focus < assets.length,
      run: () => askRename(assets[focus]),
    },
    {
      id: "library.add-to-dataset",
      label: m.library_add_to_dataset,
      group,
      palette: true,
      when: () => datasetRoot !== null,
      run: () => {
        addOpen = true;
      },
    },
    { id: "library.scan", label: m.library_rescan, group, palette: true, when: () => !scanning, run: () => void scan() },
  ]);
</script>

<PageHeader title={source.data?.display_name ?? m.nav_library()}>
  {#snippet actions()}
    <Button variant="ghost" size="sm" onclick={scan} disabled={scanning || !source.data} data-testid="library-scan">
      {#if scanning}<LoaderCircleIcon class="animate-spin" />{m.library_scanning()}{:else}<RefreshCwIcon />{m.library_rescan()}{/if}
    </Button>
    {#if source.data && directoryId}
      <Button variant="outline" size="sm" href={`#${galleryStudioPath(sourceId, atRoot ? null : directoryId)}`} data-testid="library-review-link">
        <ClipboardCheckIcon data-icon="inline-start" />{m.studio_gallery_review()}
      </Button>
    {/if}
    <Button variant="primary" size="sm" onclick={() => (addOpen = true)} disabled={datasetRoot === null} data-testid="library-add-to-dataset">
      <SquarePlusIcon />{m.library_add_to_dataset()}
    </Button>
  {/snippet}
  <nav class="mt-1.5 flex min-h-5 flex-wrap items-center gap-1 text-xs text-fg2" aria-label={m.library_breadcrumb()} data-testid="library-breadcrumb">
    <a class="hover:text-fg" href="#/library">{m.nav_library()}</a>
    {#each trail as crumb, index (crumb.directoryId)}
      <ChevronRightIcon class="size-3 text-fg3" />
      {#if index === trail.length - 1}
        <span class="text-fg" aria-current="page">{crumb.label}</span>
      {:else}
        <a class="hover:text-fg" href={`#${crumb.path}`}>{crumb.label}</a>
      {/if}
    {/each}
  </nav>
</PageHeader>

<div class="flex min-h-0 flex-1 flex-col" data-testid="library-browse" data-directory={directoryId}>
  {#if source.isError}
    <div class="flex items-center gap-3 px-7 py-4 text-sm text-danger" role="alert">
      {apiErrorMessage(source.error)}
      <Button variant="outline" size="sm" onclick={() => source.refetch()}>{m.common_retry()}</Button>
    </div>
  {:else}
    {#if source.data?.availability === "offline"}
      <p class="border-b border-line px-7 py-2 text-xs text-warn" role="status" data-testid="library-offline">
        {m.library_offline_banner()}
        <a class="ml-1 text-fg underline" href="#/library">{m.library_offline_relink()}</a>
      </p>
    {/if}

    <div class="flex h-11 flex-none items-center gap-3 border-b border-line px-7" data-testid="library-toolbar">
      {#if selection.size > 0}
        <span class="text-xs text-fg2" data-testid="library-selection">{m.library_selected({ count: selection.size })}</span>
        <Button variant="outline" size="sm" onclick={trashTargets} data-testid="library-trash-selected">
          <Trash2Icon />{m.library_trash_selected()} <Kbd>Del</Kbd>
        </Button>
        <Button variant="ghost" size="sm" onclick={() => selection.clear()}>{m.library_clear_selection()} <Kbd>Esc</Kbd></Button>
      {:else if searching}
        <span class="text-xs text-fg3" role="status">{m.library_search_results({ count: assets.length })}</span>
      {:else if here}
        <span class="text-xs text-fg3 tabular-nums" data-testid="library-count">{m.library_asset_count({ count: total })}</span>
      {/if}
      <div class="ml-auto flex items-center gap-3">
        {#if searching}
          <Segmented options={scopes} value={scope} onchange={(next) => (scope = next)} label={m.library_scope()} data-testid="library-scope" />
        {:else}
          <Segmented
            options={depths}
            value={includeDescendants ? "all" : "direct"}
            onchange={(next) => {
              includeDescendants = next === "all";
              focus = -1;
            }}
            label={m.library_depth()}
            data-testid="library-depth"
          />
        {/if}
        <div class="relative w-[200px]">
          <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg3" />
          <Input
            bind:ref={searchInput}
            bind:value={search}
            type="search"
            class="h-7 pl-7 text-xs"
            placeholder={m.library_search()}
            aria-label={m.library_search()}
            data-testid="library-search"
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
          label={m.library_size()}
        />
      </div>
    </div>

    {#if folders.length > 0}
      <ul class="flex max-h-[132px] flex-none flex-wrap gap-1.5 overflow-y-auto border-b border-line px-7 py-2.5" aria-label={m.library_folders()} data-testid="library-folders">
        {#each folders as folder (folder.directory_id)}
          <li>
            <a
              class="flex h-8 max-w-[260px] items-center gap-2 rounded-md border border-line bg-bg1 px-2.5 text-sm hover:bg-bg2"
              href={`#${libraryPath(sourceId, folder.directory_id, rootId)}`}
              data-folder={folder.directory_id}
            >
              <FolderIcon class="size-3.5 flex-none text-fg3" />
              <span class="min-w-0 truncate">{folder.name}</span>
              <span class="flex-none text-2xs text-fg3 tabular-nums">{folder.recursive_asset_count}</span>
            </a>
          </li>
        {/each}
        {#if moreFolders}
          <li>
            <Button variant="ghost" size="sm" disabled={entries.isFetchingNextPage} onclick={() => entries.fetchNextPage()}>
              {m.library_load_more()}
            </Button>
          </li>
        {/if}
      </ul>
    {/if}

    <div bind:this={gridHost} class="flex min-h-0 flex-1 flex-col">
      {#if active.isError}
        <div class="flex items-center gap-3 px-7 py-4 text-sm text-danger" role="alert">
          {apiErrorMessage(active.error)}
          <Button variant="outline" size="sm" onclick={() => active.refetch()}>{m.common_retry()}</Button>
        </div>
      {:else}
        <VirtualGrid
          items={assets}
          key={(asset) => asset.asset_id}
          label={m.library_assets()}
          itemLabel={(asset) => asset.name}
          {selection}
          bind:focus
          {thumbSize}
          hasMore={active.hasNextPage}
          loading={active.isFetchingNextPage}
          onendreached={() => void active.fetchNextPage()}
          onopen={openViewer}
          onpreview={openViewer}
        >
          {#snippet cell({ item })}
            <ThumbCell src={thumb(item)} alt={item.name} dimmed={item.lifecycle_state !== "active"} />
          {/snippet}
          {#snippet empty()}
            {#if source.isPending || active.isPending}
              <span role="status">{m.library_loading()}</span>
            {:else if searching}
              {m.library_no_match({ query })}
            {:else if folders.length > 0}
              {m.library_no_assets_here()}
            {:else}
              {m.library_no_assets()}
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
  hasMore={active.hasNextPage}
  onendreached={() => void active.fetchNextPage()}
  onclose={(index) => (focus = index)}
>
  {#snippet actions(item, index)}
    {@const asset = assets[index]}
    {#if asset && asset.asset_id === item.id}
      <Button variant="outline" size="sm" onclick={() => askRename(asset)} data-testid="viewer-rename">
        <PencilIcon />{m.library_rename()}
      </Button>
      <Button variant="outline" size="sm" onclick={() => void trash([asset.asset_id])} data-testid="viewer-trash">
        <Trash2Icon />{m.library_trash_selected()}
      </Button>
    {/if}
  {/snippet}
  {#snippet aside(item)}
    {#key item.id}<AnnotationPanel assetId={item.id} />{/key}
  {/snippet}
</Viewer>

<AddToDatasetDialog bind:open={addOpen} root={datasetRoot} {label} onadded={added} />
<RenameDialog bind:open={renameOpen} asset={renaming} onsubmit={rename} />
