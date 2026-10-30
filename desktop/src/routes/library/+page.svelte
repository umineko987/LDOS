<script lang="ts">
  import FolderPlusIcon from "@lucide/svelte/icons/folder-plus";
  import LinkIcon from "@lucide/svelte/icons/link";
  import LoaderCircleIcon from "@lucide/svelte/icons/loader-circle";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import XIcon from "@lucide/svelte/icons/x";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    importSource,
    invalidateLibrary,
    librarySourcesQuery,
    relinkSource,
    removeSource,
    startScan,
    type LibrarySource,
  } from "#lib/api/queries/library.ts";
  import { useScans } from "#lib/components/library/scans.svelte.ts";
  import SourcePathDialog from "#lib/components/library/source-path-dialog.svelte";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import StatusDot from "#lib/components/status-dot.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Label } from "#lib/components/ui/label/index.ts";
  import { Progress } from "#lib/components/ui/progress/index.ts";
  import { formatAgo } from "#lib/domain/elapsed.ts";
  import { libraryPath, SOURCE_DOT, sourceState, type SourceAvailability } from "#lib/domain/library.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { useBindings, useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { PlatformCapabilityError } from "#lib/platform/adapter.ts";
  import { usePlatform } from "#lib/platform/context.ts";

  // 图库：已导入的本机文件夹和采集批次。可以扫描、重新关联离线的来源、移出图库；点名字进去浏览。
  const api = useApi();
  const client = useQueryClient();
  const platform = usePlatform();
  const scans = useScans();

  const sources = createQuery(() => librarySourcesQuery(api));
  const list = $derived(sources.data ?? []);

  let importOpen = $state(false);
  let relinkOpen = $state(false);
  let relinking = $state<LibrarySource | null>(null);
  let removing = $state<LibrarySource | null>(null);
  let deleteFiles = $state(false);

  let now = $state(Date.now() / 1000);
  onMount(() => {
    const timer = setInterval(() => (now = Date.now() / 1000), 30_000);
    return () => clearInterval(timer);
  });

  const STATES: Record<SourceAvailability, () => string> = {
    available: m.library_state_available,
    offline: m.library_state_offline,
    conflict: m.library_state_conflict,
    scanning: m.library_state_scanning,
    error: m.library_state_error,
  };

  function stateOf(source: LibrarySource): SourceAvailability {
    return sourceState(source.availability, scans.running(source.source_id));
  }

  function lastScan(source: LibrarySource): string {
    if (!source.last_scanned_at) return m.library_never_scanned();
    return m.library_last_scan({ ago: formatAgo(now - source.last_scanned_at, i18n.current, m.jobs_just_now()) });
  }

  // ---- 添加 ----

  async function addFolder(path: string, displayName: string | null) {
    const source = await importSource(api, { root_path: path, display_name: displayName });
    // 导入后后端自动开始扫描。
    scans.started(source.source_id);
    void invalidateLibrary(client);
    toast.success(m.library_imported({ name: source.display_name }));
  }

  async function pickFolder() {
    if (!platform.capabilities.selectDirectory) {
      importOpen = true;
      return;
    }
    let path: string | null;
    try {
      path = await platform.selectDirectory("gallery_import");
    } catch (error) {
      if (error instanceof PlatformCapabilityError) importOpen = true;
      else toast.error(apiErrorMessage(error));
      return;
    }
    if (!path) return;
    try {
      await addFolder(path, null);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  }

  // ---- 扫描 / 重新关联 / 移出 ----

  async function scan(source: LibrarySource) {
    try {
      await startScan(api, source.source_id);
      scans.started(source.source_id);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  }

  async function relinkTo(source: LibrarySource, path: string) {
    await relinkSource(api, source.source_id, path);
    scans.started(source.source_id);
    void invalidateLibrary(client);
    toast.success(m.library_relinked({ name: source.display_name }));
  }

  async function relink(source: LibrarySource) {
    relinking = source;
    if (!platform.capabilities.selectDirectory) {
      relinkOpen = true;
      return;
    }
    let path: string | null;
    try {
      path = await platform.selectDirectory("gallery_relink");
    } catch (error) {
      if (error instanceof PlatformCapabilityError) relinkOpen = true;
      else toast.error(apiErrorMessage(error));
      return;
    }
    if (!path) return;
    try {
      await relinkTo(source, path);
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  }

  function askRemove(source: LibrarySource) {
    deleteFiles = false;
    removing = source;
  }

  async function confirmRemove() {
    const source = removing;
    if (!source) return;
    try {
      await removeSource(api, source.source_id, source.kind === "crawl_batch" && deleteFiles);
      removing = null;
      void invalidateLibrary(client);
      toast.success(m.library_removed({ name: source.display_name }));
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  }

  const group = m.keys_group_library;
  useBindings("page", () => [
    { id: "library.add", label: m.library_add_folder, group, palette: true, run: () => void pickFolder() },
    { id: "library.trash", label: m.library_trash, group, palette: true, run: () => void goto("#/library/trash") },
  ]);

  useOverlay(() => removing !== null, { id: "library-remove" });
</script>

<PageHeader title={m.nav_library()} subtitle={sources.isSuccess ? m.library_source_count({ count: list.length }) : undefined}>
  {#snippet actions()}
    <Button variant="ghost" size="sm" href={resolve("/library/trash")} data-testid="library-trash-link">
      <Trash2Icon />{m.library_trash()}
    </Button>
    <Button variant="primary" size="sm" onclick={pickFolder} data-testid="library-add">
      <FolderPlusIcon />{m.library_add_folder()}
    </Button>
  {/snippet}
</PageHeader>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="library">
  {#if sources.isPending}
    <p class="px-7 py-4 text-sm text-fg3" role="status">{m.library_loading()}</p>
  {:else if sources.isError}
    <div class="flex items-center gap-3 px-7 py-4 text-sm text-danger" role="alert">
      {apiErrorMessage(sources.error)}
      <Button variant="outline" size="sm" onclick={() => sources.refetch()}>{m.common_retry()}</Button>
    </div>
  {:else if list.length === 0}
    <div class="flex flex-1 flex-col items-start justify-center gap-3 px-7" data-testid="library-empty">
      <h2 class="text-base font-medium">{m.library_empty_title()}</h2>
      <p class="max-w-[520px] text-sm text-fg2">{m.library_empty_hint()}</p>
      <Button variant="outline" onclick={pickFolder}><FolderPlusIcon />{m.library_add_folder()}</Button>
    </div>
  {:else}
    <ul class="flex flex-col" aria-label={m.library_sources()} data-testid="library-sources">
      {#each list as source (source.source_id)}
        {@const state = stateOf(source)}
        {@const job = scans.job(source.source_id)}
        <li
          class="grid min-h-row grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-line px-7 py-2"
          data-source={source.source_id}
          data-state={state}
        >
          <div class="flex min-w-0 flex-col gap-0.5">
            <div class="flex min-w-0 items-center gap-2">
              <StatusDot status={SOURCE_DOT[state]} />
              <a
                class="min-w-0 truncate text-sm font-medium text-fg hover:underline"
                href={`#${libraryPath(source.source_id)}`}
                data-testid="library-source-link"
              >
                {source.display_name}
              </a>
              {#if source.kind === "crawl_batch"}<span class="flex-none text-2xs text-fg3">{m.library_kind_crawl()}</span>{/if}
            </div>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-3.5 text-2xs text-fg3">
              <span data-testid="library-source-state">{STATES[state]()}</span>
              <span class="tabular-nums" data-testid="library-source-count">{m.library_asset_count({ count: source.asset_count })}</span>
              {#if state === "scanning"}
                <!-- 遍历文件夹时只有已读张数；开始写索引时才有总数，这时才画进度条。 -->
                <span class="flex items-center gap-1 text-fg2" role="status" data-testid="library-scan-progress">
                  <LoaderCircleIcon class="size-3 animate-spin" />
                  {#if job?.total}
                    {m.library_scan_progress({ done: job.current ?? 0, total: job.total })}
                  {:else if job?.current}
                    {m.library_scan_read({ count: job.current })}
                  {:else}
                    {job?.message || m.library_scanning()}
                  {/if}
                </span>
                {#if job?.total}
                  <Progress
                    class="w-24"
                    value={Math.min(job.current ?? 0, job.total)}
                    max={job.total}
                    data-testid="library-scan-bar"
                  />
                {/if}
              {:else}
                <span>{lastScan(source)}</span>
              {/if}
            </div>
          </div>
          <div class="flex items-center gap-1">
            {#if source.availability === "offline"}
              <Button variant="outline" size="xs" onclick={() => relink(source)} data-testid="library-relink">
                <LinkIcon />{m.library_relink()}
              </Button>
            {/if}
            <Button
              variant="ghost"
              size="xs"
              onclick={() => scan(source)}
              disabled={state === "scanning"}
              data-testid="library-scan"
            >
              <RefreshCwIcon />{source.last_scanned_at ? m.library_rescan() : m.library_scan()}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onclick={() => askRemove(source)}
              aria-label={m.library_remove_label({ name: source.display_name })}
              data-testid="library-remove"
            >
              <XIcon />
            </Button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<SourcePathDialog bind:open={importOpen} mode="import" onsubmit={addFolder} />
<SourcePathDialog
  bind:open={relinkOpen}
  mode="relink"
  sourceName={relinking?.display_name ?? ""}
  onsubmit={(path) => relinkTo(relinking!, path)}
/>

<Dialog.Root
  open={removing !== null}
  onOpenChange={(next) => {
    if (!next) removing = null;
  }}
>
  <Dialog.Content data-testid="library-remove-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.library_remove_title({ name: removing?.display_name ?? "" })}</Dialog.Title>
      <Dialog.Description>{m.library_remove_hint()}</Dialog.Description>
    </Dialog.Header>
    {#if removing?.kind === "crawl_batch"}
      <div class="flex items-center gap-2">
        <Checkbox id="library-remove-files" bind:checked={deleteFiles} />
        <Label for="library-remove-files" class="text-sm">{m.library_remove_files()}</Label>
      </div>
    {/if}
    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}<Button variant="ghost" {...props}>{m.common_cancel()}</Button>{/snippet}
      </Dialog.Close>
      <Button variant="destructive" onclick={confirmRemove} data-testid="library-remove-confirm">
        {deleteFiles && removing?.kind === "crawl_batch" ? m.library_remove_confirm_files() : m.library_remove_confirm()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
