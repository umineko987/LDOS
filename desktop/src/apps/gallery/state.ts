import {
  sortGalleryAssetEntries,
  sortGalleryDirectoryEntries,
  type GalleryAnnotation,
  type GalleryAssetEntry,
  type GalleryDirectoryEntry,
  type GalleryPathSegment,
  type GallerySearchScope,
  type GallerySourceSummary,
  type GalleryScanOperation,
  type GalleryTrashOperation,
  type GalleryTxtState,
} from "./model";

export type GalleryLoadPhase = "idle" | "loading" | "ready" | "error";
export type GalleryViewMode = "grid" | "list";
export type GalleryViewerPhase = "idle" | "loading" | "ready" | "error";
export type GalleryTxtViewMode = "raw" | "tags";
export type GallerySavePhase = "idle" | "saving" | "saved" | "conflict" | "error";
export type GalleryDialogPhase = "closed" | "open" | "busy";
export type GalleryTrashPanelPhase = "closed" | "loading" | "ready" | "error";
export type GalleryViewerPagePhase = "idle" | "loading" | "error";
export type GalleryViewerOperationPhase = "idle" | "trashing" | "error";
export type GalleryViewerPendingAction =
  | Readonly<{ kind: "close" }>
  | Readonly<{ kind: "previous" }>
  | Readonly<{ kind: "next" }>
  | Readonly<{ kind: "jump"; index: number }>
  | Readonly<{ kind: "trash"; assetId: string }>;

export interface GalleryViewerQueryContext {
  readonly mode: "directory" | "search";
  readonly directoryId: string | null;
  readonly sourceId: string | null;
  readonly scope: GallerySearchScope;
  readonly includeDescendants: boolean;
  readonly txtState: GalleryTxtState | null;
  readonly query: string;
}
export interface GalleryBrowseState {
  /** 来源列表加载阶段。 */
  readonly sourcesPhase: GalleryLoadPhase;
  readonly sourcesErrorCode: string | null;
  readonly sources: readonly GallerySourceSummary[];
  readonly activeSourceId: string | null;
  readonly scanOperation: GalleryScanOperation | null;
  readonly scanRequestErrorCode: string | null;
  readonly reconciliationRetrySourceId: string | null;
  /** 活动来源的根目录 ID（进入来源首页面后获得）。 */
  readonly rootDirectoryId: string | null;
  /** 从根到当前目录的导航路径（不含根）。 */
  readonly path: readonly GalleryPathSegment[];
  readonly currentDirectory: GalleryDirectoryEntry | null;
  /** 目录树缓存：directory_id -> 已加载的直接子目录（含游标累积）。 */
  readonly treeChildren: ReadonlyMap<string, readonly GalleryDirectoryEntry[]>;
  readonly directories: readonly GalleryDirectoryEntry[];
  readonly assets: readonly GalleryAssetEntry[];
  readonly directoryCursor: string | null;
  readonly assetCursor: string | null;
  readonly pagePhase: GalleryLoadPhase;
  readonly pageErrorCode: string | null;
  readonly includeDescendants: boolean;
  readonly txtStateFilter: GalleryTxtState | null;
  readonly searchScope: GallerySearchScope;
  readonly query: string;
  readonly viewMode: GalleryViewMode;
  // ---- 选择（G2-3） ----
  readonly selectedAssetIds: readonly string[];
  readonly selectionAnchorIndex: number | null;
  // ---- 沉浸式查看器（G2-3，只读） ----
  /** 查看器打开时的资产列表快照（当前筛选与排序下的完整资产序）。 */
  readonly viewerAssets: readonly GalleryAssetEntry[];
  readonly viewerIndex: number;
  readonly viewerPhase: GalleryViewerPhase;
  readonly viewerErrorCode: string | null;
  readonly viewerAnnotation: GalleryAnnotation | null;
  readonly txtViewMode: GalleryTxtViewMode;
  /** 返回网格时要恢复的滚动位置。 */
  readonly viewerAssetCursor: string | null;
  readonly viewerQuery: GalleryViewerQueryContext | null;
  readonly viewerPagePhase: GalleryViewerPagePhase;
  readonly viewerPageErrorCode: string | null;
  readonly viewerPendingAction: GalleryViewerPendingAction | null;
  readonly viewerOperationPhase: GalleryViewerOperationPhase;
  readonly viewerOperationErrorCode: string | null;
  readonly pendingGridScrollTop: number;
  // ---- TXT 编辑（G3-3） ----
  /** TXT 编辑草稿；null 表示未进入编辑态（与已保存内容一致）。 */
  readonly txtDraft: string | null;
  /** TXT 保存阶段。 */
  readonly txtSavePhase: GallerySavePhase;
  /** TXT 保存的错误码（conflict/error 时）。 */
  readonly txtSaveErrorCode: string | null;
  // ---- 重命名对话框（G3-3） ----
  readonly renameDialogPhase: GalleryDialogPhase;
  readonly renameAssetId: string | null;
  readonly renameDialogError: string | null;
  // ---- 删除确认（G3-3） ----
  readonly trashConfirmPhase: GalleryDialogPhase;
  /** 待删除的资产 ID 列表（含关联 TXT 计数由资产数据推导）。 */
  readonly trashConfirmAssetIds: readonly string[];
  /** 待删除的完整物理目录 ID 列表。 */
  readonly trashConfirmDirectoryIds: readonly string[];
  readonly trashConfirmError: string | null;
  // ---- 撤销 toast（G3-3） ----
  /** 最近一次回收操作（供撤销）。 */
  readonly undoableOperationId: string | null;
  readonly undoItemCount: number;
  readonly undoToastVisible: boolean;
  readonly undoBusy: boolean;
  // ---- 回收区面板（G3-3） ----
  readonly trashPanelPhase: GalleryTrashPanelPhase;
  readonly trashOperations: readonly GalleryTrashOperation[];
  readonly trashNextCursor: string | null;
  readonly trashPanelError: string | null;
  readonly trashPanelBusyOperationId: string | null;
}

