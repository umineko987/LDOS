import {
  GALLERY_PREVIEW_DEFAULTS,
  sanitizeGalleryPreviewState,
  updateGalleryPreviewState,
  type GalleryCollection,
  type GalleryMode,
  type GalleryPreviewState,
  type GallerySort,
} from "./model";

export interface GalleryStore {
  subscribe(listener: (state: GalleryPreviewState) => void): () => void;
  getState(): GalleryPreviewState;
  commit(raw: unknown): boolean;
  selectCollection(collection: GalleryCollection): boolean;
  setQuery(query: string): boolean;
  setSort(sort: GallerySort): boolean;
  setMode(mode: GalleryMode): boolean;
  toggleInspector(): boolean;
  destroy(): void;
}

function statesEqual(left: GalleryPreviewState, right: GalleryPreviewState): boolean {
  return left.phase === right.phase
    && left.collection === right.collection
    && left.query === right.query
    && left.sort === right.sort
    && left.mode === right.mode
    && left.inspectorOpen === right.inspectorOpen;
}

export function createGalleryStore(): GalleryStore {
  let state = sanitizeGalleryPreviewState(GALLERY_PREVIEW_DEFAULTS);
  const listeners = new Set<(state: GalleryPreviewState) => void>();
  let destroyed = false;

  const publish = (next: GalleryPreviewState): boolean => {
    if (destroyed || statesEqual(state, next)) return false;
    state = next;
    for (const listener of [...listeners]) listener(state);
    return true;
  };
  const patch = (next: Partial<Omit<GalleryPreviewState, "phase">>): boolean => (
    publish(updateGalleryPreviewState(state, next))
  );

  return Object.freeze({
    subscribe(listener: (state: GalleryPreviewState) => void) {
      if (destroyed) return () => {};
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    commit(raw: unknown) { return publish(sanitizeGalleryPreviewState(raw)); },
    selectCollection(collection: GalleryCollection) { return patch({ collection }); },
    setQuery(query: string) { return patch({ query }); },
    setSort(sort: GallerySort) { return patch({ sort }); },
    setMode(mode: GalleryMode) { return patch({ mode }); },
    toggleInspector() { return patch({ inspectorOpen: !state.inspectorOpen }); },
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  });
}
