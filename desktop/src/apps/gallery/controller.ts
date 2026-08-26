import { validateGalleryQuery, type GallerySearchScope, type GalleryTxtState } from "./model";
import type { GalleryDirectoryRequest, GalleryService } from "./service";
import type { GalleryStore, GalleryViewMode } from "./state";

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
  openSource(sourceId: string): Promise<boolean>;
  openDirectory(directoryId: string): Promise<boolean>;
  navigateToBreadcrumb(index: number): Promise<boolean>;
  setIncludeDescendants(value: boolean): Promise<boolean>;
  setTxtStateFilter(state: GalleryTxtState | null): Promise<boolean>;
  setSearchScope(scope: GallerySearchScope): Promise<boolean>;
  submitQuery(query: string): Promise<boolean>;
  setViewMode(mode: GalleryViewMode): boolean;
  loadMore(): Promise<boolean>;
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
    },
    refreshSources() {
      if (!active || destroyed) return Promise.resolve(false);
      return loadSources();
    },
    async openSource(sourceId) {
      if (!active || destroyed) return false;
      const state = store.getState();
      const source = state.sources.find((item) => item.source_id === sourceId);
      if (!source || source.root_directory_id === null) {
        // 未扫描或正在扫描的来源：清空内容区（重扫描写入流程随 G3 接入）。
        store.patch({
          activeSourceId: source ? source.source_id : null,
          rootDirectoryId: null,
          path: [],
          currentDirectory: null,
          directories: [],
          assets: [],
          directoryCursor: null,
          assetCursor: null,
        });
        return false;
      }
      store.openSource(sourceId, source.root_directory_id);
      return loadPage(false);
    },
    async openDirectory(directoryId) {
      if (!active || destroyed) return false;
      return loadPageForDirectory(directoryId);
    },
    async navigateToBreadcrumb(index) {
      if (!active || destroyed) return false;
      const state = store.getState();
      if (state.rootDirectoryId === null) return false;
      if (index < 0 || index >= state.path.length) {
        return loadPageForDirectory(state.rootDirectoryId);
      }
      return loadPageForDirectory(state.path[index].directory_id);
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

  return Object.freeze(controller);
}