export const GALLERY_BROWSE_DEFAULTS: GalleryBrowseState = Object.freeze({
  sourcesPhase: "idle" as const,
  sourcesErrorCode: null,
  sources: Object.freeze([]),
  activeSourceId: null,
  scanOperation: null,
  scanRequestErrorCode: null,
  reconciliationRetrySourceId: null,
  rootDirectoryId: null,
  path: Object.freeze([]),
  currentDirectory: null,
  treeChildren: new Map<string, readonly GalleryDirectoryEntry[]>(),
  directories: Object.freeze([]),
  assets: Object.freeze([]),
  directoryCursor: null,
  assetCursor: null,
  pagePhase: "idle" as const,
  pageErrorCode: null,
  includeDescendants: false,
  txtStateFilter: null,
  searchScope: "directory",
  query: "",
  viewMode: "grid",
  selectedAssetIds: Object.freeze([]),
  selectionAnchorIndex: null,
  viewerAssets: Object.freeze([]),
  viewerIndex: -1,
  viewerPhase: "idle" as const,
  viewerErrorCode: null,
  viewerAnnotation: null,
  txtViewMode: "raw" as const,
  viewerAssetCursor: null,
  viewerQuery: null,
  viewerPagePhase: "idle" as const,
  viewerPageErrorCode: null,
  viewerPendingAction: null,
  viewerOperationPhase: "idle" as const,
  viewerOperationErrorCode: null,
  pendingGridScrollTop: 0,
  txtDraft: null,
  txtSavePhase: "idle" as const,
  txtSaveErrorCode: null,
  renameDialogPhase: "closed" as const,
  renameAssetId: null,
  renameDialogError: null,
  trashConfirmPhase: "closed" as const,
  trashConfirmAssetIds: Object.freeze([]),
  trashConfirmDirectoryIds: Object.freeze([]),
  trashConfirmError: null,
  undoableOperationId: null,
  undoItemCount: 0,
  undoToastVisible: false,
  undoBusy: false,
  trashPanelPhase: "closed" as const,
  trashOperations: Object.freeze([]),
  trashNextCursor: null,
  trashPanelError: null,
  trashPanelBusyOperationId: null,
}) as GalleryBrowseState;

type BrowsePatch = Partial<Omit<GalleryBrowseState, "treeChildren">>;

