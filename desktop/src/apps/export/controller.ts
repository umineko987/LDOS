import type { ExportStore } from "./state";

export interface ExportController {
  activate(): boolean;
  deactivate(): void;
  destroy(): void;
}

export function createExportController(store: ExportStore): ExportController {
  let active = false;
  let destroyed = false;

  const controller: ExportController = {
    activate() {
      if (active || destroyed) return false;
      active = true;
      return true;
    },
    deactivate() { active = false; },
    destroy() {
      if (destroyed) return;
      controller.deactivate();
      destroyed = true;
      store.destroy();
    },
  };
  return Object.freeze(controller);
}
