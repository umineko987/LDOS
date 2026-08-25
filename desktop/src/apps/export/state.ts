import { EXPORT_PREVIEW_DEFAULTS, sanitizeExportPreviewState, type ExportPreviewState } from "./model";

export interface ExportStore {
  subscribe(listener: (state: ExportPreviewState) => void): () => void;
  getState(): ExportPreviewState;
  commit(raw: unknown): boolean;
  destroy(): void;
}

export function createExportStore(): ExportStore {
  let state = sanitizeExportPreviewState(EXPORT_PREVIEW_DEFAULTS);
  const listeners = new Set<(state: ExportPreviewState) => void>();
  let destroyed = false;

  return Object.freeze({
    subscribe(listener: (state: ExportPreviewState) => void) {
      if (destroyed) return () => {};
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    commit(raw: unknown) {
      const next = sanitizeExportPreviewState(raw);
      if (destroyed || state === next) return false;
      state = next;
      for (const listener of [...listeners]) listener(state);
      return true;
    },
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  });
}
