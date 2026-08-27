<script lang="ts">
  import { onMount, tick, untrack } from "svelte";

  import { ApiError, type ApiClient } from "../../core/api/client";
  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../../core/a11y/focus";
  import { createPlatformAdapter } from "../../core/platform/adapter";
  import { createGalleryController } from "./controller";
  import {
    GALLERY_AVAILABILITY_LABELS,
    GALLERY_DEDUP_STATE_LABELS,
    GALLERY_SOURCE_KIND_LABELS,
    GALLERY_TXT_STATE_LABELS,
    galleryBreadcrumb,
    galleryVisibleRange,
    type GalleryAssetEntry,
    type GalleryDirectoryEntry,
    type GalleryDirectoryExportOperation,
    type GalleryTxtState,
  } from "./model";
  import { createGalleryService } from "./service";
  import { createGalleryStore, type GalleryBrowseState } from "./state";
  import Viewer from "./Viewer.svelte";
  import "./gallery.css";

  let { api }: { api: ApiClient } = $props();

  const runtime = untrack(() => {
    const store = createGalleryStore();
    const service = createGalleryService(api);
    return { store, service, controller: createGalleryController({ store, service }) };
  });
  const { store, service, controller } = runtime;
  const snapshot: GalleryBrowseState = $derived($store);

  // ---- 虚拟化窗口状态（滚动驱动，非 store 事务） ----
  let contentScroll = $state(0);
  let contentHeight = $state(0);
  let gridColumns = $state(4);
  const GRID_CELL = 208;
  const GRID_ROW = 268;
  const LIST_ROW = 56;
  const OVERSCAN = 2;

  const rowHeight = $derived(snapshot.viewMode === "grid" ? GRID_ROW : LIST_ROW);
  const windowing = $derived(
    galleryVisibleRange({
      total: snapshot.assets.length,
      scrollTop: contentScroll,
      viewportHeight: contentHeight,
      columnCount: snapshot.viewMode === "grid" ? gridColumns : 1,
      rowHeight,
      overscanRows: OVERSCAN,
    }),
  );
  const visibleAssets = $derived(
    snapshot.assets.slice(windowing.startIndex, windowing.endIndex + 1),
  );

  const breadcrumb = $derived(
    snapshot.activeSourceId
      ? galleryBreadcrumb(
          snapshot.sources.find((item) => item.source_id === snapshot.activeSourceId)?.display_name
            ?? "来源",
          snapshot.path,
        )
      : [],
  );

  const txtStateOptions: readonly { value: string; label: string }[] = [
    { value: "", label: "全部 TXT 状态" },
    ...(Object.keys(GALLERY_TXT_STATE_LABELS) as GalleryTxtState[]).map((state) => ({
      value: state,
      label: GALLERY_TXT_STATE_LABELS[state],
    })),
  ];

  let searchDraft = $state("");

  function onContentScroll(event: Event): void {
    const element = event.currentTarget as HTMLElement;
    contentScroll = element.scrollTop;
    if (
      element.scrollTop + element.clientHeight >= element.scrollHeight - rowHeight * 3 &&
      (snapshot.directoryCursor !== null || snapshot.assetCursor !== null)
    ) {
      void controller.loadMore();
    }
  }

  function onContentResize(entries: ResizeObserverEntry[]): void {
    for (const entry of entries) {
      contentHeight = entry.contentRect.height;
      gridColumns = Math.max(1, Math.floor(entry.contentRect.width / GRID_CELL));
    }
  }

  // ---- 选择与查看器（G2-3） ----
  const selectedIds = $derived(new Set(snapshot.selectedAssetIds));

  function onAssetClick(event: MouseEvent, asset: GalleryAssetEntry): void {
    controller.clickAsset(asset.asset_id, {
      additive: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
    });
  }

  function onAssetActivate(asset: GalleryAssetEntry): void {
    controller.openViewer(asset.asset_id);
  }

  // ---- G3-3 文件操作 ----
  let renameDraft = $state("");

  const singleSelectedAsset = $derived(
    snapshot.selectedAssetIds.length === 1 ? snapshot.assets.find((item) => item.asset_id === snapshot.selectedAssetIds[0]) ?? null : null,
  );

  function requestDeleteSelection(): void {
    if (snapshot.selectedAssetIds.length === 0) return;
    controller.requestTrashSelection();
  }

  function requestRenameSelection(): void {
    if (singleSelectedAsset === null) return;
    const dot = singleSelectedAsset.name.lastIndexOf(".");
    renameDraft = dot > 0 ? singleSelectedAsset.name.slice(0, dot) : singleSelectedAsset.name;
    controller.openRenameDialog(singleSelectedAsset.asset_id);
  }

  function onGridKeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input, textarea, select"))) return;
    if (event.key === "Delete") {
      event.preventDefault();
      requestDeleteSelection();
    } else if ((event.ctrlKey || event.metaKey) && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      controller.selectAllAssets();
    } else if (event.key === "F2") {
      event.preventDefault();
      requestRenameSelection();
    }
  }


  function formatTrashTimestamp(epochMs: number): string {
    const parsed = new Date(epochMs);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString("zh-Hans-CN");
  }

  let lastFocusedAssetId = "";

  function onCardKeydown(event: KeyboardEvent, asset: GalleryAssetEntry): void {
    if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onAssetActivate(asset);
    }
  }

  function closeViewer(): void {
    controller.closeViewer();
    // 返回网格：焦点回到活动图片（记忆 #30 契约——返回后恢复活动图片焦点）。
    queueMicrotask(() => {
      const element = document.querySelector<HTMLElement>(`[data-gallery-asset="${CSS.escape(lastFocusedAssetId)}"]`);
      element?.focus();
    });
  }

  function submitSearch(event: SubmitEvent): void {
    event.preventDefault();
    void controller.submitQuery(searchDraft);
  }

  function clearSearch(): void {
    searchDraft = "";
    void controller.submitQuery("");
  }

  function txtBadge(asset: GalleryAssetEntry): string {
    return GALLERY_TXT_STATE_LABELS[asset.txt_state];
  }

  function txtBadgeKind(asset: GalleryAssetEntry): string {
    if (asset.txt_state === "normal") return "ok";
    if (asset.txt_state === "missing") return "muted";
    return "warn";
  }

  function directoryLabel(directory: GalleryDirectoryEntry): string {
    return directory.name.length > 0 ? directory.name : "根目录";
  }

  function formatCount(value: number): string {
    return value.toLocaleString("zh-Hans-CN");
  }

  function sourceSubtitle(source: GalleryBrowseState["sources"][number]): string {
    const parts = [GALLERY_SOURCE_KIND_LABELS[source.kind], GALLERY_AVAILABILITY_LABELS[source.availability]];
    if (source.dedup_required) parts.push(GALLERY_DEDUP_STATE_LABELS[source.dedup_state]);
    return parts.join(" · ");
  }

  const platform = untrack(() => createPlatformAdapter());
  let importPhase: "idle" | "picking" | "importing" = $state("idle");
  let importError: string | null = $state(null);

  const canImportDirectories = $derived(platform.capabilities.selectDirectory);

  async function importDirectoryFlow(): Promise<void> {
    if (importPhase !== "idle" || !platform.capabilities.selectDirectory) return;
    importError = null;
    importPhase = "picking";
    try {
      const rootPath = await platform.selectDirectory("gallery_import");
      if (rootPath === null) {
        importPhase = "idle";
        return;
      }
      importPhase = "importing";
      await controller.importDirectory(rootPath);
    } catch (error) {
      importError = error instanceof Error ? error.message : "import_failed";
    } finally {
      importPhase = "idle";
    }
  }

  // ---- Gallery 内短生命周期目录导出（R3） ----
  interface DirectoryExportSelection {
    readonly directoryId: string;
    readonly directoryName: string;
    readonly sourceLabel: string;
    readonly relativePath: string;
  }

  type DirectoryExportPhase =
    | "idle"
    | "starting"
    | "copying"
    | "cancelling"
    | "error";

  let directoryExportOpen = $state(false);
  let directoryExportPhase = $state<DirectoryExportPhase>("idle");
  let directoryExportSelections = $state<DirectoryExportSelection[]>([]);
  let directoryExportTargetPath = $state("");
  let directoryExportTargetPicking = $state(false);
  let directoryExportTargetError = $state<string | null>(null);
  let directoryExportErrorCode = $state<string | null>(null);
  let directoryExportConflictNames = $state<readonly string[]>([]);
  let directoryExportOperation = $state<GalleryDirectoryExportOperation | null>(null);
  let directoryExportRevealError = $state<string | null>(null);
  let directoryExportPollTimer: ReturnType<typeof setTimeout> | null = null;
  let directoryExportPollAbort: AbortController | null = null;
  let directoryExportPanel = $state<HTMLElement>();
  let directoryExportReturnFocus: FocusTarget | null = null;

  let directoryExportPickerOpen = $state(false);
  let directoryExportPickerPhase = $state<"idle" | "loading" | "error">("idle");
  let directoryExportPickerSourceId = $state<string | null>(null);
  let directoryExportPickerCurrent = $state<GalleryDirectoryEntry | null>(null);
  let directoryExportPickerChildren = $state<readonly GalleryDirectoryEntry[]>([]);
  let directoryExportPickerTrail = $state<readonly GalleryDirectoryEntry[]>([]);
  let directoryExportPickerCursor = $state<string | null>(null);
  let directoryExportPickerError = $state<string | null>(null);
  let directoryExportPickerAbort: AbortController | null = null;

  const directoryExportBusy = $derived(
    directoryExportPhase === "starting" ||
      directoryExportPhase === "copying" ||
      directoryExportPhase === "cancelling" ||
      directoryExportOperation?.state === "copying",
  );

  function exportSelection(
    directory: GalleryDirectoryEntry,
    sourceLabel: string,
  ): DirectoryExportSelection {
    return {
      directoryId: directory.directory_id,
      directoryName: directory.name || sourceLabel,
      sourceLabel,
      relativePath: directory.relative_path || "来源根目录",
    };
  }

  function currentDirectoryExportSelection(): DirectoryExportSelection | null {
    const directory = snapshot.currentDirectory;
    const source = snapshot.sources.find(
      (item) => item.source_id === snapshot.activeSourceId,
    );
    return directory === null || source === undefined
      ? null
      : exportSelection(directory, source.display_name);
  }

  function directoryExportFocusable(): HTMLElement[] {
    return [
      ...(directoryExportPanel?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
  }

  function focusDirectoryExportPanel(): void {
    void tick().then(() => restoreFocus(directoryExportPanel));
  }

  function onDirectoryExportKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const items = directoryExportFocusable();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = trappedTabIndex(current, items.length, event.shiftKey);
    if (next !== null) {
      event.preventDefault();
      restoreFocus(items[next]);
    }
  }

  function openDirectoryExport(): void {
    directoryExportReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    directoryExportOpen = true;
    directoryExportPickerOpen = false;
    if (directoryExportOperation?.state === "copying") {
      focusDirectoryExportPanel();
      return;
    }
    directoryExportPhase = "idle";
    directoryExportErrorCode = null;
    directoryExportConflictNames = [];
    directoryExportRevealError = null;
    directoryExportOperation = null;
    const current = currentDirectoryExportSelection();
    directoryExportSelections = current === null ? [] : [current];
    focusDirectoryExportPanel();
  }

  function closeDirectoryExport(): void {
    if (directoryExportBusy) return;
    const target = directoryExportReturnFocus;
    directoryExportOpen = false;
    directoryExportPickerOpen = false;
    directoryExportPickerAbort?.abort();
    directoryExportPickerAbort = null;
    directoryExportReturnFocus = null;
    queueMicrotask(() => restoreFocus(target));
  }

  function addDirectoryExportSelection(
    directory: GalleryDirectoryEntry,
    sourceLabel: string,
  ): void {
    if (directoryExportSelections.some((item) => item.directoryId === directory.directory_id)) {
      return;
    }
    directoryExportSelections = [
      ...directoryExportSelections,
      exportSelection(directory, sourceLabel),
    ];
  }

  function removeDirectoryExportSelection(directoryId: string): void {
    if (directoryExportBusy) return;
    directoryExportSelections = directoryExportSelections.filter(
      (item) => item.directoryId !== directoryId,
    );
  }

  function openDirectoryExportPicker(): void {
    if (directoryExportBusy) return;
    directoryExportPickerOpen = true;
    directoryExportPickerPhase = "idle";
    directoryExportPickerSourceId = null;
    directoryExportPickerCurrent = null;
    directoryExportPickerChildren = [];
    directoryExportPickerTrail = [];
    directoryExportPickerCursor = null;
    directoryExportPickerError = null;
    void tick().then(() =>
      restoreFocus(
        directoryExportPanel?.querySelector<HTMLElement>(".gallery-export-picker button"),
      ),
    );
  }

  function closeDirectoryExportPicker(): void {
    directoryExportPickerAbort?.abort();
    directoryExportPickerAbort = null;
    directoryExportPickerOpen = false;
    void tick().then(() =>
      restoreFocus(
        directoryExportPanel?.querySelector<HTMLElement>("[data-gallery-export-add]"),
      ),
    );
  }

  async function loadDirectoryExportPicker(
    sourceId: string,
    directoryId: string,
    trail: readonly GalleryDirectoryEntry[],
  ): Promise<void> {
    directoryExportPickerAbort?.abort();
    const request = new AbortController();
    directoryExportPickerAbort = request;
    directoryExportPickerPhase = "loading";
    directoryExportPickerError = null;
    try {
      const page = await service.listDirectoryEntries(
        {
          directoryId,
          includeDescendants: false,
          txtState: null,
          query: "",
          directoryCursor: null,
          assetCursor: null,
        },
        request.signal,
      );
      if (request.signal.aborted) return;
      directoryExportPickerSourceId = sourceId;
      directoryExportPickerCurrent = page.directory;
      directoryExportPickerChildren = page.directories;
      directoryExportPickerTrail = trail.length === 0 ? [page.directory] : trail;
      directoryExportPickerCursor = page.directory_cursor;
      directoryExportPickerPhase = "idle";
      void tick().then(() =>
        restoreFocus(
          directoryExportPanel?.querySelector<HTMLElement>(
            ".gallery-export-picker__current button, .gallery-export-picker__toolbar button",
          ),
        ),
      );
    } catch (error) {
      if (request.signal.aborted) return;
      directoryExportPickerPhase = "error";
      directoryExportPickerError =
        error instanceof ApiError ? error.code : "directory_picker_failed";
    } finally {
      if (directoryExportPickerAbort === request) directoryExportPickerAbort = null;
    }
  }

  function openDirectoryExportPickerSource(sourceId: string): void {
    const source = snapshot.sources.find((item) => item.source_id === sourceId);
    if (source?.root_directory_id === null || source === undefined) return;
    void loadDirectoryExportPicker(source.source_id, source.root_directory_id, []);
  }

  function enterDirectoryExportPickerChild(directory: GalleryDirectoryEntry): void {
    if (directoryExportPickerSourceId === null) return;
    void loadDirectoryExportPicker(
      directoryExportPickerSourceId,
      directory.directory_id,
      [...directoryExportPickerTrail, directory],
    );
  }

  function goUpDirectoryExportPicker(): void {
    if (directoryExportPickerSourceId === null) return;
    if (directoryExportPickerTrail.length <= 1) {
      directoryExportPickerSourceId = null;
      directoryExportPickerCurrent = null;
      directoryExportPickerChildren = [];
      directoryExportPickerTrail = [];
      return;
    }
    const trail = directoryExportPickerTrail.slice(0, -1);
    const parent = trail.at(-1);
    if (parent !== undefined) {
      void loadDirectoryExportPicker(
        directoryExportPickerSourceId,
        parent.directory_id,
        trail,
      );
    }
  }

  async function loadMoreDirectoryExportPicker(): Promise<void> {
    const current = directoryExportPickerCurrent;
    const cursor = directoryExportPickerCursor;
    if (current === null || cursor === null || directoryExportPickerPhase === "loading") return;
    directoryExportPickerAbort?.abort();
    const request = new AbortController();
    directoryExportPickerAbort = request;
    directoryExportPickerPhase = "loading";
    try {
      const page = await service.listDirectoryEntries(
        {
          directoryId: current.directory_id,
          includeDescendants: false,
          txtState: null,
          query: "",
          directoryCursor: cursor,
          assetCursor: null,
        },
        request.signal,
      );
      if (request.signal.aborted) return;
      const known = new Set(directoryExportPickerChildren.map((item) => item.directory_id));
      directoryExportPickerChildren = [
        ...directoryExportPickerChildren,
        ...page.directories.filter((item) => !known.has(item.directory_id)),
      ];
      directoryExportPickerCursor = page.directory_cursor;
      directoryExportPickerPhase = "idle";
    } catch (error) {
      if (request.signal.aborted) return;
      directoryExportPickerPhase = "error";
      directoryExportPickerError =
        error instanceof ApiError ? error.code : "directory_picker_failed";
    } finally {
      if (directoryExportPickerAbort === request) directoryExportPickerAbort = null;
    }
  }

  function addDirectoryExportPickerCurrent(): void {
    const directory = directoryExportPickerCurrent;
    const source = snapshot.sources.find(
      (item) => item.source_id === directoryExportPickerSourceId,
    );
    if (directory === null || source === undefined) return;
    addDirectoryExportSelection(directory, source.display_name);
  }

  function addDirectoryExportPickerChild(directory: GalleryDirectoryEntry): void {
    const source = snapshot.sources.find(
      (item) => item.source_id === directoryExportPickerSourceId,
    );
    if (source === undefined) return;
    addDirectoryExportSelection(directory, source.display_name);
  }

  async function chooseDirectoryExportTarget(): Promise<void> {
    if (!platform.capabilities.selectDirectory || directoryExportTargetPicking) return;
    directoryExportTargetPicking = true;
    directoryExportTargetError = null;
    try {
      const picked = await platform.selectDirectory("export_target");
      if (picked !== null) directoryExportTargetPath = picked;
    } catch {
      directoryExportTargetError = "target_picker_unavailable";
    } finally {
      directoryExportTargetPicking = false;
    }
  }

  function exportConflictNames(error: unknown): readonly string[] {
    if (!(error instanceof ApiError) || error.details === null) return [];
    if (typeof error.details !== "object" || Array.isArray(error.details)) return [];
    const names = (error.details as { names?: unknown }).names;
    if (!Array.isArray(names)) return [];
    return names
      .filter((name): name is string => typeof name === "string" && name.length <= 255)
      .slice(0, 500);
  }

  function clearDirectoryExportPolling(): void {
    if (directoryExportPollTimer !== null) clearTimeout(directoryExportPollTimer);
    directoryExportPollTimer = null;
    directoryExportPollAbort?.abort();
    directoryExportPollAbort = null;
  }

  function applyDirectoryExportOperation(operation: GalleryDirectoryExportOperation): void {
    directoryExportOperation = operation;
    directoryExportPhase = operation.state === "copying" ? "copying" : "idle";
    if (operation.state === "copying") scheduleDirectoryExportPoll(operation.operation_id);
  }

  function scheduleDirectoryExportPoll(operationId: string): void {
    if (directoryExportPollTimer !== null) clearTimeout(directoryExportPollTimer);
    directoryExportPollTimer = setTimeout(() => {
      directoryExportPollTimer = null;
      void pollDirectoryExport(operationId);
    }, 400);
  }

  async function pollDirectoryExport(operationId: string): Promise<void> {
    directoryExportPollAbort?.abort();
    const request = new AbortController();
    directoryExportPollAbort = request;
    try {
      const operation = await service.getDirectoryExport(operationId, request.signal);
      if (!request.signal.aborted && directoryExportOperation?.operation_id === operationId) {
        applyDirectoryExportOperation(operation);
      }
    } catch (error) {
      if (request.signal.aborted) return;
      directoryExportPhase = "error";
      directoryExportErrorCode =
        error instanceof ApiError ? error.code : "directory_export_status_failed";
    } finally {
      if (directoryExportPollAbort === request) directoryExportPollAbort = null;
    }
  }

  async function startDirectoryExport(): Promise<void> {
    if (directoryExportBusy) return;
    directoryExportTargetError =
      directoryExportTargetPath.trim().length === 0 ? "请选择或填写目标目录" : null;
    if (directoryExportSelections.length === 0) {
      directoryExportErrorCode = "directory_selection_required";
      return;
    }
    if (directoryExportTargetError !== null) return;
    directoryExportPhase = "starting";
    directoryExportErrorCode = null;
    directoryExportConflictNames = [];
    directoryExportRevealError = null;
    directoryExportOperation = null;
    try {
      const operation = await service.startDirectoryExport(
        directoryExportSelections.map((item) => item.directoryId),
        directoryExportTargetPath,
      );
      applyDirectoryExportOperation(operation);
    } catch (error) {
      directoryExportPhase = "error";
      directoryExportErrorCode =
        error instanceof ApiError ? error.code : "directory_export_start_failed";
      directoryExportConflictNames = exportConflictNames(error);
    }
  }

  async function cancelDirectoryExport(): Promise<void> {
    const operation = directoryExportOperation;
    if (operation === null || operation.state !== "copying") return;
    clearDirectoryExportPolling();
    directoryExportPhase = "cancelling";
    directoryExportErrorCode = null;
    try {
      applyDirectoryExportOperation(
        await service.cancelDirectoryExport(operation.operation_id),
      );
    } catch (error) {
      directoryExportPhase = "error";
      directoryExportErrorCode =
        error instanceof ApiError ? error.code : "directory_export_cancel_failed";
    }
  }

  function retryDirectoryExportStatus(): void {
    const operation = directoryExportOperation;
    if (operation?.state !== "copying") return;
    directoryExportPhase = "copying";
    directoryExportErrorCode = null;
    void pollDirectoryExport(operation.operation_id);
  }

  async function revealDirectoryExportTarget(): Promise<void> {
    if (!platform.capabilities.revealInFileManager || directoryExportTargetPath.length === 0) return;
    directoryExportRevealError = null;
    try {
      await platform.revealInFileManager(directoryExportTargetPath);
    } catch {
      directoryExportRevealError = "reveal_target_failed";
    }
  }

  function resetDirectoryExportResult(): void {
    if (directoryExportBusy) return;
    directoryExportOperation = null;
    directoryExportPhase = "idle";
    directoryExportErrorCode = null;
    directoryExportConflictNames = [];
    directoryExportSelections = [];
    const current = currentDirectoryExportSelection();
    if (current !== null) directoryExportSelections = [current];
  }

  function formatDirectoryExportBytes(value: number): string {
    if (value < 1024) return `${value.toLocaleString("zh-Hans-CN")} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }

  onMount(() => {
    controller.activate();
    return () => {
      const activeExport = directoryExportOperation;
      clearDirectoryExportPolling();
      directoryExportPickerAbort?.abort();
      if (activeExport?.state === "copying") {
        void service.cancelDirectoryExport(activeExport.operation_id);
      }
      controller.destroy();
    };
  });

  /** 应用级快捷键：对话框/面板 Escape + 网格 Delete/Ctrl+A/F2（查看器打开时让位）。 */
  function onAppKeydown(event: KeyboardEvent): void {
    if (snapshot.viewerIndex >= 0) return;
    if (directoryExportOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (directoryExportPickerOpen) closeDirectoryExportPicker();
        else closeDirectoryExport();
      }
      return;
    }
    if (snapshot.renameDialogPhase !== "closed" || snapshot.trashConfirmPhase !== "closed" || snapshot.trashPanelPhase !== "closed") {
      if (event.key === "Escape") {
        event.preventDefault();
        if (snapshot.renameDialogPhase !== "closed") controller.cancelRename();
        else if (snapshot.trashConfirmPhase !== "closed") controller.cancelTrashConfirm();
        else controller.closeTrashPanel();
      }
      return;
    }
    onGridKeydown(event);
  }
</script>


<svelte:window onkeydown={onAppKeydown} />

<section class="gallery-app" data-gallery-app data-domain-owner="gallery" data-preview-availability="live" aria-labelledby="gallery-heading">
  <header class="gallery-header">
    <div><p>图片库</p><h1 id="gallery-heading">媒体浏览工作区</h1></div>
    <span class="gallery-status" data-kind={snapshot.sourcesPhase}>{snapshot.sourcesPhase === "ready" ? `${formatCount(snapshot.sources.length)} 个来源` : snapshot.sourcesPhase === "error" ? "来源加载失败" : "正在加载来源"}</span>
  </header>

  <div class="gallery-body">
    <aside class="gallery-tree" aria-labelledby="gallery-tree-heading">
      <h2 id="gallery-tree-heading">来源与目录</h2>
      {#if snapshot.sourcesPhase === "loading" || snapshot.sourcesPhase === "idle"}
        <p class="gallery-hint" role="status">正在加载来源…</p>
      {:else if snapshot.sourcesPhase === "error"}
        <p class="gallery-hint gallery-hint--error" role="alert">来源加载失败（{snapshot.sourcesErrorCode}）</p>
        <button type="button" class="gallery-link" onclick={() => void controller.refreshSources()}>重试加载来源</button>
      {:else if snapshot.sources.length === 0}
        <p class="gallery-hint">暂无图库来源。完成下载批次或导入本地目录后，这里会显示可浏览的来源。</p>
      {:else}
        <ul class="gallery-source-list">
          {#each snapshot.sources as source (source.source_id)}
            <li>
              <button
                type="button"
                class="gallery-source"
                aria-current={snapshot.activeSourceId === source.source_id ? "true" : undefined}
                onclick={() => void controller.openSource(source.source_id)}
              >
                <span class="gallery-source__name">{source.display_name}</span>
                <span class="gallery-source__meta">{sourceSubtitle(source)}</span>
                <span class="gallery-source__count">{formatCount(source.asset_count)} 张图片{source.root_directory_id === null ? " · 待扫描" : ""}</span>
              </button>
              {#if snapshot.activeSourceId === source.source_id && snapshot.path.length > 0}
                <ul class="gallery-pathlist" aria-label="当前目录路径">
                  {#each snapshot.path as segment (segment.directory_id)}
                    <li><button type="button" class="gallery-link" onclick={() => void controller.openDirectory(segment.directory_id)}>{segment.name}</button></li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      <div class="gallery-import">
        <button type="button" onclick={() => void importDirectoryFlow()} disabled={!canImportDirectories || importPhase !== "idle"}>
          {importPhase === "importing" ? "正在导入目录…" : "导入目录…"}
        </button>
        {#if !canImportDirectories}
          <p class="gallery-hint">目录导入需要桌面环境。</p>
        {/if}
        {#if importError}
          <p class="gallery-hint gallery-hint--error" role="alert">导入失败（{importError}）</p>
        {/if}
      </div>
    </aside>

    <main class="gallery-content" aria-labelledby="gallery-content-heading">
      <h2 id="gallery-content-heading" class="gallery-visually-hidden">目录内容</h2>
      {#if snapshot.activeSourceId === null}
        <div class="gallery-empty" role="status">
          <strong>选择一个来源开始浏览</strong>
          <p>左侧选择下载批次或导入目录；这里会显示目录树和图片网格。</p>
        </div>
      {:else}
        <nav class="gallery-toolbar" aria-label="目录浏览工具">
          <ol class="gallery-breadcrumb" aria-label="目录路径">
            {#each breadcrumb as segment, index (index)}
              <li>
                {#if index < breadcrumb.length - 1}
                  <button type="button" class="gallery-link" onclick={() => void controller.navigateToBreadcrumb(index)}>{segment.label}</button>
                {:else}
                  <span aria-current="page">{segment.label}</span>
                {/if}
              </li>
            {/each}
          </ol>
          <form class="gallery-search" onsubmit={submitSearch} role="search">
            <label class="gallery-visually-hidden" for="gallery-search-input">搜索当前范围</label>
            <input
              id="gallery-search-input"
              type="search"
              placeholder="搜索文件名、相对路径或 TXT 原文"
              maxlength="256"
              autocomplete="off"
              bind:value={searchDraft}
            />
            <button type="submit">搜索</button>
            {#if snapshot.query.length > 0}
              <button type="button" onclick={clearSearch}>清除</button>
            {/if}
          </form>
          <div class="gallery-toolbar-controls" role="group" aria-label="范围与筛选">
            <label>
              <span>范围</span>
              <select value={snapshot.searchScope} onchange={(event) => void controller.setSearchScope((event.currentTarget as HTMLSelectElement).value as typeof snapshot.searchScope)}>
                <option value="directory">当前目录</option>
                <option value="source">整个来源</option>
              </select>
            </label>
            <label>
              <span>包含子目录</span>
              <input
                type="checkbox"
                checked={snapshot.includeDescendants}
                disabled={snapshot.searchScope === "source"}
                onchange={(event) => void controller.setIncludeDescendants((event.currentTarget as HTMLInputElement).checked)}
              />
            </label>
            <label>
              <span>TXT 状态</span>
              <select value={snapshot.txtStateFilter ?? ""} onchange={(event) => { const value = (event.currentTarget as HTMLSelectElement).value; void controller.setTxtStateFilter(value === "" ? null : (value as GalleryTxtState)); }}>
                {#each txtStateOptions as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
            <div class="gallery-viewtoggle" role="group" aria-label="视图方式">
              <button type="button" aria-pressed={snapshot.viewMode === "grid"} onclick={() => controller.setViewMode("grid")}>网格</button>
              <button type="button" aria-pressed={snapshot.viewMode === "list"} onclick={() => controller.setViewMode("list")}>列表</button>
            </div>
            {#if snapshot.selectedAssetIds.length > 0}
              <span class="gallery-toolbar-selection">已选 {formatCount(snapshot.selectedAssetIds.length)} 张</span>
              <button type="button" onclick={requestRenameSelection} disabled={singleSelectedAsset === null}>重命名…</button>
              <button type="button" class="gallery-toolbar-danger" onclick={requestDeleteSelection}>删除…</button>
            {/if}
            <button
              type="button"
              aria-pressed={snapshot.trashPanelPhase !== "closed"}
              onclick={() => {
                if (snapshot.trashPanelPhase === "closed") void controller.openTrashPanel();
                else controller.closeTrashPanel();
              }}
            >回收区</button>
            <button
              type="button"
              class="gallery-toolbar-export"
              onclick={openDirectoryExport}
              disabled={snapshot.currentDirectory === null}
            >导出目录…</button>
          </div>
        </nav>

        {#if snapshot.pagePhase === "loading" && snapshot.directories.length === 0 && snapshot.assets.length === 0}
          <p class="gallery-hint" role="status">正在加载目录内容…</p>
        {:else if snapshot.pagePhase === "error"}
          <p class="gallery-hint gallery-hint--error" role="alert">目录加载失败（{snapshot.pageErrorCode}）</p>
          <button type="button" class="gallery-link" onclick={() => void controller.navigateToBreadcrumb(-1)}>重试</button>
        {:else if snapshot.directories.length === 0 && snapshot.assets.length === 0}
          <div class="gallery-empty" role="status">
            <strong>此目录为空{snapshot.query ? "或没有匹配的搜索结果" : ""}</strong>
            {#if snapshot.query}<p>搜索词：{snapshot.query}</p>{/if}
          </div>
        {:else}
          {#if snapshot.directories.length > 0}
            <ul class="gallery-folders" aria-label="子目录">
              {#each snapshot.directories as directory (directory.directory_id)}
                <li>
                  <button type="button" class="gallery-folder" onclick={() => void controller.openDirectory(directory.directory_id)}>
                    <span class="gallery-folder__cover" data-count={Math.min(directory.recursive_asset_count, 4)} aria-hidden="true">
                      {#each directory.cover_asset_ids.slice(0, 4) as coverId (coverId)}
                        <img src={service.thumbnailUrl(coverId)} alt="" loading="lazy" decoding="async" />
                      {/each}
                    </span>
                    <span class="gallery-folder__name">{directoryLabel(directory)}</span>
                    <span class="gallery-folder__meta">{formatCount(directory.recursive_asset_count)} 张 · {formatCount(directory.direct_asset_count)} 张直属</span>
                  </button>
                </li>
              {/each}
              {#if snapshot.directoryCursor !== null}
                <li class="gallery-folders__more"><button type="button" class="gallery-link" onclick={() => void controller.loadMore()}>加载更多目录</button></li>
              {/if}
            </ul>
          {/if}
          {#if snapshot.assets.length > 0}
            {#if snapshot.viewMode === "grid"}
              <div
                class="gallery-grid-scroll"
                aria-label="图片网格"
                onscroll={onContentScroll}
                use:resizeObserver={{ onContentResize }}
              >
                <div class="gallery-grid" style={`grid-template-columns: repeat(${gridColumns}, minmax(0, 1fr)); height: ${windowing.totalHeight}px;`}>
                  <div class="gallery-grid-window" style={`transform: translateY(${windowing.startOffsetY}px);`}>
                    {#each visibleAssets as asset (asset.asset_id)}
                      <button
                        type="button"
                        class="gallery-card"
                        class:selected={selectedIds.has(asset.asset_id)}
                        data-gallery-asset={asset.asset_id}
                        title={asset.relative_path}
                        aria-pressed={selectedIds.has(asset.asset_id)}
                        onclick={(event) => onAssetClick(event, asset)}
                        ondblclick={() => onAssetActivate(asset)}
                        onkeydown={(event) => onCardKeydown(event, asset)}
                        onfocus={() => (lastFocusedAssetId = asset.asset_id)}
                      >
                        <span class="gallery-card__media">
                          <img src={service.thumbnailUrl(asset.asset_id)} alt={asset.name} loading="lazy" decoding="async" />
                        </span>
                        <span class="gallery-card__name">{asset.name}</span>
                        <span class="gallery-card__badges">
                          <span class="gallery-badge" data-kind={txtBadgeKind(asset)}>{txtBadge(asset)}</span>
                          {#if asset.dedup_visibility === "excluded"}<span class="gallery-badge" data-kind="muted">已排除</span>{/if}
                        </span>
                      </button>
                    {/each}
                  </div>
                </div>
              </div>
            {:else}
              <div
                class="gallery-list-scroll"
                aria-label="图片列表"
                onscroll={onContentScroll}
                use:resizeObserver={{ onContentResize }}
              >
                <div class="gallery-list" role="table" aria-label="当前目录图片明细">
                  <div class="gallery-list-head" role="row">
                    <span role="columnheader">文件名</span>
                    <span role="columnheader">相对路径</span>
                    <span role="columnheader">TXT 状态</span>
                    <span role="columnheader">大小</span>
                    <span role="columnheader">尺寸</span>
                  </div>
                  <div class="gallery-list-body" style={`height: ${windowing.totalHeight}px;`}>
                    <div class="gallery-list-window" style={`transform: translateY(${windowing.startOffsetY}px);`}>
                      {#each visibleAssets as asset (asset.asset_id)}
                        <div
                          class="gallery-list-row"
                          class:selected={selectedIds.has(asset.asset_id)}
                          role="row"
                          data-gallery-asset={asset.asset_id}
                          tabindex="0"
                          aria-selected={selectedIds.has(asset.asset_id)}
                          onclick={(event) => onAssetClick(event, asset)}
                          ondblclick={() => onAssetActivate(asset)}
                          onkeydown={(event) => onCardKeydown(event, asset)}
                          onfocus={() => (lastFocusedAssetId = asset.asset_id)}
                        >
                          <span class="gallery-list-row__thumb" role="cell"><img src={service.thumbnailUrl(asset.asset_id)} alt="" loading="lazy" decoding="async" /></span>
                          <span class="gallery-list-row__name" role="cell">{asset.name}</span>
                          <span class="gallery-list-row__path" role="cell">{asset.relative_path}</span>
                          <span role="cell"><span class="gallery-badge" data-kind={txtBadgeKind(asset)}>{txtBadge(asset)}</span></span>
                          <span class="gallery-list-row__size" role="cell">{formatCount(asset.size_bytes)} B</span>
                          <span class="gallery-list-row__dims" role="cell">{asset.width}×{asset.height}</span>
                        </div>
                      {/each}
                    </div>
                  </div>
                </div>
              </div>
            {/if}
          {/if}
        {/if}
      {/if}
    </main>
  </div>
</section>

{#if directoryExportOpen}
  <div class="gallery-dialog-backdrop gallery-export-backdrop">
    <div
      class="gallery-export-sheet"
      tabindex="-1"
      bind:this={directoryExportPanel}
      onkeydown={onDirectoryExportKeydown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="gallery-directory-export-title"
      data-gallery-directory-export
    >
      <header class="gallery-export-sheet__header">
        <div>
          <p class="gallery-export-sheet__eyebrow">数据集目录复制</p>
          <h2 id="gallery-directory-export-title">导出完整目录</h2>
        </div>
        <button
          type="button"
          aria-label="关闭目录导出"
          disabled={directoryExportBusy}
          onclick={closeDirectoryExport}
        >关闭</button>
      </header>

      {#if directoryExportPickerOpen}
        <div class="gallery-export-picker">
          <div class="gallery-export-picker__toolbar">
            <button type="button" onclick={closeDirectoryExportPicker}>返回导出设置</button>
            {#if directoryExportPickerSourceId !== null}
              <button
                type="button"
                disabled={directoryExportPickerPhase === "loading"}
                onclick={goUpDirectoryExportPicker}
              >上一级</button>
            {/if}
            <span>
              {directoryExportPickerTrail.length > 0
                ? directoryExportPickerTrail.map((item) => item.name || "根目录").join(" / ")
                : "选择图库来源"}
            </span>
          </div>

          {#if directoryExportPickerSourceId === null}
            <ul class="gallery-export-picker__sources" aria-label="图库来源">
              {#each snapshot.sources as source (source.source_id)}
                <li>
                  <button
                    type="button"
                    disabled={source.root_directory_id === null || source.availability !== "available"}
                    onclick={() => openDirectoryExportPickerSource(source.source_id)}
                  >
                    <strong>{source.display_name}</strong>
                    <span>
                      {source.root_directory_id === null
                        ? "尚未完成扫描"
                        : source.availability !== "available"
                          ? GALLERY_AVAILABILITY_LABELS[source.availability]
                          : `${formatCount(source.asset_count)} 张图片`}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {:else if directoryExportPickerCurrent !== null}
            <div class="gallery-export-picker__current">
              <div>
                <strong>{directoryExportPickerCurrent.name || "根目录"}</strong>
                <span>{directoryExportPickerCurrent.relative_path || "来源根目录"}</span>
              </div>
              <button
                type="button"
                disabled={directoryExportSelections.some((item) => item.directoryId === directoryExportPickerCurrent?.directory_id)}
                onclick={addDirectoryExportPickerCurrent}
              >添加此完整目录</button>
            </div>
            <ul class="gallery-export-picker__directories" aria-label="子目录">
              {#each directoryExportPickerChildren as directory (directory.directory_id)}
                <li>
                  <button
                    type="button"
                    class="gallery-export-picker__enter"
                    onclick={() => enterDirectoryExportPickerChild(directory)}
                  >
                    <strong>{directory.name}</strong>
                    <span>{formatCount(directory.recursive_asset_count)} 张图片</span>
                  </button>
                  <button
                    type="button"
                    disabled={directoryExportSelections.some((item) => item.directoryId === directory.directory_id)}
                    onclick={() => addDirectoryExportPickerChild(directory)}
                  >添加</button>
                </li>
              {/each}
            </ul>
            {#if directoryExportPickerChildren.length === 0 && directoryExportPickerPhase !== "loading"}
              <p class="gallery-export-sheet__hint">此目录没有直属子目录；仍可添加当前目录。</p>
            {/if}
            {#if directoryExportPickerCursor !== null}
              <button
                type="button"
                class="gallery-export-picker__more"
                disabled={directoryExportPickerPhase === "loading"}
                onclick={() => void loadMoreDirectoryExportPicker()}
              >加载更多子目录</button>
            {/if}
          {/if}

          {#if directoryExportPickerPhase === "loading"}
            <p class="gallery-export-sheet__hint" role="status">正在读取目录…</p>
          {:else if directoryExportPickerPhase === "error"}
            <p class="gallery-export-sheet__error" role="alert">目录读取失败（{directoryExportPickerError}）</p>
          {/if}
        </div>
      {:else}
        <div class="gallery-export-sheet__body">
          <p class="gallery-export-sheet__intro">
            每个所选目录会以自身名称成为目标下的独立顶层目录。复制会递归保留原结构，
            只包含 JPG、JPEG、PNG、WebP 与任意 TXT 普通文件；不会覆盖或合并已有内容。
          </p>

          <section class="gallery-export-section" aria-labelledby="gallery-export-selection-title">
            <div class="gallery-export-section__title">
              <h3 id="gallery-export-selection-title">完整目录</h3>
              <button type="button" data-gallery-export-add disabled={directoryExportBusy} onclick={openDirectoryExportPicker}>添加目录…</button>
            </div>
            {#if directoryExportSelections.length === 0}
              <p class="gallery-export-sheet__hint">至少选择一个 Gallery 目录。</p>
            {:else}
              <ul class="gallery-export-selection-list">
                {#each directoryExportSelections as selection (selection.directoryId)}
                  <li>
                    <div>
                      <strong>{selection.directoryName}</strong>
                      <span>{selection.sourceLabel} · {selection.relativePath}</span>
                    </div>
                    <button
                      type="button"
                      aria-label={`移除目录 ${selection.directoryName}`}
                      disabled={directoryExportBusy}
                      onclick={() => removeDirectoryExportSelection(selection.directoryId)}
                    >移除</button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>

          <section class="gallery-export-section" aria-labelledby="gallery-export-target-title">
            <div class="gallery-export-section__title">
              <h3 id="gallery-export-target-title">目标目录</h3>
              {#if platform.capabilities.selectDirectory}
                <button
                  type="button"
                  disabled={directoryExportBusy || directoryExportTargetPicking}
                  onclick={() => void chooseDirectoryExportTarget()}
                >{directoryExportTargetPicking ? "正在打开…" : "选择目录…"}</button>
              {/if}
            </div>
            <label class="gallery-export-target-field">
              <span>目标路径</span>
              <input
                type="text"
                maxlength="4096"
                autocomplete="off"
                readonly={directoryExportBusy}
                bind:value={directoryExportTargetPath}
                oninput={() => (directoryExportTargetError = null)}
                placeholder="选择或填写一个已存在的目标目录"
              />
            </label>
            {#if !platform.capabilities.selectDirectory}
              <p class="gallery-export-sheet__hint">当前环境不能打开系统目录选择器，可手动填写后端可访问的目标目录。</p>
            {/if}
            {#if directoryExportTargetError !== null}
              <p class="gallery-export-sheet__error" role="alert">{directoryExportTargetError}</p>
            {/if}
          </section>

          {#if directoryExportOperation !== null}
            <section class="gallery-export-progress" aria-live="polite" aria-atomic="true">
              <div class="gallery-export-progress__summary">
                <strong>
                  {directoryExportOperation.state === "copying"
                    ? "正在复制"
                    : directoryExportOperation.state === "completed"
                      ? "复制完成"
                      : directoryExportOperation.state === "cancelled"
                        ? "复制已取消"
                        : "复制失败"}
                </strong>
                <span>
                  {formatCount(directoryExportOperation.completed_directory_count)} / {formatCount(directoryExportOperation.directory_count)} 个目录
                  · {formatCount(directoryExportOperation.copied_file_count)} / {formatCount(directoryExportOperation.discovered_file_count)} 个文件
                </span>
              </div>
              <progress
                value={directoryExportOperation.discovered_byte_count > 0
                  ? directoryExportOperation.copied_byte_count
                  : directoryExportOperation.completed_directory_count}
                max={directoryExportOperation.discovered_byte_count > 0
                  ? directoryExportOperation.discovered_byte_count
                  : Math.max(1, directoryExportOperation.directory_count)}
              ></progress>
              <p>
                {formatDirectoryExportBytes(directoryExportOperation.copied_byte_count)} /
                {formatDirectoryExportBytes(directoryExportOperation.discovered_byte_count)}
                {#if directoryExportOperation.current_directory_name !== null}
                  · 当前：{directoryExportOperation.current_directory_name}
                {/if}
              </p>
              {#if directoryExportOperation.results.length > 0}
                <ul class="gallery-export-results">
                  {#each directoryExportOperation.results as result (result.directory_name)}
                    <li data-state={result.status}>
                      <span>{result.directory_name}</span>
                      <span>
                        {result.status === "completed" ? "已完成" : result.status === "cancelled" ? "已取消" : `失败（${result.error_code ?? "unknown"}）`}
                        · {formatCount(result.copied_file_count)} 个文件
                      </span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          {/if}

          {#if directoryExportErrorCode !== null}
            <div class="gallery-export-sheet__error" role="alert">
              <strong>目录导出未完成（{directoryExportErrorCode}）</strong>
              {#if directoryExportConflictNames.length > 0}
                <p>以下顶层名称发生冲突：</p>
                <ul>
                  {#each directoryExportConflictNames as name (name)}<li>{name}</li>{/each}
                </ul>
              {/if}
            </div>
          {/if}
          {#if directoryExportRevealError !== null}
            <p class="gallery-export-sheet__error" role="alert">无法在文件管理器中显示目标目录。</p>
          {/if}
        </div>

        <footer class="gallery-export-sheet__actions">
          {#if directoryExportOperation?.state === "copying"}
            {#if directoryExportPhase === "error"}
              <button type="button" onclick={retryDirectoryExportStatus}>重试读取进度</button>
            {/if}
            <button
              type="button"
              class="gallery-dialog__danger"
              disabled={directoryExportPhase === "cancelling"}
              onclick={() => void cancelDirectoryExport()}
            >{directoryExportPhase === "cancelling" ? "正在取消…" : "取消复制"}</button>
          {:else if directoryExportOperation !== null}
            <button type="button" onclick={resetDirectoryExportResult}>新建目录导出</button>
            {#if directoryExportOperation.successful_directory_names.length > 0 && platform.capabilities.revealInFileManager}
              <button type="button" onclick={() => void revealDirectoryExportTarget()}>在文件管理器中显示</button>
            {/if}
            <button type="button" onclick={closeDirectoryExport}>完成</button>
          {:else}
            <button type="button" onclick={closeDirectoryExport}>取消</button>
            <button
              type="button"
              class="gallery-dialog__primary"
              disabled={directoryExportPhase === "starting" || directoryExportSelections.length === 0}
              onclick={() => void startDirectoryExport()}
            >{directoryExportPhase === "starting" ? "正在预检…" : "开始复制"}</button>
          {/if}
        </footer>
      {/if}
    </div>
  </div>
{/if}

{#if snapshot.viewerIndex >= 0 && snapshot.viewerAssets.length > 0}
  <Viewer {store} {service} controller={controller} onClose={closeViewer} />
{/if}

{#if snapshot.trashConfirmPhase !== "closed"}
  {@const imageCount = snapshot.trashConfirmAssetIds.length}
  {@const txtCount = snapshot.assets.filter((item) => snapshot.trashConfirmAssetIds.includes(item.asset_id) && item.txt_relative_path !== null).length}
  {@const abnormalCount = snapshot.assets.filter((item) => snapshot.trashConfirmAssetIds.includes(item.asset_id) && item.txt_state !== "normal" && item.txt_state !== "missing").length}
  <div class="gallery-dialog-backdrop">
    <div
      class="gallery-dialog"
      role="alertdialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="gallery-trash-confirm-title"
    >
      <h2 id="gallery-trash-confirm-title">移入回收区</h2>
      <p>
        将删除 <strong>{formatCount(imageCount)}</strong> 张图片、
        <strong>{formatCount(txtCount)}</strong> 个同名 TXT、
        <strong>{formatCount(abnormalCount)}</strong> 项 TXT 异常。
        整组操作可撤销；任何单项失败都会回滚整组。
      </p>
      {#if snapshot.trashConfirmError !== null}
        <p class="gallery-dialog__error">{snapshot.trashConfirmError}</p>
      {/if}
      <div class="gallery-dialog__actions">
        <button type="button" onclick={controller.cancelTrashConfirm}>取消</button>
        <button
          type="button"
          class="gallery-dialog__danger"
          disabled={snapshot.trashConfirmPhase === "busy"}
          onclick={() => void controller.confirmTrashSelection()}
        >移入回收区</button>
      </div>
    </div>
  </div>
{/if}

{#if snapshot.renameDialogPhase !== "closed"}
  {@const renameAsset = snapshot.assets.find((item) => item.asset_id === snapshot.renameAssetId) ?? null}
  {@const renameBusy = snapshot.renameDialogPhase === "busy"}
  <div class="gallery-dialog-backdrop">
    <form
      class="gallery-dialog"
      aria-labelledby="gallery-rename-title"
      onsubmit={(event) => {
        event.preventDefault();
        const input = event.currentTarget.querySelector<HTMLInputElement>("input[type=text]");
        void controller.submitRename(input?.value ?? "");
      }}
    >
      <h2 id="gallery-rename-title">成对重命名</h2>
      {#if renameAsset !== null}
        <p>{renameAsset.relative_path} → 同目录内新文件名（图片与同名 TXT 成对重命名）。</p>
      {/if}
      <input
        class="gallery-dialog__input"
        type="text"
        value={renameDraft}
        maxlength="255"
        autocomplete="off"
        aria-label="新文件名（不含扩展名）"
        oninput={(event) => (renameDraft = (event.currentTarget as HTMLInputElement).value)}
      />
      {#if snapshot.renameDialogError !== null}
        <p class="gallery-dialog__error">{snapshot.renameDialogError}</p>
      {/if}
      <div class="gallery-dialog__actions">
        <button type="button" onclick={controller.cancelRename}>取消</button>
        <button type="submit" class="gallery-dialog__primary" disabled={renameBusy}>重命名</button>
      </div>
    </form>
  </div>
{/if}

{#if snapshot.undoToastVisible}
  <div class="gallery-undo-toast" role="status">
    <p>已移入回收区 {formatCount(snapshot.undoItemCount)} 项。</p>
    <button
      type="button"
      disabled={snapshot.undoBusy}
      onclick={() => void controller.undoLastTrash()}
    >撤销</button>
  </div>
{/if}

{#if snapshot.trashPanelPhase !== "closed"}
  <aside class="gallery-trash-panel" aria-label="图库回收区">
    <div class="gallery-trash-panel__head">
      <h2>回收区</h2>
      <button type="button" onclick={() => controller.closeTrashPanel()}>关闭</button>
    </div>
    <div class="gallery-trash-panel__list">
      {#if snapshot.trashPanelPhase === "loading"}
        <p class="gallery-trash-panel__hint" role="status">正在加载回收区…</p>
      {:else if snapshot.trashPanelPhase === "error"}
        <p class="gallery-trash-panel__hint" role="alert">回收区加载失败（{snapshot.trashPanelError ?? "unknown"}）。</p>
      {:else if snapshot.trashOperations.length === 0}
        <p class="gallery-trash-panel__empty">回收区为空。文件将保留至手动恢复或彻底删除。</p>
      {:else}
        {#each snapshot.trashOperations as operation (operation.operation_id)}
          <div class="gallery-trash-item">
            <div class="gallery-trash-item__meta">
              <span class="gallery-trash-item__title">{formatTrashTimestamp(operation.created_at)} · {formatCount(operation.item_count)} 项</span>
              <span class="gallery-trash-item__detail">
                {formatCount(operation.disk_usage_bytes)} B
                {#if operation.has_txt_count > 0} · 含 TXT {formatCount(operation.has_txt_count)}{/if}
                {#if operation.item_error_count > 0} · 异常 {formatCount(operation.item_error_count)}{/if}
              </span>
            </div>
            <div class="gallery-trash-item__actions">
              <button
                type="button"
                disabled={snapshot.trashPanelBusyOperationId === operation.operation_id}
                onclick={() => void controller.restoreTrashOperation(operation.operation_id)}
              >全部恢复</button>
              <button
                type="button"
                disabled={snapshot.trashPanelBusyOperationId === operation.operation_id}
                onclick={() => void controller.purgeTrashOperation(operation.operation_id)}
              >彻底删除</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>
    <div class="gallery-trash-panel__foot">
      <span class="gallery-trash-panel__summary">
        {#if snapshot.trashNextCursor !== null}
          <button type="button" onclick={() => void controller.loadMoreTrash()}>加载更多</button>
        {:else}
          回收区不自动清理；文件保留至手动恢复或彻底删除。
        {/if}
      </span>
      <button type="button" onclick={() => void controller.refreshDirectory()}>重新扫描</button>
    </div>
  </aside>
{/if}

<script module lang="ts">
  // ResizeObserver 指令：观察内容滚动视口高度以驱动虚拟化窗口。
  import type { Action } from "svelte/action";

  export const resizeObserver: Action<HTMLElement, { onContentResize: (entries: ResizeObserverEntry[]) => void }> =
    (element, parameters) => {
      let observer: ResizeObserver | null = null;
      const observe = (callback: (entries: ResizeObserverEntry[]) => void) => {
        observer?.disconnect();
        observer = new ResizeObserver(callback);
        observer.observe(element);
      };
      if (parameters) observe(parameters.onContentResize);
      return {
        update(next: { onContentResize: (entries: ResizeObserverEntry[]) => void }) {
          observe(next.onContentResize);
        },
        destroy() {
          observer?.disconnect();
        },
      };
    };
</script>