export interface GalleryStore {
  subscribe(listener: (state: GalleryBrowseState) => void): () => void;
  getState(): GalleryBrowseState;
  patch(partial: BrowsePatch): boolean;
  setSourcesError(errorCode: string): boolean;
  setSources(sources: readonly GallerySourceSummary[]): boolean;
  openSource(sourceId: string, rootDirectoryId: string | null): boolean;
  applyDirectoryPage(page: {
    directory: GalleryDirectoryEntry;
    directories: readonly GalleryDirectoryEntry[];
    assets: readonly GalleryAssetEntry[];
    directory_cursor: string | null;
    asset_cursor: string | null;
  }): boolean;
  appendDirectoryPage(page: {
    directory_id: string;
    directories: readonly GalleryDirectoryEntry[];
    assets: readonly GalleryAssetEntry[];
    directory_cursor: string | null;
    asset_cursor: string | null;
  }): boolean;
  applySearchPage(page: {
    assets: readonly GalleryAssetEntry[];
    asset_cursor: string | null;
  }, append: boolean): boolean;
  setPageError(errorCode: string): boolean;
  setPageLoading(): boolean;
  resetPage(): boolean;
  applySelection(patch: { anchorIndex: number | null; selectedIds: readonly string[] }): boolean;
  clearSelection(): boolean;
  openViewer(
    assets: readonly GalleryAssetEntry[],
    index: number,
    context?: GalleryViewerQueryContext,
    assetCursor?: string | null,
  ): boolean;
  setViewerAnnotation(annotation: GalleryAnnotation): boolean;
  setViewerLoading(): boolean;
  setViewerError(errorCode: string): boolean;
  moveViewer(index: number): boolean;
  setViewerPageLoading(): boolean;
  appendViewerAssets(assets: readonly GalleryAssetEntry[], assetCursor: string | null): boolean;
  setViewerPageError(errorCode: string): boolean;
  setViewerPendingAction(action: GalleryViewerPendingAction | null): boolean;
  setViewerOperation(phase: GalleryViewerOperationPhase, errorCode: string | null): boolean;
  removeViewerAsset(assetId: string): boolean;
  closeViewer(): boolean;
  setTxtViewMode(mode: GalleryTxtViewMode): boolean;
  // ---- G3-3 TXT 编辑 ----
  setTxtDraft(draft: string | null): boolean;
  setTxtSavePhase(phase: GallerySavePhase, errorCode: string | null): boolean;
  resetTxtEditor(): boolean;
  // ---- G3-3 重命名对话框 ----
  openRenameDialog(assetId: string): boolean;
  setRenameDialog(phase: GalleryDialogPhase, error: string | null): boolean;
  closeRenameDialog(): boolean;
  // ---- G3-3 删除确认 ----
  openTrashConfirm(assetIds: readonly string[], directoryIds?: readonly string[]): boolean;
  setTrashConfirm(phase: GalleryDialogPhase, error: string | null): boolean;
  closeTrashConfirm(): boolean;
  // ---- G3-3 撤销 toast ----
  showUndoToast(operationId: string, itemCount: number): boolean;
  setUndoBusy(busy: boolean): boolean;
  hideUndoToast(): boolean;
  // ---- G3-3 回收区面板 ----
  setTrashPanelLoading(): boolean;
  applyTrashPage(
    operations: readonly GalleryTrashOperation[],
    nextCursor: string | null,
  ): boolean;
  setTrashPanelError(errorCode: string): boolean;
  setTrashPanelBusy(operationId: string | null): boolean;
  closeTrashPanel(): boolean;
  destroy(): void;
}

