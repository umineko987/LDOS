import type { ApplicationId } from "../applications/definitions";

export interface ShellState {
  readonly openedAppIds: readonly ApplicationId[];
  readonly focusedAppId: ApplicationId | null;
}

export interface ShellPersistence {
  writeCurrentApp(appId: ApplicationId | null): boolean;
}

export interface ShellStore {
  subscribe(listener: (state: ShellState) => void): () => void;
  getState(): ShellState;
  openApplication(appId: ApplicationId): boolean;
  registerUnsavedChanges(appId: ApplicationId, reader: () => boolean, discard?: () => void, prepare?: () => Promise<boolean>): () => void;
  hasUnsavedChanges(): boolean;
  destroy(): void;
}

export function createShellStore({
  persistence = null,
}: {
  readonly persistence?: ShellPersistence | null;
} = {}): ShellStore {
  let state: ShellState = Object.freeze({
    openedAppIds: Object.freeze([]),
    focusedAppId: null,
  });
  const listeners = new Set<(state: ShellState) => void>();
  const unsavedReaders = new Map<ApplicationId, { readonly reader: () => boolean }>();
  let destroyed = false;

  return Object.freeze({
    subscribe(listener) {
      listener(state);
      if (!destroyed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getState: () => state,
    openApplication(appId) {
      if (destroyed || state.focusedAppId === appId) return false;
      state = Object.freeze({
        openedAppIds: state.openedAppIds.includes(appId)
          ? state.openedAppIds
          : Object.freeze([...state.openedAppIds, appId]),
        focusedAppId: appId,
      });
      for (const listener of listeners) listener(state);
      persistence?.writeCurrentApp(appId);
      return true;
    },
    registerUnsavedChanges(appId, reader) {
      if (destroyed) return () => {};
      const registration = { reader };
      unsavedReaders.set(appId, registration);
      return () => {
        if (unsavedReaders.get(appId) === registration) unsavedReaders.delete(appId);
      };
    },
    hasUnsavedChanges() {
      for (const { reader } of unsavedReaders.values()) {
        try {
          if (reader() === true) return true;
        } catch {
          return true;
        }
      }
      return false;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      unsavedReaders.clear();
    },
  } satisfies ShellStore);
}
