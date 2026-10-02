<script lang="ts">
  import { onMount, tick, untrack } from "svelte";

  import { ApiError, type ApiClient } from "../../core/api/client";
  import { restoreFocus, trappedTabIndex, type FocusTarget } from "../../core/a11y/focus";
  import { translateCurrentUiText } from "../../core/i18n";
  import {
    createPlatformAdapter,
    type PlatformDirectoryPurpose,
  } from "../../core/platform/adapter";
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
  import { enqueueThumbnailPrefetch } from "./thumbnailPrefetch";
  import { createGalleryStore, type GalleryBrowseState } from "./state";
  import Viewer from "./Viewer.svelte";
  import "./gallery.css";

  let { api, active = true, onReviewCreated }: { api: ApiClient; active?: boolean; onReviewCreated?: (reviewId: string) => void } = $props();

  const runtime = untrack(() => {
    const store = createGalleryStore();
    const service = createGalleryService(api);
    return { store, service, controller: createGalleryController({ store, service }) };
  });
  const { store, service, controller } = runtime;
  const snapshot: GalleryBrowseState = $derived($store);

  let galleryRoot = $state<HTMLElement>();
  // ---- 虚拟化窗口状态（滚动驱动，非 store 事务） ----
  let contentScroll = $state(0);
  let contentHeight = $state(0);
  let gridColumns = $state(4);
  let contentViewport: HTMLElement | null = $state(null);
  let viewerWasOpen = $state(false);
  let viewerReturnAssetId = $state("");
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

  const activeSource = $derived(
    snapshot.sources.find((item) => item.source_id === snapshot.activeSourceId) ?? null,
  );
  const activeScan = $derived(
    snapshot.scanOperation?.source_id === snapshot.activeSourceId ? snapshot.scanOperation : null,
  );
  const txtStateOptions: readonly { value: string; label: string }[] = [
    { value: "", label: "全部 TXT 状态" },
    ...(Object.keys(GALLERY_TXT_STATE_LABELS) as GalleryTxtState[]).map((state) => ({
      value: state,
      label: GALLERY_TXT_STATE_LABELS[state],
    })),
  ];

  let searchDraft = $state("");
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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
  const allVisibleItemsSelected = $derived(
    (snapshot.directories.length > 0 || snapshot.assets.length > 0)
      && snapshot.directories.every((directory) => selectedDirectoryIds.has(directory.directory_id))
      && snapshot.assets.every((asset) => selectedIds.has(asset.asset_id)),
  );
  function toggleSelectAll(event: Event): void {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    if (!checked) {
      clearVisibleSelection();
      return;
    }
    const sourceLabel = activeSource?.display_name ?? "来源";
    for (const directory of snapshot.directories) rememberDirectorySelection(exportSelection(directory, sourceLabel));
    controller.selectAllAssets();
  }
  const currentAsset = $derived(
    snapshot.viewerAssets[snapshot.viewerIndex] ?? null,
  );
  $effect(() => {
    const isOpen = snapshot.viewerIndex >= 0;
    if (isOpen) {
      viewerWasOpen = true;
      return;
    }
    if (!viewerWasOpen) return;

    viewerWasOpen = false;
    const returnAssetId = viewerReturnAssetId;
    const scrollTop = snapshot.pendingGridScrollTop;
    void tick().then(() => {
      if (contentViewport !== null) contentViewport.scrollTop = scrollTop;
      const preferred = returnAssetId.length > 0
        ? document.querySelector<HTMLElement>(`[data-gallery-asset="${CSS.escape(returnAssetId)}"]`)
        : null;
      const fallback = contentViewport?.querySelector<HTMLElement>("[data-gallery-asset]") ?? contentViewport;
      restoreFocus(preferred ?? fallback);
    });
  });
  let failedThumbnailIds = $state(new Set<string>());

  function markThumbnailFailed(assetId: string): void {
    failedThumbnailIds = new Set(failedThumbnailIds).add(assetId);
  }

  function onAssetClick(event: MouseEvent, asset: GalleryAssetEntry): void {
    controller.clickAsset(asset.asset_id, {
      additive: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
    });
  }

  function onAssetActivate(asset: GalleryAssetEntry): void {
    viewerReturnAssetId = asset.asset_id;
    store.patch({ pendingGridScrollTop: contentViewport?.scrollTop ?? contentScroll });
    controller.openViewer(asset.asset_id);
  }

  // ---- G3-3 文件操作 ----
  let renameDraft = $state("");

  let selectedTrashOperationIds = $state<string[]>([]);
  let trashBulkBusy = $state(false);
  let trashBulkPurgeConfirm = $state<"selected" | "all" | null>(null);
  const singleSelectedAsset = $derived(
    snapshot.selectedAssetIds.length === 1 ? snapshot.assets.find((item) => item.asset_id === snapshot.selectedAssetIds[0]) ?? null : null,
  );

  function requestDeleteSelection(): void {
    if (!snapshot.selectedAssetIds.length && !selectedVisibleDirectoryIds.length) return;
    controller.requestTrashSelection(
      snapshot.selectedAssetIds,
      selectedVisibleDirectoryIds,
    );
  }

  async function confirmTrashSelection(): Promise<void> {
    const succeeded = await controller.confirmTrashSelection();
    if (succeeded) clearDirectorySelections();
  }

  function requestRenameSelection(): void {
    if (singleSelectedAsset === null) return;
    const dot = singleSelectedAsset.name.lastIndexOf(".");
    renameDraft = dot > 0 ? singleSelectedAsset.name.slice(0, dot) : singleSelectedAsset.name;
    controller.openRenameDialog(singleSelectedAsset.asset_id);
  }

  const selectedTrashOperations = $derived(
    snapshot.trashOperations.filter((operation) => selectedTrashOperationIds.includes(operation.operation_id)),
  );

  function toggleTrashOperation(operationId: string, checked: boolean): void {
    trashBulkPurgeConfirm = null;
    selectedTrashOperationIds = checked
      ? [...selectedTrashOperationIds, operationId]
      : selectedTrashOperationIds.filter((item) => item !== operationId);
  }

  function toggleTrashPanel(): void {
    if (snapshot.trashPanelPhase === "closed") {
      selectedTrashOperationIds = [];
      trashBulkPurgeConfirm = null;
      void controller.openTrashPanel();
    } else {
      closeTrashPanel();
    }
  }

  function closeTrashPanel(): void {
    if (trashBulkBusy) return;
    selectedTrashOperationIds = [];
    trashBulkPurgeConfirm = null;
    controller.closeTrashPanel();
  }

  async function restoreSelectedTrash(): Promise<void> {
    if (trashBulkBusy || selectedTrashOperations.length === 0) return;
    trashBulkBusy = true;
    const pending = [...selectedTrashOperationIds];
    for (const operationId of pending) {
      if (!(await controller.restoreTrashOperation(operationId))) break;
      selectedTrashOperationIds = selectedTrashOperationIds.filter((item) => item !== operationId);
    }
    trashBulkBusy = false;
  }

  async function purgeSelectedTrash(): Promise<void> {
    if (trashBulkBusy || selectedTrashOperations.length === 0) return;
    trashBulkBusy = true;
    const pending = [...selectedTrashOperationIds];
    for (const operationId of pending) {
      if (!(await controller.purgeTrashOperation(operationId))) break;
      selectedTrashOperationIds = selectedTrashOperationIds.filter((item) => item !== operationId);
    }
    trashBulkBusy = false;
    trashBulkPurgeConfirm = null;
  }

  async function purgeAllTrash(): Promise<void> {
    if (trashBulkBusy || snapshot.trashOperations.length === 0) return;
    trashBulkBusy = true;
    if (await controller.purgeAllTrashOperations()) selectedTrashOperationIds = [];
    trashBulkBusy = false;
    trashBulkPurgeConfirm = null;
  }

  async function restoreSingleTrash(operationId: string): Promise<void> {
    if (await controller.restoreTrashOperation(operationId)) {
      selectedTrashOperationIds = selectedTrashOperationIds.filter((item) => item !== operationId);
    }
  }

  function requestSingleTrashPurge(operationId: string): void {
    selectedTrashOperationIds = [operationId];
    trashBulkPurgeConfirm = "selected";
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


  function onCardKeydown(event: KeyboardEvent, asset: GalleryAssetEntry): void {
    if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onAssetActivate(asset);
    }
  }

  function closeViewer(): void {
    controller.closeViewer();
  }

  function clearSearchDebounce(): void {
    if (searchDebounceTimer !== null) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  }

  function scheduleSearch(value: string): void {
    searchDraft = value;
    clearSearchDebounce();
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      if (searchDraft.trim() !== snapshot.query) void controller.submitQuery(searchDraft);
    }, 350);
  }

  function submitSearch(event: SubmitEvent): void {
    event.preventDefault();
    clearSearchDebounce();
    void controller.submitQuery(searchDraft);
  }

  function clearSearch(): void {
    clearSearchDebounce();
    searchDraft = "";
    void controller.submitQuery("");
  }

  function txtBadge(asset: GalleryAssetEntry): string {
    return GALLERY_TXT_STATE_LABELS[asset.txt_state];
  }


  function assetSourceLabel(asset: GalleryAssetEntry): string {
    return snapshot.sources.find((source) => source.source_id === asset.source_id)?.display_name ?? asset.source_id ?? "未知来源";
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

  function requestSourceRemoval(source: GalleryBrowseState["sources"][number]): void {
    if (batchDeleteSourceId !== null) return;
    const isBatch = source.kind === "crawl_batch";
    const message = isBatch
      ? "删除批次会递归删除批次下所有文件。\n\n确定删除这个批次吗？"
      : `解除导入目录“${source.display_name}”？\n\n只会移除 LDOS 的来源索引，不会删除原目录中的任何文件。`;
    if (!window.confirm(translateCurrentUiText(message))) return;
    batchDeleteError = null;
    batchDeleteSourceId = source.source_id;
    const request = isBatch
      ? controller.deleteBatchSource(source.source_id)
      : controller.unmountSource(source.source_id);
    void request.then((succeeded) => {
      if (!succeeded) {
        batchDeleteError = isBatch
          ? snapshot.sourcesErrorCode ?? "batch_delete_failed"
          : snapshot.scanRequestErrorCode ?? "source_unmount_failed";
      } else {
        clearDirectorySelections();
      }
    }).finally(() => {
      if (batchDeleteSourceId === source.source_id) batchDeleteSourceId = null;
    });
  }

  const platform = untrack(() => createPlatformAdapter());
  let platformDirectoryPickerActive = false;
  let platformDirectoryPickerReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  async function selectPlatformDirectory(
    purpose: PlatformDirectoryPurpose,
  ): Promise<string | null> {
    if (platformDirectoryPickerReleaseTimer !== null) {
      clearTimeout(platformDirectoryPickerReleaseTimer);
      platformDirectoryPickerReleaseTimer = null;
    }
    platformDirectoryPickerActive = true;
    try {
      return await platform.selectDirectory(purpose);
    } finally {
      platformDirectoryPickerReleaseTimer = setTimeout(() => {
        platformDirectoryPickerActive = false;
        platformDirectoryPickerReleaseTimer = null;
      }, 0);
    }
  }
  let importPhase: "idle" | "picking" | "importing" = $state("idle");
  let importError: string | null = $state(null);

  const canImportDirectories = $derived(platform.capabilities.selectDirectory);

  let importWarningOpen = $state(false);
  let sourceManagerOpen = $state(false);
  let sourceManagerName = $state("");
  let sourceManagerPhase: "idle" | "saving" | "relinking" | "unmounting" = $state("idle");
  let sourceManagerError = $state<string | null>(null);
  let batchDeleteSourceId = $state<string | null>(null);
  let batchDeleteError = $state<string | null>(null);
  let importWarningPanel = $state<HTMLElement>();
  let importWarningReturnFocus: FocusTarget | null = null;
  let sourceManagerPanel = $state<HTMLElement>();
  let sourceManagerReturnFocus: FocusTarget | null = null;

  function modalFocusable(panel: HTMLElement | undefined): HTMLElement[] {
    return [
      ...(panel?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
  }

  function focusModal(panel: () => HTMLElement | undefined): void {
    void tick().then(() => {
      const element = panel();
      restoreFocus(modalFocusable(element)[0] ?? element);
    });
  }

  function onModalKeydown(event: KeyboardEvent, panel: HTMLElement | undefined): void {
    if (event.key !== "Tab") return;
    const items = modalFocusable(panel);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = trappedTabIndex(current, items.length, event.shiftKey);
    if (next !== null) {
      event.preventDefault();
      restoreFocus(items[next]);
    }
  }

  function restoreDialogFocus(target: FocusTarget | null): void {
    queueMicrotask(() => {
      if (restoreFocus(target)) return;
      restoreFocus(document.querySelector<HTMLElement>("[data-gallery-import]"));
    });
  }

  function closeImportWarning(): void {
    const target = importWarningReturnFocus;
    importWarningOpen = false;
    importWarningReturnFocus = null;
    restoreDialogFocus(target);
  }

  function closeSourceManager(): void {
    if (sourceManagerPhase !== "idle") return;
    const target = sourceManagerReturnFocus;
    sourceManagerOpen = false;
    sourceManagerReturnFocus = null;
    restoreDialogFocus(target);
  }

  function requestImportDirectory(): void {
    if (!canImportDirectories || importPhase !== "idle") return;
    importWarningReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    importWarningOpen = true;
    focusModal(() => importWarningPanel);
  }

  function openSourceManager(): void {
    if (activeSource === null) return;
    sourceManagerReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sourceManagerName = activeSource.display_name;
    sourceManagerError = null;
    sourceManagerPhase = "idle";
    sourceManagerOpen = true;
    focusModal(() => sourceManagerPanel);
  }

  async function saveSourceName(): Promise<void> {
    if (sourceManagerPhase !== "idle") return;
    sourceManagerPhase = "saving";
    sourceManagerError = null;
    const succeeded = await controller.renameActiveSource(sourceManagerName);
    sourceManagerPhase = "idle";
    if (succeeded) closeSourceManager();
    else sourceManagerError = snapshot.scanRequestErrorCode ?? "source_rename_failed";
  }

  async function relinkActiveSource(): Promise<void> {
    if (
      sourceManagerPhase !== "idle" ||
      !canImportDirectories ||
      activeScan?.state === "running"
    ) return;
    sourceManagerPhase = "relinking";
    sourceManagerError = null;
    let succeeded = false;
    try {
      const rootPath = await selectPlatformDirectory("gallery_relink");
      if (rootPath === null) return;
      succeeded = await controller.relinkActiveSource(rootPath);
      if (!succeeded) {
        sourceManagerError = snapshot.scanRequestErrorCode ?? "source_relink_failed";
      }
    } catch {
      sourceManagerError = "source_relink_failed";
    } finally {
      sourceManagerPhase = "idle";
      if (succeeded) closeSourceManager();
    }
  }

  async function unmountActiveSource(): Promise<void> {
    if (sourceManagerPhase !== "idle" || activeScan?.state === "running") return;
    sourceManagerPhase = "unmounting";
    sourceManagerError = null;
    const succeeded = await controller.unmountActiveSource();
    sourceManagerPhase = "idle";
    if (succeeded) closeSourceManager();
    else sourceManagerError = snapshot.scanRequestErrorCode ?? "source_unmount_failed";
  }
  async function importDirectoryFlow(): Promise<void> {
    if (importPhase !== "idle" || !platform.capabilities.selectDirectory) return;
    const returnFocus = importWarningReturnFocus;
    importWarningOpen = false;
    importError = null;
    importPhase = "picking";
    try {
      const rootPath = await selectPlatformDirectory("gallery_import");
      if (rootPath === null) {
        importPhase = "idle";
        return;
      }
      importPhase = "importing";
      const imported = await controller.importDirectory(rootPath);
      if (!imported) importError = snapshot.sourcesErrorCode ?? "import_failed";
    } catch (error) {
      importError = error instanceof Error ? error.message : "import_failed";
    } finally {
      importPhase = "idle";
      importWarningReturnFocus = null;
      restoreDialogFocus(returnFocus);
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
  // ---- 统一、显式的目录/图片选择 ----
  let selectedDirectorySelections = $state<DirectoryExportSelection[]>([]);
  const selectedDirectoryIds = $derived(
    new Set(selectedDirectorySelections.map((selection) => selection.directoryId)),
  );
  const selectedVisibleDirectoryIds = $derived(
    snapshot.directories.filter((directory) => selectedDirectoryIds.has(directory.directory_id)).map((directory) => directory.directory_id),
  );
  const selectedItemCount = $derived(
    snapshot.selectedAssetIds.length + selectedDirectorySelections.length,
  );

  function rememberDirectorySelection(selection: DirectoryExportSelection): void {
    if (selectedDirectoryIds.has(selection.directoryId)) return;
    selectedDirectorySelections = [...selectedDirectorySelections, selection];
  }

  function toggleDirectorySelection(
    directory: GalleryDirectoryEntry,
    sourceLabel: string,
  ): void {
    const selection = exportSelection(directory, sourceLabel);
    if (selectedDirectoryIds.has(selection.directoryId)) {
      selectedDirectorySelections = selectedDirectorySelections.filter(
        (item) => item.directoryId !== selection.directoryId,
      );
      directoryExportSelections = directoryExportSelections.filter(
        (item) => item.directoryId !== selection.directoryId,
      );
      return;
    }
    rememberDirectorySelection(selection);
  }


  let selectionContextKey: string | null = null;

  function clearDirectorySelections(): void {
    selectedDirectorySelections = [];
    directoryExportSelections = [];
  }

  function resetBrowseSelection(): void {
    clearDirectorySelections();
    controller.clearAssetSelection();
  }

  $effect(() => {
    const nextSelectionContextKey = [
      snapshot.activeSourceId ?? "",
      snapshot.currentDirectory?.directory_id ?? "",
      snapshot.searchScope,
      snapshot.query,
      snapshot.includeDescendants ? "descendants" : "direct",
      snapshot.txtStateFilter ?? "",
      snapshot.directories.map((directory) => directory.directory_id).join(","),
      snapshot.assets.map((asset) => asset.asset_id).join(","),
    ].join("\u0000");
    if (selectionContextKey === nextSelectionContextKey) return;
    selectionContextKey = nextSelectionContextKey;
    controller.clearAssetSelection();
  });

  function clearVisibleSelection(): void {
    resetBrowseSelection();
  }

  function toggleAssetCheckbox(event: Event, asset: GalleryAssetEntry): void {
    event.stopPropagation();
    const shift = "shiftKey" in event && Boolean(event.shiftKey);
    controller.clickAsset(asset.asset_id, { additive: !shift, range: shift });
  }
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

  // Review has its own immutable submission scope; export edits never alter it.
  let reviewSelections = $state<DirectoryExportSelection[]>([]);
  let reviewConfirmOpen = $state(false);
  let reviewCreating = $state(false);
  let reviewCreateError = $state("");
  let reviewCreateRequest: AbortController | null = null;
  let reviewDialog = $state<HTMLDialogElement>();
  let reviewReturnFocus: FocusTarget | null = null;

  function openReviewConfirmation(scope: "selected" | "current" | "root"): void {
    if (reviewCreating) return;
    const current = currentDirectoryExportSelection();
    reviewSelections = scope === "selected" ? [...selectedDirectorySelections]
      : scope === "current" && current ? [current]
      : scope === "root" && activeSource?.root_directory_id ? [{ directoryId: activeSource.root_directory_id, directoryName: activeSource.display_name, sourceLabel: activeSource.display_name, relativePath: "来源根目录" }] : [];
    if (!reviewSelections.length) return;
    reviewReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reviewCreateError = "";
    reviewConfirmOpen = true;
  }

  function closeReviewConfirmation(): void {
    if (reviewCreating) return;
    reviewConfirmOpen = false;
    reviewDialog?.close();
    const target = reviewReturnFocus;
    reviewReturnFocus = null;
    void tick().then(() => restoreFocus(target));
  }

  function onReviewConfirmationKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") { event.preventDefault(); closeReviewConfirmation(); return; }
    if (event.key !== "Tab") return;
    const items = [...(reviewDialog?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
    const next = trappedTabIndex(items.indexOf(document.activeElement as HTMLElement), items.length, event.shiftKey);
    if (next !== null) { event.preventDefault(); restoreFocus(items[next]); }
  }

  $effect(() => {
    if (!reviewConfirmOpen || !active) return;
    void tick().then(() => {
      if (!reviewDialog?.open) reviewDialog?.showModal();
      restoreFocus(reviewDialog?.querySelector<HTMLElement>("button") ?? reviewDialog);
    });
  });

  async function createDirectoryReview(): Promise<void> {
    if (reviewCreating || !reviewSelections.length) return;
    reviewCreating = true;
    reviewCreateError = "";
    const request = new AbortController();
    reviewCreateRequest = request;
    try {
      const reviewId = await service.createReview(reviewSelections.map((item) => item.directoryId), request.signal);
      if (request.signal.aborted) return;
      reviewCreating = false;
      closeReviewConfirmation();
      onReviewCreated?.(reviewId);
    } catch (error) {
      if (!request.signal.aborted) reviewCreateError = `去重任务创建失败（${error instanceof ApiError ? error.code : "request_failed"}）；目录选区已保留，请刷新图库并重试。`;
    } finally {
      reviewCreating = false;
      if (reviewCreateRequest === request) reviewCreateRequest = null;
    }
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
    directoryExportSelections = selectedDirectorySelections.length > 0
      ? [...selectedDirectorySelections]
      : (() => {
          const current = currentDirectoryExportSelection();
          return current === null ? [] : [current];
        })();
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
    const selection = exportSelection(directory, sourceLabel);
    directoryExportSelections = [...directoryExportSelections, selection];
    rememberDirectorySelection(selection);

  }

  function removeDirectoryExportSelection(directoryId: string): void {
    if (directoryExportBusy) return;
    directoryExportSelections = directoryExportSelections.filter(
      (item) => item.directoryId !== directoryId,
    );
    selectedDirectorySelections = selectedDirectorySelections.filter(
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
      const picked = await selectPlatformDirectory("export_target");
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
    galleryMounted = true;
    return () => {
      reviewCreateRequest?.abort();
      const activeExport = directoryExportOperation;
      clearDirectoryExportPolling();
      clearSearchDebounce();
      directoryExportPickerAbort?.abort();
      if (platformDirectoryPickerReleaseTimer !== null) {
        clearTimeout(platformDirectoryPickerReleaseTimer);
        platformDirectoryPickerReleaseTimer = null;
      }
      platformDirectoryPickerActive = false;
      if (activeExport?.state === "copying") {
        void service.cancelDirectoryExport(activeExport.operation_id);
      }
      controller.destroy();
    };
  });

  $effect(() => {
    // 预热当前已加载页的缩略图：主网格 512、目录封面 256（低并发队列）。
    const assetUrls = snapshot.assets.map((asset) => service.thumbnailUrl(asset.asset_id, 512));
    const coverUrls = snapshot.directories.flatMap((directory) =>
      directory.cover_asset_ids.slice(0, 4).map((coverId) => service.thumbnailUrl(coverId, 256)),
    );
    enqueueThumbnailPrefetch([...coverUrls, ...assetUrls]);
  });

  let galleryMounted = $state(false);
  let galleryActivationSeen = false;
  let galleryWasActive = false;
  let galleryRefreshNotice = $state("");
  $effect(() => {
    if (!galleryMounted) return;
    const nowActive = active;
    untrack(() => {
      if (nowActive && galleryActivationSeen && !galleryWasActive) {
        galleryRefreshNotice = snapshot.txtDraft !== null && snapshot.txtDraft !== (snapshot.viewerAnnotation?.content ?? "")
          ? "正在刷新图库；打开的 TXT 草稿保持不变。若文件已移动，请先保存草稿或关闭查看器后再打开。" : "";
        void controller.reconcileOnFocus();
      }
      if (!nowActive) reviewDialog?.close();
      galleryWasActive = nowActive;
      galleryActivationSeen = true;
    });
  });
  function onWindowFocus(): void {
    if (
      !active || reviewConfirmOpen ||
      platformDirectoryPickerActive ||
      importWarningOpen ||
      sourceManagerOpen ||
      directoryExportOpen ||
      snapshot.renameDialogPhase !== "closed" ||
      snapshot.trashConfirmPhase !== "closed" ||
      snapshot.trashPanelPhase !== "closed"
    ) return;
    void controller.reconcileOnFocus();
  }

  /** 应用级快捷键：对话框/面板 Escape + 网格 Delete/Ctrl+A/F2（查看器打开时让位）。 */
  function onAppKeydown(event: KeyboardEvent): void {
    if (!active || reviewConfirmOpen || event.defaultPrevented || galleryRoot?.closest("[hidden], [inert]")) return;
    if (snapshot.viewerIndex >= 0) return;
    if (importWarningOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeImportWarning();
      }
      return;
    }
    if (sourceManagerOpen) {
      if (event.key === "Escape" && sourceManagerPhase === "idle") {
        event.preventDefault();
        closeSourceManager();
      }
      return;
    }
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
        else if (trashBulkPurgeConfirm !== null) trashBulkPurgeConfirm = null;
        else closeTrashPanel();
      }
      return;
    }
    onGridKeydown(event);
  }
</script>


{#if reviewConfirmOpen}
  <dialog class="gallery-dialog gallery-review-confirmation" bind:this={reviewDialog} data-gallery-review-confirmation aria-labelledby="gallery-review-title" onkeydown={onReviewConfirmationKeydown} oncancel={(event) => { event.preventDefault(); closeReviewConfirmation(); }}>
    <h2 id="gallery-review-title">对这些目录发起去重？</h2>
    <ul>{#each reviewSelections as directory (directory.directoryId)}<li>{directory.sourceLabel} / {directory.relativePath || directory.directoryName}</li>{/each}</ul>
    <p>包含各目录的子目录；选区作为一个集合跨目录比较，重叠目录只处理一次。单张图片选区不参与。</p>
    <p>机器初筛会先把明确重复的图片与同名 TXT 移入回收区；疑似重复项随后人工审核。可在回收区恢复，彻底删除不可撤销。</p>
    {#if reviewCreateError}<p class="gallery-dialog__error" role="alert">{reviewCreateError}</p>{/if}
    <div class="gallery-dialog__actions"><button type="button" disabled={reviewCreating} onclick={closeReviewConfirmation}>取消</button><button type="button" disabled={reviewCreating} onclick={() => void createDirectoryReview()}>{reviewCreating ? "正在发起…" : "确认发起去重"}</button></div>
  </dialog>
{/if}
<svelte:window
  onkeydown={onAppKeydown}
  onfocus={onWindowFocus}
/>

<section class="gallery-app" data-gallery-app data-domain-owner="gallery" data-preview-availability="live" aria-labelledby="gallery-heading" bind:this={galleryRoot}>
  <header class="gallery-header" inert={snapshot.viewerIndex >= 0 ? true : undefined} aria-hidden={snapshot.viewerIndex >= 0 ? "true" : undefined}>
    <h1 id="gallery-heading">图库</h1>
    <span class="gallery-status" data-kind={snapshot.sourcesPhase}>{snapshot.sourcesPhase === "ready" ? `${formatCount(snapshot.sources.length)} 个来源` : snapshot.sourcesPhase === "error" ? "来源加载失败" : "正在加载来源"}</span>
  </header>

  <div class="gallery-body" inert={snapshot.viewerIndex >= 0 ? true : undefined} aria-hidden={snapshot.viewerIndex >= 0 ? "true" : undefined}>
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
              <div class="gallery-source-card gallery-source-card--deletable">
                <button
                  type="button"
                  class="gallery-source"
                  aria-current={snapshot.activeSourceId === source.source_id ? "true" : undefined}
                  onclick={() => void controller.openSource(source.source_id)}
                >
                  <span class="gallery-source__name">{source.display_name}</span>
                  <span class="gallery-source__meta">{sourceSubtitle(source)}</span>
                  <span class="gallery-source__count">
                    {#if source.dedup_required}
                      候选 {formatCount(source.candidate_count)} · 保留 {formatCount(source.kept_count)} · 已移除 {formatCount(source.removed_count)}
                    {:else}
                      {formatCount(source.asset_count)} 张图片
                    {/if}
                    {source.root_directory_id === null ? " · 待扫描" : ""}
                  </span>
                </button>
                {#if source.kind === "crawl_batch" || source.kind === "imported"}
                  <button
                    type="button"
                    class="gallery-source__delete"
                    aria-label={source.kind === "crawl_batch" ? `删除批次 ${source.display_name}` : `解除挂载 ${source.display_name}`}
                    title={source.kind === "crawl_batch" ? "删除批次" : "解除挂载（保留原文件）"}
                    disabled={batchDeleteSourceId !== null}
                    onclick={(event) => { event.stopPropagation(); requestSourceRemoval(source); }}
                  >
                    {batchDeleteSourceId === source.source_id ? "…" : "×"}
                  </button>
                {/if}
              </div>
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
        {#if batchDeleteError !== null}
          <p class="gallery-hint gallery-hint--error" role="alert">来源操作失败（{batchDeleteError}）</p>
        {/if}
      {/if}
      <div class="gallery-import">
        <button data-gallery-import type="button" onclick={requestImportDirectory} disabled={!canImportDirectories || importPhase !== "idle"}>
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

    <section class="gallery-content" aria-labelledby="gallery-content-heading">
      <h2 id="gallery-content-heading" class="gallery-visually-hidden">目录内容</h2>
      {#if snapshot.activeSourceId === null}
        <div class="gallery-empty" role="status">
          <strong>选择一个来源开始浏览</strong>
          <p>左侧选择下载批次或导入目录；这里会显示目录树和图片网格。</p>
        </div>
      {:else}
        {#if activeSource !== null}
          <section class="gallery-source-status" aria-label="当前来源状态">
            <div class="gallery-source-status__heading">
              <div>
                <span>{sourceSubtitle(activeSource)}</span>
              </div>
              <div class="gallery-source-status__actions">
                <button
                  type="button"
                  disabled={activeScan?.state === "running"}
                  onclick={() => void controller.rescanActiveSource()}
                >{activeScan?.state === "running" ? "正在扫描…" : "重新扫描"}</button>
                <button type="button" onclick={openSourceManager}>来源设置…</button>
              </div>
            </div>
            {#if activeSource.kind === "imported"}
              <p class="gallery-source-warning">
                此来源直接管理原目录。重命名、保存 TXT 和移入回收区都会修改磁盘上的原文件。
              </p>
            {/if}
            {#if activeSource.dedup_required}
              <dl class="gallery-source-stats" aria-label="去重统计">
                <div><dt>候选</dt><dd>{formatCount(activeSource.candidate_count)}</dd></div>
                <div><dt>保留</dt><dd>{formatCount(activeSource.kept_count)}</dd></div>
                <div><dt>已移除</dt><dd>{formatCount(activeSource.removed_count)}</dd></div>
              </dl>
            {/if}
            {#if activeScan?.state === "running"}
              <p class="gallery-source-progress" role="status">正在增量检查；当前索引仍可浏览。</p>
            {:else if activeScan?.state === "failed"}
              <p class="gallery-hint gallery-hint--error" role="alert">扫描失败（{activeScan.error_code}）；原有索引已保留。</p>
            {:else if activeScan?.state === "succeeded" && activeScan.stats !== null}
              {#if activeScan.stats.offline}
                <p class="gallery-source-progress" role="status">来源目录当前不可用；已有索引已保留，请在来源设置中重新关联目录。</p>
              {:else}
                <p class="gallery-source-progress" role="status">
                  扫描完成：{formatCount(activeScan.stats.asset_count)} 张可见图片，跳过 {formatCount(activeScan.stats.skipped_unsupported + activeScan.stats.skipped_temporary)} 个文件。
                </p>
              {/if}
            {/if}
            {#if activeSource.reconciliation_state === "failed"}
              <div class="gallery-source-reconciliation" role="alert">
                <span>审核结果已保存，但图库去重对账失败；被排除文件会继续保持隐藏。</span>
                <button
                  type="button"
                  disabled={snapshot.reconciliationRetrySourceId === activeSource.source_id}
                  onclick={() => void controller.retryActiveReconciliation()}
                >{snapshot.reconciliationRetrySourceId === activeSource.source_id ? "正在重试…" : "重试对账"}</button>
              </div>
            {/if}
            {#if snapshot.scanRequestErrorCode !== null}
              <p class="gallery-hint gallery-hint--error" role="alert">来源操作失败（{snapshot.scanRequestErrorCode}）</p>
            {/if}
          </section>
        {/if}
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
              value={searchDraft}
              oninput={(event) => scheduleSearch((event.currentTarget as HTMLInputElement).value)}
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
                <option value="library">整个图库</option>
              </select>
            </label>
            <label>
              <span>包含子目录</span>
              <input
                type="checkbox"
                checked={snapshot.includeDescendants}
                disabled={snapshot.searchScope !== "directory"}
                onchange={(event) => void controller.setIncludeDescendants((event.currentTarget as HTMLInputElement).checked)}
              />
            </label>
            {#if snapshot.currentDirectory !== null && activeSource !== null}
              <label class="gallery-selection-control gallery-select-all">
                <input
                  type="checkbox"
                  checked={allVisibleItemsSelected}
                  disabled={snapshot.assets.length === 0 && snapshot.directories.length === 0}
                  aria-label="全选"
                  onchange={toggleSelectAll}
                />
                <span>全选</span>
              </label>
            {/if}
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
            {#if selectedItemCount > 0}
              <span class="gallery-toolbar-selection" data-gallery-selection-summary>
                {#if selectedDirectorySelections.length > 0}{formatCount(selectedDirectorySelections.length)} 个目录{/if}
                {#if selectedDirectorySelections.length > 0 && snapshot.selectedAssetIds.length > 0} · {/if}
                {#if snapshot.selectedAssetIds.length > 0}{formatCount(snapshot.selectedAssetIds.length)} 张图片{/if} 已选
              </span>
              <button type="button" onclick={clearVisibleSelection}>清除选择</button>
              {#if snapshot.selectedAssetIds.length > 0}
                <button type="button" onclick={requestRenameSelection} disabled={singleSelectedAsset === null}>重命名…</button>
              {/if}
              <button type="button" class="gallery-toolbar-danger" title="只删除当前目录中已选择的项目；跨目录选区仅用于去重或导出。" disabled={!snapshot.selectedAssetIds.length && !selectedVisibleDirectoryIds.length} onclick={requestDeleteSelection}>删除…</button>
            {/if}
            <button
              type="button"
              aria-pressed={snapshot.trashPanelPhase !== "closed"}
              onclick={toggleTrashPanel}
            >回收区</button>
            <button type="button" data-gallery-dedup="selected" disabled={reviewCreating || !selectedDirectorySelections.length} onclick={() => openReviewConfirmation("selected")}>去重所选目录…</button>
            <button type="button" data-gallery-dedup="current" disabled={reviewCreating || !snapshot.currentDirectory} onclick={() => openReviewConfirmation("current")}>去重当前目录…</button>
            <button type="button" data-gallery-dedup="root" disabled={reviewCreating || !activeSource?.root_directory_id} onclick={() => openReviewConfirmation("root")}>去重来源根目录…</button>
            <button
              type="button"
              class="gallery-toolbar-export"
              onclick={openDirectoryExport}
              disabled={snapshot.currentDirectory === null && selectedDirectorySelections.length === 0}
            >导出目录…</button>
          </div>
        </nav>
        {#if galleryRefreshNotice}<p class="gallery-hint" role="status" data-gallery-refresh-notice>{galleryRefreshNotice}</p>{/if}
        {#if snapshot.query.length > 0}
          <p class="gallery-search-summary" role="status">
            “{snapshot.query}” · {snapshot.searchScope === "directory" ? "当前目录" : snapshot.searchScope === "source" ? "整个来源" : "整个图库"} · 已载入 {formatCount(snapshot.assets.length)} 项
          </p>
        {/if}

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
                <li class:selected={selectedDirectoryIds.has(directory.directory_id)}>
                  <div class="gallery-folder-shell">
                    <label class="gallery-selection-control gallery-folder__select">
                      <input
                        type="checkbox"
                        checked={selectedDirectoryIds.has(directory.directory_id)}
                        aria-label={`选择目录 ${directoryLabel(directory)}`}
                        onclick={(event) => event.stopPropagation()}
                        onchange={() => toggleDirectorySelection(directory, activeSource?.display_name ?? "来源")}
                      />
                      <span>选择目录</span>
                    </label>
                    <button type="button" class="gallery-folder" onclick={() => void controller.openDirectory(directory.directory_id)}>
                      <span class="gallery-folder__cover" data-count={Math.min(directory.recursive_asset_count, 4)} aria-hidden="true">
                        {#each directory.cover_asset_ids.slice(0, 4) as coverId (coverId)}
                          <img src={service.thumbnailUrl(coverId, 256)} alt="" crossorigin="anonymous" loading="lazy" decoding="async" />
                        {/each}
                      </span>
                      <span class="gallery-folder__name">{directoryLabel(directory)}</span>
                      <span class="gallery-folder__meta">{formatCount(directory.recursive_asset_count)} 张 · {formatCount(directory.direct_asset_count)} 张直属</span>
                    </button>
                  </div>
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
                bind:this={contentViewport}
                tabindex="-1"
                aria-label="图片网格"
                onscroll={onContentScroll}
                use:resizeObserver={{ onContentResize }}
              >
                <div class="gallery-grid" style={`grid-template-columns: repeat(${gridColumns}, minmax(0, 1fr)); height: ${windowing.totalHeight}px;`}>
                  <div class="gallery-grid-window" style={`transform: translateY(${windowing.startOffsetY}px);`}>
                    {#each visibleAssets as asset (asset.asset_id)}
                      <div class="gallery-card-shell" class:selected={selectedIds.has(asset.asset_id)}>
                        <label class="gallery-selection-control gallery-card__select">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(asset.asset_id)}
                            aria-label={`选择图片 ${asset.name}`}
                            onclick={(event) => event.stopPropagation()}
                            onkeydown={(event) => event.stopPropagation()}
                            onchange={(event) => toggleAssetCheckbox(event, asset)}
                          />
                          <span>选择图片</span>
                        </label>
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
                          onfocus={() => (viewerReturnAssetId = asset.asset_id)}
                        >
                          <span class="gallery-card__media">
                            {#if failedThumbnailIds.has(asset.asset_id)}
                              <span class="gallery-thumbnail-fallback" role="img" aria-label={`${asset.name} 缩略图不可读`}>无法预览</span>
                            {:else}
                              <img src={service.thumbnailUrl(asset.asset_id, 512)} alt={asset.name} crossorigin="anonymous" loading="lazy" decoding="async" onerror={() => markThumbnailFailed(asset.asset_id)} />
                            {/if}
                          </span>
                          <span class="gallery-card__name">{asset.name}</span>
                          {#if snapshot.query.length > 0}
                            <span class="gallery-card__context">{assetSourceLabel(asset)} · {asset.relative_path}</span>
                          {/if}
                          <span class="gallery-card__badges">
                            <span class="gallery-badge" data-kind={txtBadgeKind(asset)}>{txtBadge(asset)}</span>
                            {#if asset.dedup_visibility === "candidate"}<span class="gallery-badge" data-kind="warn">待去重</span>{/if}
                            {#if asset.dedup_visibility === "excluded"}<span class="gallery-badge" data-kind="muted">已排除</span>{/if}
                          </span>
                        </button>
                      </div>
                    {/each}
                  </div>
                </div>
              </div>
            {:else}
              <div
                class="gallery-list-scroll"
                bind:this={contentViewport}
                tabindex="-1"
                aria-label="图片列表"
                onscroll={onContentScroll}
                use:resizeObserver={{ onContentResize }}
              >
                <div class="gallery-list" role="table" aria-label="当前目录图片明细">
                  <div class="gallery-list-head" role="row">
                    <span role="columnheader">选择</span>
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
                          onfocus={() => (viewerReturnAssetId = asset.asset_id)}
                        >
                          <span class="gallery-list-row__select-cell" role="cell">
                            <label class="gallery-selection-control gallery-list-row__select">
                              <input
                                type="checkbox"
                                checked={selectedIds.has(asset.asset_id)}
                                aria-label={`选择图片 ${asset.name}`}
                                onclick={(event) => event.stopPropagation()}
                                onkeydown={(event) => event.stopPropagation()}
                                onchange={(event) => toggleAssetCheckbox(event, asset)}
                              />
                              <span>选择图片</span>
                            </label>
                          </span>
                          <span class="gallery-list-row__thumb" role="cell">
                            {#if failedThumbnailIds.has(asset.asset_id)}
                              <span class="gallery-thumbnail-fallback" role="img" aria-label={`${asset.name} 缩略图不可读`}>!</span>
                            {:else}
                              <img src={service.thumbnailUrl(asset.asset_id, 256)} alt="" crossorigin="anonymous" loading="lazy" decoding="async" onerror={() => markThumbnailFailed(asset.asset_id)} />
                            {/if}
                          </span>
                          <span class="gallery-list-row__name" role="cell">{asset.name}{#if asset.dedup_visibility === "candidate"}<span class="gallery-list-row__candidate"> · 待去重</span>{/if}</span>
                          <span class="gallery-list-row__path" role="cell">{snapshot.query.length > 0 ? `${assetSourceLabel(asset)} · ${asset.relative_path}` : asset.relative_path}</span>
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
    </section>
  </div>
</section>

{#if importWarningOpen}
  <div class="gallery-dialog-backdrop">
    <div
      class="gallery-source-dialog"
      tabindex="-1"
      bind:this={importWarningPanel}
      onkeydown={(event) => onModalKeydown(event, importWarningPanel)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="gallery-import-warning-title"
    >
      <p class="gallery-source-dialog__eyebrow">原地导入</p>
      <h2 id="gallery-import-warning-title">导入后会管理原目录文件</h2>
      <p>LDOS 不会复制所选目录。之后的 TXT 保存、重命名和删除会直接修改该目录；删除会移入目录内的 LDOS 回收区。</p>
      <p>解除挂载只移除图库索引，不会删除任何源文件。</p>
      <div class="gallery-source-dialog__actions">
        <button type="button" onclick={closeImportWarning}>取消</button>
        <button type="button" class="gallery-dialog-primary" onclick={() => void importDirectoryFlow()}>理解并选择目录</button>
      </div>
    </div>
  </div>
{/if}

{#if sourceManagerOpen && activeSource !== null}
  <div class="gallery-dialog-backdrop">
    <div
      class="gallery-source-dialog"
      tabindex="-1"
      bind:this={sourceManagerPanel}
      onkeydown={(event) => onModalKeydown(event, sourceManagerPanel)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="gallery-source-manager-title"
    >
      <h2 id="gallery-source-manager-title">管理“{activeSource.display_name}”</h2>
      <form onsubmit={(event) => { event.preventDefault(); void saveSourceName(); }}>
        <label>
          <span>显示名称</span>
          <input maxlength="256" bind:value={sourceManagerName} disabled={sourceManagerPhase !== "idle"} />
        </label>
        <button type="submit" disabled={sourceManagerPhase !== "idle" || sourceManagerName.trim().length === 0}>
          {sourceManagerPhase === "saving" ? "正在保存…" : "保存名称"}
        </button>
      </form>
      <div class="gallery-source-dialog__section">
        <h3>目录位置</h3>
        <p>来源移动、离线或路径变更后，可重新选择其当前目录。已有索引会保留到重新关联成功。</p>
        <button type="button" disabled={!canImportDirectories || sourceManagerPhase !== "idle" || activeScan?.state === "running"} onclick={() => void relinkActiveSource()}>
          {sourceManagerPhase === "relinking" ? "正在关联…" : "重新关联目录…"}
        </button>
      </div>
      <div class="gallery-source-dialog__section gallery-source-dialog__section--danger">
        <h3>解除挂载</h3>
        <p>只删除 LDOS 的来源索引；绝不删除目录中的图片、TXT 或回收区文件。</p>
        <button type="button" disabled={sourceManagerPhase !== "idle" || activeScan?.state === "running"} onclick={() => void unmountActiveSource()}>
          {sourceManagerPhase === "unmounting" ? "正在解除…" : "解除挂载（保留原文件）"}
        </button>
      </div>
      {#if sourceManagerError !== null}
        <p class="gallery-hint gallery-hint--error" role="alert">来源操作失败（{sourceManagerError}）</p>
      {/if}
      <div class="gallery-source-dialog__actions">
        <button type="button" disabled={sourceManagerPhase !== "idle"} onclick={closeSourceManager}>关闭</button>
      </div>
    </div>
  </div>
{/if}

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
  <Viewer
    {snapshot}
    {currentAsset}
    contentUrl={service.assetContentUrl}
    thumbnailUrl={service.thumbnailUrl}
    onMove={(delta) => void (delta > 0 ? controller.viewerNext() : controller.viewerPrevious())}
    onJump={(index) => void controller.viewerJump(index)}
    onClose={closeViewer}
    onSetTxtViewMode={(mode) => controller.setTxtViewMode(mode)}
    onSetTxtDraft={(draft) => controller.setTxtDraft(draft)}
    onSave={(advance) => void controller.saveTxtAnnotation({ advance })}
    onDiscard={() => controller.discardTxtDraft()}
    onTrash={() => void controller.trashViewerAsset()}
    onResolvePending={(decision) => void controller.resolveViewerPendingAction(decision)}
  />
{/if}

{#if snapshot.trashConfirmPhase !== "closed"}
  {@const imageCount = snapshot.trashConfirmAssetIds.length}
  {@const directoryCount = snapshot.trashConfirmDirectoryIds.length}
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
        将删除 <strong>{formatCount(directoryCount)}</strong> 个完整目录、<strong>{formatCount(imageCount)}</strong> 张图片、
        <strong>{formatCount(txtCount)}</strong> 个同名 TXT、<strong>{formatCount(abnormalCount)}</strong> 项 TXT 异常。
        目录会连同其中未被图库扫描的文件一起移动；整组操作可撤销，任何单项失败都会回滚整组。
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
          onclick={() => void confirmTrashSelection()}
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
      <span>{formatCount(snapshot.trashOperations.reduce((total, item) => total + item.item_count, 0))} 项 · {formatDirectoryExportBytes(snapshot.trashOperations.reduce((total, item) => total + item.disk_usage_bytes, 0))}{snapshot.trashNextCursor !== null ? "（已载入）" : ""}</span>
      <button type="button" onclick={closeTrashPanel} disabled={trashBulkBusy}>关闭</button>
    </div>
    {#if snapshot.trashPanelPhase === "ready" && snapshot.trashOperations.length > 0}
      <div class="gallery-trash-panel__bulk">
        <span>已选 {formatCount(selectedTrashOperations.length)} 组 · {formatCount(selectedTrashOperations.reduce((total, item) => total + item.item_count, 0))} 项</span>
        <button
          type="button"
          disabled={trashBulkBusy}
          onclick={() => {
            selectedTrashOperationIds = selectedTrashOperations.length === snapshot.trashOperations.length
              ? []
              : snapshot.trashOperations.map((operation) => operation.operation_id);
            trashBulkPurgeConfirm = null;
          }}
        >{selectedTrashOperations.length === snapshot.trashOperations.length ? "取消全选" : "全选已载入"}</button>
        <button type="button" disabled={trashBulkBusy || selectedTrashOperations.length === 0} onclick={() => void restoreSelectedTrash()}>恢复所选</button>
        <button type="button" class="gallery-dialog__danger" disabled={trashBulkBusy || selectedTrashOperations.length === 0} onclick={() => (trashBulkPurgeConfirm = "selected")}>永久删除所选…</button>
        <button type="button" class="gallery-dialog__danger" disabled={trashBulkBusy} onclick={() => (trashBulkPurgeConfirm = "all")}>清空回收区…</button>
      </div>
    {/if}
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
            <label class="gallery-trash-item__select">
              <input
                type="checkbox"
                checked={selectedTrashOperationIds.includes(operation.operation_id)}
                disabled={trashBulkBusy || snapshot.trashPanelBusyOperationId !== null}
                onchange={(event) => toggleTrashOperation(operation.operation_id, (event.currentTarget as HTMLInputElement).checked)}
              />
              <span class="gallery-visually-hidden">选择 {formatTrashTimestamp(operation.created_at)} 的回收操作</span>
            </label>
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
                disabled={trashBulkBusy || snapshot.trashPanelBusyOperationId !== null}
                onclick={() => void restoreSingleTrash(operation.operation_id)}
              >全部恢复</button>
              <button
                type="button"
                disabled={trashBulkBusy || snapshot.trashPanelBusyOperationId !== null}
                onclick={() => requestSingleTrashPurge(operation.operation_id)}
              >彻底删除</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>
    {#if trashBulkPurgeConfirm !== null}
      <div class="gallery-trash-panel__confirm" role="alertdialog" aria-labelledby="gallery-trash-purge-title">
        <strong id="gallery-trash-purge-title">永久删除无法撤销</strong>
        <p>
          {trashBulkPurgeConfirm === "all"
            ? "将清空所有来源的回收区，包括尚未加载的记录。"
            : `将永久删除所选 ${selectedTrashOperations.length} 组、${selectedTrashOperations.reduce((total, item) => total + item.item_count, 0)} 项。`}
        </p>
        <div>
          <button type="button" disabled={trashBulkBusy} onclick={() => (trashBulkPurgeConfirm = null)}>取消</button>
          <button
            type="button"
            class="gallery-dialog__danger"
            disabled={trashBulkBusy}
            onclick={() => void (trashBulkPurgeConfirm === "all" ? purgeAllTrash() : purgeSelectedTrash())}
          >{trashBulkBusy ? "正在永久删除…" : "确认永久删除"}</button>
        </div>
      </div>
    {/if}
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