function statesEqual(left: GalleryBrowseState, right: GalleryBrowseState): boolean {
  return (
    left.sourcesPhase === right.sourcesPhase &&
    left.sourcesErrorCode === right.sourcesErrorCode &&
    left.sources === right.sources &&
    left.activeSourceId === right.activeSourceId &&
    left.scanOperation === right.scanOperation &&
    left.scanRequestErrorCode === right.scanRequestErrorCode &&
    left.reconciliationRetrySourceId === right.reconciliationRetrySourceId &&
    left.rootDirectoryId === right.rootDirectoryId &&
    left.path === right.path &&
    left.currentDirectory === right.currentDirectory &&
    left.treeChildren === right.treeChildren &&
    left.directories === right.directories &&
    left.assets === right.assets &&
    left.directoryCursor === right.directoryCursor &&
    left.assetCursor === right.assetCursor &&
    left.pagePhase === right.pagePhase &&
    left.pageErrorCode === right.pageErrorCode &&
    left.includeDescendants === right.includeDescendants &&
    left.txtStateFilter === right.txtStateFilter &&
    left.searchScope === right.searchScope &&
    left.query === right.query &&
    left.viewMode === right.viewMode &&
    left.selectedAssetIds === right.selectedAssetIds &&
    left.selectionAnchorIndex === right.selectionAnchorIndex &&
    left.viewerAssets === right.viewerAssets &&
    left.viewerIndex === right.viewerIndex &&
    left.viewerPhase === right.viewerPhase &&
    left.viewerErrorCode === right.viewerErrorCode &&
    left.viewerAnnotation === right.viewerAnnotation &&
    left.txtViewMode === right.txtViewMode &&
    left.viewerAssetCursor === right.viewerAssetCursor &&
    left.viewerQuery === right.viewerQuery &&
    left.viewerPagePhase === right.viewerPagePhase &&
    left.viewerPageErrorCode === right.viewerPageErrorCode &&
    left.viewerPendingAction === right.viewerPendingAction &&
    left.viewerOperationPhase === right.viewerOperationPhase &&
    left.viewerOperationErrorCode === right.viewerOperationErrorCode &&
    left.pendingGridScrollTop === right.pendingGridScrollTop &&
    left.txtDraft === right.txtDraft &&
    left.txtSavePhase === right.txtSavePhase &&
    left.txtSaveErrorCode === right.txtSaveErrorCode &&
    left.renameDialogPhase === right.renameDialogPhase &&
    left.renameAssetId === right.renameAssetId &&
    left.renameDialogError === right.renameDialogError &&
    left.trashConfirmPhase === right.trashConfirmPhase &&
    left.trashConfirmAssetIds === right.trashConfirmAssetIds &&
    left.trashConfirmDirectoryIds === right.trashConfirmDirectoryIds &&
    left.trashConfirmError === right.trashConfirmError &&
    left.undoableOperationId === right.undoableOperationId &&
    left.undoItemCount === right.undoItemCount &&
    left.undoToastVisible === right.undoToastVisible &&
    left.undoBusy === right.undoBusy &&
    left.trashPanelPhase === right.trashPanelPhase &&
    left.trashOperations === right.trashOperations &&
    left.trashNextCursor === right.trashNextCursor &&
    left.trashPanelError === right.trashPanelError &&
    left.trashPanelBusyOperationId === right.trashPanelBusyOperationId
  );
}

