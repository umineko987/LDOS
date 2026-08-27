import {
  galleryApplyClickSelection,
  galleryClearSelection,
  gallerySelectAll,
  validateGalleryQuery,
  validateGalleryRenameStem,
  type GallerySearchScope,
  type GalleryTxtState,
} from "./model";
import type { GalleryStore, GalleryTxtViewMode, GalleryViewMode } from "./state";
import type { GalleryDirectoryRequest, GalleryService } from "./service";

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) return code;
  }
  return "gallery_request_failed";
}

export interface GalleryController {
  activate(): void;
  deactivate(): void;
  refreshSources(): Promise<boolean>;
  reconcileOnFocus(): Promise<boolean>;
  rescanActiveSource(): Promise<boolean>;
  retryActiveReconciliation(): Promise<boolean>;
  importDirectory(rootPath: string): Promise<boolean>;
  renameActiveSource(displayName: string): Promise<boolean>;
  relinkActiveSource(rootPath: string): Promise<boolean>;
  unmountActiveSource(): Promise<boolean>;
  openSource(sourceId: string): Promise<boolean>;
  openDirectory(directoryId: string): Promise<boolean>;
  navigateToBreadcrumb(index: number): Promise<boolean>;
  setIncludeDescendants(value: boolean): Promise<boolean>;
  setTxtStateFilter(state: GalleryTxtState | null): Promise<boolean>;
  setSearchScope(scope: GallerySearchScope): Promise<boolean>;
  submitQuery(query: string): Promise<boolean>;
  setViewMode(mode: GalleryViewMode): boolean;
  loadMore(): Promise<boolean>;
  clickAsset(assetId: string, options: { additive: boolean; range: boolean }): boolean;
  selectAllAssets(): boolean;
  clearAssetSelection(): boolean;
  openViewer(assetId: string): boolean;
  viewerNext(): Promise<boolean>;
  viewerPrevious(): Promise<boolean>;
  closeViewer(): boolean;
  setTxtViewMode(mode: GalleryTxtViewMode): boolean;
  refreshDirectory(): Promise<boolean>;
  // ---- G3-3 TXT 编辑 ----
  setTxtDraft(draft: string): boolean;
  saveTxtAnnotation(options: { advance: boolean }): Promise<boolean>;
  discardTxtDraft(): boolean;
  // ---- G3-3 重命名 ----
  openRenameDialog(assetId: string): boolean;
  submitRename(newStem: string): Promise<boolean>;
  cancelRename(): boolean;
  // ---- G3-3 回收 ----
  requestTrashSelection(): boolean;
  confirmTrashSelection(): Promise<boolean>;
  cancelTrashConfirm(): boolean;
  undoLastTrash(): Promise<boolean>;
  dismissUndoToast(): boolean;
  // ---- G3-3 回收区面板 ----
  openTrashPanel(): Promise<boolean>;
  loadMoreTrash(): Promise<boolean>;
  restoreTrashOperation(operationId: string): Promise<boolean>;
  purgeTrashOperation(operationId: string): Promise<boolean>;
  purgeAllTrashOperations(): Promise<boolean>;
  closeTrashPanel(): boolean;
  destroy(): void;
}

