import type { GalleryCollection, GalleryMode, GallerySort } from "./model";
import type { GalleryStore } from "./state";

export interface GalleryController {
  activate(): void;
  deactivate(): void;
  selectCollection(collection: GalleryCollection): boolean;
  setQuery(query: string): boolean;
  setSort(sort: GallerySort): boolean;
  setMode(mode: GalleryMode): boolean;
  toggleInspector(): boolean;
  destroy(): void;
}

export function createGalleryController(store: GalleryStore): GalleryController {
  let active = false;
  let destroyed = false;
  const run = (operation: () => boolean): boolean => active && !destroyed && operation();

  const controller: GalleryController = {
    activate() {
      if (destroyed) return;
      active = true;
    },
    deactivate() { active = false; },
    selectCollection(collection) { return run(() => store.selectCollection(collection)); },
    setQuery(query) { return run(() => store.setQuery(query)); },
    setSort(sort) { return run(() => store.setSort(sort)); },
    setMode(mode) { return run(() => store.setMode(mode)); },
    toggleInspector() { return run(() => store.toggleInspector()); },
    destroy() {
      if (destroyed) return;
      controller.deactivate();
      destroyed = true;
      store.destroy();
    },
  };
  return Object.freeze(controller);
}