export function createGalleryStore(): GalleryStore {
  let state: GalleryBrowseState = GALLERY_BROWSE_DEFAULTS;
  const listeners = new Set<(state: GalleryBrowseState) => void>();
  let destroyed = false;

  const publish = (next: GalleryBrowseState): boolean => {
    if (destroyed || statesEqual(state, next)) return false;
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // 单个订阅者异常不阻断其余订阅者，也不影响状态推进。
      }
    }
    return true;
  };

  const patch = (partial: BrowsePatch): boolean => publish({ ...state, ...partial });

  const store: GalleryStore = {
    subscribe(listener) {
      if (destroyed) return () => {};
      try {
        listener(state);
      } catch {
        // 立即回放同样不因订阅者异常中断注册。
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    patch(partial) {
      return patch(partial);
    },
    setSourcesError(errorCode) {
      return patch({ sourcesPhase: "error", sourcesErrorCode: errorCode });
    },
    setSources(sources) {
      const previous = state.activeSourceId;
      const activeSource =
        previous === null ? undefined : sources.find((source) => source.source_id === previous);
      const stillActive = activeSource !== undefined;
      const preservePage =
        activeSource !== undefined && activeSource.root_directory_id === state.rootDirectoryId;
      return publish({
        ...state,
        sourcesPhase: "ready",
        sourcesErrorCode: null,
        sources: Object.freeze([...sources]),
        activeSourceId: stillActive ? previous : null,
        rootDirectoryId: activeSource?.root_directory_id ?? null,
        scanOperation: stillActive ? state.scanOperation : null,
        scanRequestErrorCode: stillActive ? state.scanRequestErrorCode : null,
        reconciliationRetrySourceId: stillActive ? state.reconciliationRetrySourceId : null,
        path: preservePage ? state.path : Object.freeze([]),
        currentDirectory: preservePage ? state.currentDirectory : null,
        treeChildren: preservePage ? state.treeChildren : new Map(),
        directories: preservePage ? state.directories : Object.freeze([]),
        assets: preservePage ? state.assets : Object.freeze([]),
        directoryCursor: preservePage ? state.directoryCursor : null,
        assetCursor: preservePage ? state.assetCursor : null,
        pagePhase: preservePage ? state.pagePhase : ("idle" as const),
        pageErrorCode: preservePage ? state.pageErrorCode : null,
      });
    },
    openSource(sourceId, rootDirectoryId) {
      return publish({
        ...state,
        activeSourceId: sourceId,
        scanOperation: null,
        scanRequestErrorCode: null,
        reconciliationRetrySourceId: null,
        rootDirectoryId,
        path: Object.freeze([]),
        currentDirectory: null,
        treeChildren: new Map(),
        directories: Object.freeze([]),
        assets: Object.freeze([]),
        directoryCursor: null,
        assetCursor: null,
        pagePhase: "idle",
        pageErrorCode: null,
      });
    },
    applyDirectoryPage(page) {
      const sortedDirectories = sortGalleryDirectoryEntries(page.directories);
      const sortedAssets = sortGalleryAssetEntries(page.assets);
      const children = new Map(state.treeChildren);
      children.set(page.directory.directory_id, sortedDirectories);
      const path = buildPathFromDirectory(state.path, page.directory);
      return publish({
        ...state,
        currentDirectory: page.directory,
        path,
        treeChildren: children,
        directories: sortedDirectories,
        assets: sortedAssets,
        directoryCursor: page.directory_cursor,
        assetCursor: page.asset_cursor,
        pagePhase: "ready",
        pageErrorCode: null,
      });
    },
    appendDirectoryPage(page) {
      const sortedDirectories = sortGalleryDirectoryEntries([
        ...state.directories,
        ...page.directories,
      ]);
      const sortedAssets = sortGalleryAssetEntries([...state.assets, ...page.assets]);
      const children = new Map(state.treeChildren);
      children.set(page.directory_id, sortedDirectories);
      return publish({
        ...state,
        treeChildren: children,
        directories: sortedDirectories,
        assets: sortedAssets,
        directoryCursor: page.directory_cursor,
        assetCursor: page.asset_cursor,
      });
    },
    applySearchPage(page, append) {
      const combined = append ? [...state.assets, ...page.assets] : [...page.assets];
      const unique = new Map(combined.map((asset) => [asset.asset_id, asset]));
      return publish({
        ...state,
        directories: Object.freeze([]),
        directoryCursor: null,
        assets: sortGalleryAssetEntries([...unique.values()]),
        assetCursor: page.asset_cursor,
        pagePhase: "ready",
        pageErrorCode: null,
        selectedAssetIds: Object.freeze([]),
        selectionAnchorIndex: null,
      });
    },
    setPageError(errorCode) {
      return publish({ ...state, pagePhase: "error", pageErrorCode: errorCode });
    },
    setPageLoading() {
      return publish({ ...state, pagePhase: "loading", pageErrorCode: null });
    },
    resetPage() {
      return publish({
        ...state,
        directories: Object.freeze([]),
        assets: Object.freeze([]),
        directoryCursor: null,
        assetCursor: null,
        pageErrorCode: null,
      });
    },
    applySelection(patch) {
      return publish({
        ...state,
        selectionAnchorIndex: patch.anchorIndex,
        selectedAssetIds: Object.freeze([...patch.selectedIds]),
      });
    },
    clearSelection() {
      return publish({
        ...state,
        selectionAnchorIndex: null,
        selectedAssetIds: Object.freeze([]),
      });
    },
    openViewer(assets, index, context, assetCursor) {
      if (index < 0 || index >= assets.length) return false;
      const viewerQuery = Object.freeze({
        ...(context ?? {
          mode: state.query.length > 0 ? "search" : "directory",
          directoryId: state.currentDirectory?.directory_id ?? null,
          sourceId: state.activeSourceId,
          scope: state.searchScope,
          includeDescendants: state.includeDescendants,
          txtState: state.txtStateFilter,
          query: state.query,
        }),
      });
      return publish({
        ...state,
        viewerAssets: Object.freeze([...assets]),
        viewerIndex: index,
        viewerPhase: "loading",
        viewerErrorCode: null,
        viewerAnnotation: null,
        viewerAssetCursor: assetCursor === undefined ? state.assetCursor : assetCursor,
        viewerQuery,
        viewerPagePhase: "idle",
        viewerPageErrorCode: null,
        viewerPendingAction: null,
        viewerOperationPhase: "idle",
        viewerOperationErrorCode: null,
        txtDraft: null,
        txtSavePhase: "idle",
        txtSaveErrorCode: null,
      });
    },
    setViewerAnnotation(annotation) {
      return publish({
        ...state,
        viewerPhase: "ready",
        viewerErrorCode: null,
        viewerAnnotation: annotation,
      });
    },
    setViewerLoading() {
      return publish({ ...state, viewerPhase: "loading", viewerErrorCode: null });
    },
    setViewerError(errorCode) {
      return publish({ ...state, viewerPhase: "error", viewerErrorCode: errorCode });
    },
    moveViewer(index) {
      if (index < 0 || index >= state.viewerAssets.length) return false;
      return publish({
        ...state,
        viewerIndex: index,
        viewerPhase: "loading",
        viewerErrorCode: null,
        viewerAnnotation: null,
        viewerPendingAction: null,
        viewerOperationPhase: "idle",
        viewerOperationErrorCode: null,
        txtDraft: null,
        txtSavePhase: "idle",
        txtSaveErrorCode: null,
      });
    },
    setViewerPageLoading() {
      return publish({
        ...state,
        viewerPagePhase: "loading",
        viewerPageErrorCode: null,
      });
    },
    appendViewerAssets(assets, assetCursor) {
      const seen = new Set(state.viewerAssets.map((asset) => asset.asset_id));
      const nextAssets = [...state.viewerAssets];
      for (const asset of assets) {
        if (!seen.has(asset.asset_id)) {
          seen.add(asset.asset_id);
          nextAssets.push(asset);
        }
      }
      return publish({
        ...state,
        viewerAssets: Object.freeze(nextAssets),
        viewerAssetCursor: assetCursor,
        viewerPagePhase: "idle",
        viewerPageErrorCode: null,
      });
    },
    setViewerPageError(errorCode) {
      return publish({
        ...state,
        viewerPagePhase: "error",
        viewerPageErrorCode: errorCode,
      });
    },
    setViewerPendingAction(action) {
      return publish({
        ...state,
        viewerPendingAction: action === null ? null : Object.freeze({ ...action }),
      });
    },
    setViewerOperation(phase, errorCode) {
      return publish({
        ...state,
        viewerOperationPhase: phase,
        viewerOperationErrorCode: errorCode,
      });
    },
    removeViewerAsset(assetId) {
      const removedIndex = state.viewerAssets.findIndex((asset) => asset.asset_id === assetId);
      if (removedIndex < 0) return false;
      const viewerAssets = state.viewerAssets.filter((asset) => asset.asset_id !== assetId);
      let viewerIndex = state.viewerIndex;
      if (removedIndex < viewerIndex) viewerIndex -= 1;
      else if (removedIndex === viewerIndex) viewerIndex = Math.min(viewerIndex, viewerAssets.length - 1);
      const remainsOpen = viewerIndex >= 0 && viewerAssets.length > 0;
      return publish({
        ...state,
        assets: Object.freeze(state.assets.filter((asset) => asset.asset_id !== assetId)),
        selectedAssetIds: Object.freeze(state.selectedAssetIds.filter((id) => id !== assetId)),
        selectionAnchorIndex: null,
        viewerAssets: Object.freeze(viewerAssets),
        viewerIndex: remainsOpen ? viewerIndex : -1,
        viewerPhase: remainsOpen ? "loading" : "idle",
        viewerErrorCode: null,
        viewerAnnotation: null,
        viewerPendingAction: null,
        viewerOperationPhase: "idle",
        viewerOperationErrorCode: null,
        txtDraft: null,
        txtSavePhase: "idle",
        txtSaveErrorCode: null,
      });
    },
    closeViewer() {
      return publish({
        ...state,
        viewerAssets: Object.freeze([]),
        viewerIndex: -1,
        viewerPhase: "idle",
        viewerErrorCode: null,
        viewerAnnotation: null,
        viewerAssetCursor: null,
        viewerQuery: null,
        viewerPagePhase: "idle",
        viewerPageErrorCode: null,
        viewerPendingAction: null,
        viewerOperationPhase: "idle",
        viewerOperationErrorCode: null,
        txtDraft: null,
        txtSavePhase: "idle",
        txtSaveErrorCode: null,
      });
    },
    setTxtViewMode(mode) {
      return publish({ ...state, txtViewMode: mode });
    },
    setTxtDraft(draft) {
      return publish({ ...state, txtDraft: draft, txtSavePhase: "idle", txtSaveErrorCode: null });
    },
    setTxtSavePhase(phase, errorCode) {
      return publish({ ...state, txtSavePhase: phase, txtSaveErrorCode: errorCode });
    },
    resetTxtEditor() {
      return publish({
        ...state,
        txtDraft: null,
        txtSavePhase: "idle",
        txtSaveErrorCode: null,
      });
    },
    openRenameDialog(assetId) {
      return publish({
        ...state,
        renameDialogPhase: "open",
        renameAssetId: assetId,
        renameDialogError: null,
      });
    },
    setRenameDialog(phase, error) {
      return publish({ ...state, renameDialogPhase: phase, renameDialogError: error });
    },
    closeRenameDialog() {
      return publish({
        ...state,
        renameDialogPhase: "closed",
        renameAssetId: null,
        renameDialogError: null,
      });
    },
    openTrashConfirm(assetIds, directoryIds = []) {
      if (assetIds.length === 0 && directoryIds.length === 0) return false;
      return publish({
        ...state,
        trashConfirmPhase: "open",
        trashConfirmAssetIds: Object.freeze([...assetIds]),
        trashConfirmDirectoryIds: Object.freeze([...directoryIds]),
        trashConfirmError: null,
      });
    },
    setTrashConfirm(phase, error) {
      return publish({ ...state, trashConfirmPhase: phase, trashConfirmError: error });
    },
    closeTrashConfirm() {
      return publish({
        ...state,
        trashConfirmPhase: "closed",
        trashConfirmAssetIds: Object.freeze([]),
        trashConfirmError: null,
        trashConfirmDirectoryIds: Object.freeze([]),
      });
    },
    showUndoToast(operationId, itemCount) {
      return publish({
        ...state,
        undoableOperationId: operationId,
        undoItemCount: itemCount,
        undoToastVisible: true,
        undoBusy: false,
      });
    },
    setUndoBusy(busy) {
      return publish({ ...state, undoBusy: busy });
    },
    hideUndoToast() {
      return publish({
        ...state,
        undoableOperationId: null,
        undoItemCount: 0,
        undoToastVisible: false,
        undoBusy: false,
      });
    },
    setTrashPanelLoading() {
      return publish({
        ...state,
        trashPanelPhase: "loading",
        trashPanelError: null,
        trashOperations: Object.freeze([]),
        trashNextCursor: null,
      });
    },
    applyTrashPage(operations, nextCursor) {
      return publish({
        ...state,
        trashPanelPhase: "ready",
        trashPanelError: null,
        trashOperations: Object.freeze([...operations]),
        trashNextCursor: nextCursor,
      });
    },
    setTrashPanelError(errorCode) {
      return publish({ ...state, trashPanelPhase: "error", trashPanelError: errorCode });
    },
    setTrashPanelBusy(operationId) {
      return publish({ ...state, trashPanelBusyOperationId: operationId });
    },
    closeTrashPanel() {
      return publish({
        ...state,
        trashPanelPhase: "closed",
        trashOperations: Object.freeze([]),
        trashNextCursor: null,
        trashPanelError: null,
        trashPanelBusyOperationId: null,
      });
    },
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  };
  return Object.freeze(store);
}

function buildPathFromDirectory(
  current: readonly GalleryPathSegment[],
  directory: GalleryDirectoryEntry,
): readonly GalleryPathSegment[] {
  // 根目录：路径归零。子目录：先回退到父级位置（若在路径中），再压入当前段。
  if (directory.relative_path.length === 0) return Object.freeze([]);
  const segment: GalleryPathSegment = {
    directory_id: directory.directory_id,
    name: directory.name,
  };
  // 同一目录重复应用（搜索刷新、分页重载）时截断到已有位置，避免路径段重复。
  const existingIndex = current.findIndex((item) => item.directory_id === directory.directory_id);
  if (existingIndex >= 0) {
    return Object.freeze(current.slice(0, existingIndex + 1));
  }
  const parentIndex = current.findIndex((item) => item.directory_id === directory.parent_id);
  const base = parentIndex >= 0 ? current.slice(0, parentIndex + 1) : current;
  return Object.freeze([...base, segment]);
}