export function createGalleryController({ store, service }: {
  readonly store: GalleryStore;
  readonly service: GalleryService;
}): GalleryController {
  let active = false;
  let destroyed = false;
  let sourcesController: AbortController | null = null;
  let pageController: AbortController | null = null;
  let pageVersion = 0;
  let annotationController: AbortController | null = null;

  let scanController: AbortController | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let scanVersion = 0;
  const run = (operation: () => boolean): boolean => active && !destroyed && operation();

  async function loadSources(): Promise<boolean> {
    if (!active || destroyed) return false;
    sourcesController?.abort();
    const controller = new AbortController();
    sourcesController = controller;
    store.patch({ sourcesPhase: "loading", sourcesErrorCode: null });
    try {
      const sources = await service.listSources(controller.signal);
      if (destroyed || sourcesController !== controller) return false;
      store.setSources(sources);
      return true;
    } catch (error) {
      if (isAbortError(error) || destroyed || sourcesController !== controller) return false;
      store.setSourcesError(errorCode(error));
      return false;
    }
  }

  function clearScanPolling(): void {
    if (scanTimer !== null) clearTimeout(scanTimer);
    scanTimer = null;
    scanController?.abort();
    scanController = null;
  }

  async function refreshAfterTerminalScan(sourceId: string, version: number): Promise<void> {
    const refreshed = await loadSources();
    if (!refreshed || destroyed || version !== scanVersion) return;
    const state = store.getState();
    if (state.activeSourceId !== sourceId || state.rootDirectoryId === null) return;
    const loaded = await loadPage(false);
    if (loaded || destroyed || version !== scanVersion) return;
    const latest = store.getState();
    if (
      latest.activeSourceId === sourceId &&
      latest.rootDirectoryId !== null &&
      latest.currentDirectory !== null &&
      latest.currentDirectory?.directory_id !== latest.rootDirectoryId &&
      latest.pageErrorCode === "directory_not_found"
    ) {
      await loadPageForDirectory(latest.rootDirectoryId);
    }
  }

  function scheduleScanPoll(sourceId: string, version: number): void {
    if (destroyed || !active || version !== scanVersion) return;
    if (scanTimer !== null) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      void pollSourceScan(sourceId, version);
    }, 400);
  }

  async function pollSourceScan(sourceId: string, version: number): Promise<boolean> {
    if (!active || destroyed || version !== scanVersion) return false;
    scanController?.abort();
    const request = new AbortController();
    scanController = request;
    try {
      const operation = await service.getSourceScan(sourceId, request.signal);
      if (
        destroyed ||
        !active ||
        request !== scanController ||
        version !== scanVersion
      ) {
        return false;
      }
      store.patch({ scanOperation: operation, scanRequestErrorCode: null });
      if (operation.state === "running") {
        scheduleScanPoll(sourceId, version);
      } else {
        await refreshAfterTerminalScan(sourceId, version);
      }
      return true;
    } catch (error) {
      if (isAbortError(error) || destroyed || request !== scanController || version !== scanVersion) {
        return false;
      }
      store.patch({ scanRequestErrorCode: errorCode(error) });
      return false;
    }
  }

  async function startSourceScan(sourceId: string): Promise<boolean> {
    if (!active || destroyed || store.getState().activeSourceId !== sourceId) return false;
    clearScanPolling();
    const version = ++scanVersion;
    store.patch({ scanRequestErrorCode: null });
    try {
      const operation = await service.startSourceScan(sourceId);
      if (destroyed || !active || version !== scanVersion) return false;
      store.patch({ scanOperation: operation, scanRequestErrorCode: null });
      if (operation.state === "running") {
        scheduleScanPoll(sourceId, version);
      } else {
        await refreshAfterTerminalScan(sourceId, version);
      }
      return true;
    } catch (error) {
      if (destroyed || !active || version !== scanVersion) return false;
      if (errorCode(error) === "source_scan_in_progress") {
        return pollSourceScan(sourceId, version);
      }
      store.patch({ scanRequestErrorCode: errorCode(error) });
      return false;
    }
  }

  function followSourceScan(sourceId: string): Promise<boolean> {
    if (!active || destroyed || store.getState().activeSourceId !== sourceId) {
      return Promise.resolve(false);
    }
    clearScanPolling();
    const version = ++scanVersion;
    store.patch({ scanRequestErrorCode: null });
    return pollSourceScan(sourceId, version);
  }

  function targetDirectoryId(state: ReturnType<GalleryStore["getState"]>): string | null {
    if (state.searchScope === "source") return state.rootDirectoryId;
    return state.currentDirectory?.directory_id ?? state.rootDirectoryId;
  }

  async function loadPage(append: boolean): Promise<boolean> {
    if (!active || destroyed) return false;
    const state = store.getState();
    const directoryId = targetDirectoryId(state);
    if (directoryId === null) return false;
    pageController?.abort();
    const controller = new AbortController();
    pageController = controller;
    const version = ++pageVersion;
    if (!append) store.setPageLoading();
    try {
      const request: GalleryDirectoryRequest = {
        directoryId,
        includeDescendants: state.includeDescendants || state.searchScope === "source",
        txtState: state.txtStateFilter,
        query: validateGalleryQuery(state.query),
        directoryCursor: append ? state.directoryCursor : null,
        assetCursor: append ? state.assetCursor : null,
      };
      const page = await service.listDirectoryEntries(request, controller.signal);
      if (
        destroyed ||
        pageController !== controller ||
        version !== pageVersion ||
        store.getState().activeSourceId === null
      ) {
        return false;
      }
      if (append) {
        store.appendDirectoryPage({
          directory_id: directoryId,
          directories: page.directories,
          assets: page.assets,
          directory_cursor: page.directory_cursor,
          asset_cursor: page.asset_cursor,
        });
      } else {
        store.applyDirectoryPage(page);
      }
      return true;
    } catch (error) {
      if (isAbortError(error) || destroyed || pageController !== controller) return false;
      store.setPageError(errorCode(error));
      return false;
    }
  }

  const controller: GalleryController = {
    activate() {
      if (destroyed) return;
      active = true;
      const phase = store.getState().sourcesPhase;
      if (phase === "loading" || phase === "idle") void loadSources();
    },
    deactivate() {
      active = false;
      sourcesController?.abort();
      sourcesController = null;
      pageController?.abort();
      pageController = null;
      clearScanPolling();
      scanVersion += 1;
    },
    refreshSources() {
      if (!active || destroyed) return Promise.resolve(false);
      return loadSources();
    },
    async reconcileOnFocus() {
      if (!active || destroyed) return false;
      const refreshed = await loadSources();
      if (!refreshed || destroyed || !active) return false;
      const state = store.getState();
      if (state.activeSourceId === null) return true;
      if (state.rootDirectoryId !== null) await loadPage(false);
      return startSourceScan(state.activeSourceId);
    },
    rescanActiveSource() {
      const sourceId = store.getState().activeSourceId;
      return sourceId === null ? Promise.resolve(false) : startSourceScan(sourceId);
    },
    async retryActiveReconciliation() {
      const sourceId = store.getState().activeSourceId;
      if (!active || destroyed || sourceId === null) return false;
      store.patch({ reconciliationRetrySourceId: sourceId, scanRequestErrorCode: null });
      try {
        await service.retrySourceReconciliation(sourceId);
        if (destroyed || !active || store.getState().activeSourceId !== sourceId) return false;
        if (!(await loadSources())) return false;
        if (store.getState().rootDirectoryId !== null) await loadPage(false);
        return followSourceScan(sourceId);
      } catch (error) {
        if (!destroyed && store.getState().activeSourceId === sourceId) {
          store.patch({ scanRequestErrorCode: errorCode(error) });
        }
        return false;
      } finally {
        if (!destroyed && store.getState().reconciliationRetrySourceId === sourceId) {
          store.patch({ reconciliationRetrySourceId: null });
        }
      }
    },
    async importDirectory(rootPath) {
      if (!active || destroyed) return false;
      try {
        const imported = await service.importSource(rootPath);
        if (!(await loadSources()) || destroyed || !active) return false;
        const source = store
          .getState()
          .sources.find((candidate) => candidate.source_id === imported.source_id);
        if (!source) return false;
        store.openSource(source.source_id, source.root_directory_id);
        return followSourceScan(source.source_id);
      } catch (error) {
        store.patch({ sourcesErrorCode: errorCode(error) });
        return false;
      }
    },
    async renameActiveSource(displayName) {
      const sourceId = store.getState().activeSourceId;
      if (!active || destroyed || sourceId === null) return false;
      try {
        await service.renameSource(sourceId, displayName);
        if (destroyed || store.getState().activeSourceId !== sourceId) return false;
        return loadSources();
      } catch (error) {
        store.patch({ scanRequestErrorCode: errorCode(error) });
        return false;
      }
    },
    async relinkActiveSource(rootPath) {
      const sourceId = store.getState().activeSourceId;
      if (!active || destroyed || sourceId === null) return false;
      try {
        await service.relinkSource(sourceId, rootPath);
        if (destroyed || store.getState().activeSourceId !== sourceId) return false;
        if (!(await loadSources())) return false;
        const relinked = store.getState().sources.find((source) => source.source_id === sourceId);
        if (!relinked) return false;
        store.openSource(sourceId, relinked.root_directory_id);
        return followSourceScan(sourceId);
      } catch (error) {
        store.patch({ scanRequestErrorCode: errorCode(error) });
        return false;
      }
    },
    async unmountActiveSource() {
      const sourceId = store.getState().activeSourceId;
      if (!active || destroyed || sourceId === null) return false;
      try {
        await service.unmountSource(sourceId);
        if (destroyed) return false;
        clearScanPolling();
        scanVersion += 1;
        return loadSources();
      } catch (error) {
        store.patch({ scanRequestErrorCode: errorCode(error) });
        return false;
      }
    },
    async openSource(sourceId) {
      if (!active || destroyed) return false;
      const source = store.getState().sources.find((item) => item.source_id === sourceId);
      if (!source) return false;
      if (source.root_directory_id === null) {
        store.openSource(source.source_id, null);
        return startSourceScan(sourceId);
      }
      store.openSource(sourceId, source.root_directory_id);
      void startSourceScan(sourceId);
      return loadPage(false);
    },
    async openDirectory(directoryId) {
      if (!active || destroyed) return false;
      const loaded = await loadPageForDirectory(directoryId);
      const sourceId = store.getState().activeSourceId;
      if (sourceId !== null) void startSourceScan(sourceId);
      return loaded;
    },
    async navigateToBreadcrumb(index) {
      if (!active || destroyed) return false;
      const state = store.getState();
      if (state.rootDirectoryId === null) return false;
      const directoryId =
        index < 0 || index >= state.path.length
          ? state.rootDirectoryId
          : state.path[index].directory_id;
      const loaded = await loadPageForDirectory(directoryId);
      const sourceId = store.getState().activeSourceId;
      if (sourceId !== null) void startSourceScan(sourceId);
      return loaded;
    },
    async setIncludeDescendants(value) {
      if (!active || destroyed) return false;
      store.patch({ includeDescendants: value });
      return loadPage(false);
    },
    async setTxtStateFilter(txtState) {
      if (!active || destroyed) return false;
      store.patch({ txtStateFilter: txtState });
      return loadPage(false);
    },
    async setSearchScope(scope) {
      if (!active || destroyed) return false;
      store.patch({ searchScope: scope });
      return loadPage(false);
    },
    async submitQuery(query) {
      if (!active || destroyed) return false;
      let normalized: string;
      try {
        normalized = validateGalleryQuery(query);
      } catch {
        // 非法查询词被本地拒绝，不触发网络请求。
        return false;
      }
      store.patch({ query: normalized });
      return loadPage(false);
    },
    setViewMode(mode) {
      return run(() => store.patch({ viewMode: mode }));
    },
    async loadMore() {
      if (!active || destroyed) return false;
      const state = store.getState();
      if (state.directoryCursor === null && state.assetCursor === null) return false;
      return loadPage(true);
    },
    clickAsset(assetId, options) {
      if (!active || destroyed) return false;
      const state = store.getState();
      const index = state.assets.findIndex((asset) => asset.asset_id === assetId);
      if (index < 0) return false;
      const patch = galleryApplyClickSelection({
        total: state.assets.length,
        anchorIndex: state.selectionAnchorIndex,
        selectedIds: state.selectedAssetIds,
        clickedIndex: index,
        clickedId: assetId,
        additive: options.additive,
        range: options.range,
        ids: state.assets.map((asset) => asset.asset_id),
      });
      return store.applySelection(patch);
    },
    selectAllAssets() {
      if (!active || destroyed) return false;
      const state = store.getState();
      return store.applySelection(gallerySelectAll(state.assets.map((asset) => asset.asset_id)));
    },
    clearAssetSelection() {
      return run(() => store.applySelection(galleryClearSelection()));
    },
    openViewer(assetId) {
      if (!active || destroyed) return false;
      const state = store.getState();
      const index = state.assets.findIndex((asset) => asset.asset_id === assetId);
      if (index < 0) return false;
      if (!store.openViewer(state.assets, index)) return false;
      void loadViewerAnnotation();
      return true;
    },
    async viewerNext() {
      return moveViewerBy(1);
    },
    async viewerPrevious() {
      return moveViewerBy(-1);
    },
    closeViewer() {
      annotationController?.abort();
      annotationController = null;
      return run(() => store.closeViewer());
    },
    setTxtViewMode(mode) {
      return run(() => store.setTxtViewMode(mode));
    },
    refreshDirectory() {
      const sourceId = store.getState().activeSourceId;
      return sourceId === null ? Promise.resolve(false) : startSourceScan(sourceId);
    },
    setTxtDraft(draft) {
      const state = store.getState();
      if (state.viewerPhase !== "ready" || state.viewerAnnotation === null) return false;
      if (typeof draft !== "string" || draft.length > 2_000_000) return false;
      return run(() => store.setTxtDraft(draft));
    },
    async saveTxtAnnotation(options) {
      const state = store.getState();
      if (state.viewerPhase !== "ready" || state.viewerAnnotation === null) return false;
      if (state.txtDraft === null) return false;
      if (state.txtSavePhase === "saving") return false;
      const asset = state.viewerAssets[state.viewerIndex];
      if (!asset) return false;
      store.setTxtSavePhase("saving", null);
      try {
        const annotation = await service.saveAnnotation(
          asset.asset_id,
          state.txtDraft,
          state.viewerAnnotation.txt_version,
          state.viewerAnnotation.disk_version,
        );
        if (destroyed) return false;
        store.setViewerAnnotation(annotation);
        // 保存成功：草稿退出编辑态、阶段记录 saved 供横幅展示。
        store.setTxtDraft(null);
        store.setTxtSavePhase("saved", null);
        if (options.advance) {
          await moveViewerBy(1);
        } else {
          // 保存后刷新目录数据（TXT 状态可能变化）。
          void loadPage(false);
        }
        return true;
      } catch (error) {
        if (destroyed) return false;
        const code = errorCode(error);
        if (
          code === "txt_version_conflict" ||
          code === "txt_disk_conflict" ||
          code === "asset_not_active"
        ) {
          store.setTxtSavePhase("conflict", code);
        } else {
          store.setTxtSavePhase("error", code);
        }
        return false;
      }
    },
    discardTxtDraft() {
      return run(() => store.resetTxtEditor());
    },
    openRenameDialog(assetId) {
      const state = store.getState();
      const asset = state.assets.find((entry) => entry.asset_id === assetId);
      if (!asset) return false;
      return run(() => store.openRenameDialog(assetId));
    },
    async submitRename(newStem) {
      const state = store.getState();
      if (state.renameDialogPhase !== "open") return false;
      if (state.renameAssetId === null) return false;
      if (validateGalleryRenameStem(newStem) !== null) {
        store.setRenameDialog("open", "invalid_rename_target");
        return false;
      }
      store.setRenameDialog("busy", null);
      try {
        const result = await service.renameAsset(state.renameAssetId, newStem);
        if (destroyed) return false;
        store.closeRenameDialog();
        // 重命名成功后刷新目录与查看器快照。
        await loadPage(false);
        return result.status === "committed";
      } catch (error) {
        if (destroyed) return false;
        store.setRenameDialog("open", errorCode(error));
        return false;
      }
    },
    cancelRename() {
      return run(() => store.closeRenameDialog());
    },
    requestTrashSelection() {
      const state = store.getState();
      if (state.selectedAssetIds.length === 0) return false;
      return run(() => store.openTrashConfirm(state.selectedAssetIds));
    },
    async confirmTrashSelection() {
      const state = store.getState();
      if (state.trashConfirmPhase !== "open") return false;
      if (state.trashConfirmAssetIds.length === 0) return false;
      store.setTrashConfirm("busy", null);
      try {
        const result = await service.trashAssets(state.trashConfirmAssetIds);
        if (destroyed) return false;
        store.closeTrashConfirm();
        store.clearSelection();
        store.showUndoToast(result.operation_id, result.item_count);
        await loadPage(false);
        return true;
      } catch (error) {
        if (destroyed) return false;
        store.setTrashConfirm("open", errorCode(error));
        return false;
      }
    },
    cancelTrashConfirm() {
      return run(() => store.closeTrashConfirm());
    },
    async undoLastTrash() {
      const state = store.getState();
      if (!state.undoToastVisible || state.undoableOperationId === null) return false;
      if (state.undoBusy) return false;
      store.setUndoBusy(true);
      try {
        await service.undoTrash(state.undoableOperationId);
        if (destroyed) return false;
        store.hideUndoToast();
        await loadPage(false);
        return true;
      } catch (error) {
        if (destroyed) return false;
        store.setUndoBusy(false);
        return false;
      }
    },
    dismissUndoToast() {
      return run(() => store.hideUndoToast());
    },
    async openTrashPanel() {
      if (!active || destroyed) return false;
      store.setTrashPanelLoading();
      try {
        const page = await service.listTrash(null, new AbortController().signal);
        if (destroyed) return false;
        return store.applyTrashPage(page.operations, page.next_cursor);
      } catch (error) {
        if (destroyed) return false;
        store.setTrashPanelError(errorCode(error));
        return false;
      }
    },
    async loadMoreTrash() {
      const state = store.getState();
      if (state.trashPanelPhase !== "ready") return false;
      if (state.trashNextCursor === null) return false;
      try {
        const page = await service.listTrash(state.trashNextCursor, new AbortController().signal);
        if (destroyed) return false;
        return store.applyTrashPage(
          [...state.trashOperations, ...page.operations],
          page.next_cursor,
        );
      } catch (error) {
        if (destroyed) return false;
        store.setTrashPanelError(errorCode(error));
        return false;
      }
    },
    async restoreTrashOperation(operationId) {
      const state = store.getState();
      if (state.trashPanelPhase !== "ready") return false;
      if (state.trashPanelBusyOperationId !== null) return false;
      store.setTrashPanelBusy(operationId);
      try {
        await service.restoreTrash(operationId);
        if (destroyed) return false;
        // 恢复后重新拉取列表。
        const page = await service.listTrash(null, new AbortController().signal);
        if (destroyed) return false;
        store.setTrashPanelBusy(null);
        store.applyTrashPage(page.operations, page.next_cursor);
        await loadPage(false);
        return true;
      } catch (error) {
        if (destroyed) return false;
        store.setTrashPanelBusy(null);
        store.setTrashPanelError(errorCode(error));
        return false;
      }
    },
    async purgeTrashOperation(operationId) {
      const state = store.getState();
      if (state.trashPanelPhase !== "ready") return false;
      if (state.trashPanelBusyOperationId !== null) return false;
      store.setTrashPanelBusy(operationId);
      try {
        await service.purgeTrash(operationId);
        if (destroyed) return false;
        const page = await service.listTrash(null, new AbortController().signal);
        if (destroyed) return false;
        store.setTrashPanelBusy(null);
        store.applyTrashPage(page.operations, page.next_cursor);
        return true;
      } catch (error) {
        if (destroyed) return false;
        store.setTrashPanelBusy(null);
        store.setTrashPanelError(errorCode(error));
        return false;
      }
    },
    async purgeAllTrashOperations() {
      const state = store.getState();
      if (state.trashPanelPhase !== "ready") return false;
      if (state.trashPanelBusyOperationId !== null) return false;
      store.setTrashPanelBusy("*");
      try {
        await service.purgeAllTrash();
        if (destroyed) return false;
        store.setTrashPanelBusy(null);
        store.applyTrashPage([], null);
        return true;
      } catch (error) {
        if (destroyed) return false;
        store.setTrashPanelBusy(null);
        store.setTrashPanelError(errorCode(error));
        return false;
      }
    },
    closeTrashPanel() {
      return run(() => store.closeTrashPanel());
    },
    destroy() {
      if (destroyed) return;
      controller.deactivate();
      destroyed = true;
      store.destroy();
    },
  };

  async function loadPageForDirectory(directoryId: string): Promise<boolean> {
    // 定向打开目录：以该目录为请求目标（忽略搜索范围），加载后 store 重算路径。
    if (!active || destroyed) return false;
    pageController?.abort();
    const controller = new AbortController();
    pageController = controller;
    const version = ++pageVersion;
    store.setPageLoading();
    const state = store.getState();
    try {
      const request: GalleryDirectoryRequest = {
        directoryId,
        includeDescendants: state.includeDescendants,
        txtState: state.txtStateFilter,
        query: validateGalleryQuery(state.query),
        directoryCursor: null,
        assetCursor: null,
      };
      const page = await service.listDirectoryEntries(request, controller.signal);
      if (
        destroyed ||
        pageController !== controller ||
        version !== pageVersion
      ) {
        return false;
      }
      store.applyDirectoryPage(page);
      return true;
    } catch (error) {
      if (isAbortError(error) || destroyed || pageController !== controller) return false;
      store.setPageError(errorCode(error));
      return false;
    }
  }

  async function loadViewerAnnotation(): Promise<boolean> {
    if (!active || destroyed) return false;
    const state = store.getState();
    const asset = state.viewerAssets[state.viewerIndex];
    if (!asset) return false;
    annotationController?.abort();
    const controller = new AbortController();
    annotationController = controller;
    try {
      const annotation = await service.getAnnotation(asset.asset_id, controller.signal);
      if (destroyed || annotationController !== controller) return false;
      const current = store.getState();
      if (current.viewerAssets[current.viewerIndex]?.asset_id !== asset.asset_id) return false;
      // 换图后清除上一张的编辑草稿与保存阶段。
      store.resetTxtEditor();
      store.setViewerAnnotation(annotation);
      return true;
    } catch (error) {
      if (isAbortError(error) || destroyed || annotationController !== controller) return false;
      store.setViewerError(errorCode(error));
      return false;
    }
  }

  async function moveViewerBy(delta: number): Promise<boolean> {
    if (!active || destroyed) return false;
    const state = store.getState();
    const next = state.viewerIndex + delta;
    if (next < 0 || next >= state.viewerAssets.length) return false;
    if (!store.moveViewer(next)) return false;
    void loadViewerAnnotation();
    return true;
  }

  return Object.freeze(controller);
}
