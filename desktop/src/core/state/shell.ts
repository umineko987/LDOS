import {
  getApplicationDefinition,
  type ApplicationId,
  type DefaultWindowState,
  type WindowRect,
} from "../applications/definitions";
import { sameWindowRect } from "../windowing/geometry";

export type WindowState = DefaultWindowState | "minimized";
export type ShellMenuId = "file" | "edit" | "view" | "window" | "help";
export type ConfirmationIntent = "close" | "minimize" | "leave";

export interface WindowPlacement {
  readonly appId: ApplicationId;
  readonly rect: WindowRect;
  readonly maximized: boolean;
}

export interface WindowRecord {
  readonly appId: ApplicationId;
  readonly state: WindowState;
  readonly rect: WindowRect;
}

export interface ConfirmationState {
  readonly appId: ApplicationId;
  readonly intent: ConfirmationIntent;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
}

export interface ShellState {
  readonly windows: readonly WindowRecord[];
  readonly focusedAppId: ApplicationId | null;
  readonly applicationCenterOpen: boolean;
  readonly openMenu: ShellMenuId | null;
  readonly dockOverflowOpen: boolean;
  readonly confirmation: ConfirmationState | null;
}

export interface ShellPersistence {
  readWindowPlacement(appId: ApplicationId): WindowPlacement | null;
  writeWindowPlacement(placement: WindowPlacement): boolean;
  writeCurrentApp(appId: ApplicationId | null): boolean;
}

export interface ShellStore {
  subscribe(listener: (state: ShellState) => void): () => void;
  getState(): ShellState;
  openApplication(appId: ApplicationId): boolean;
  focusApplication(appId: ApplicationId): boolean;
  restoreApplication(appId: ApplicationId): boolean;
  requestMinimize(appId: ApplicationId): Promise<boolean>;
  requestClose(appId: ApplicationId): Promise<boolean>;
  requestLeave(appId: ApplicationId): Promise<boolean>;
  toggleMaximized(appId: ApplicationId): boolean;
  commitWindowRect(appId: ApplicationId, rect: WindowRect): boolean;
  setApplicationCenter(open: boolean): void;
  setOpenMenu(menu: ShellMenuId | null): void;
  setDockOverflow(open: boolean): void;
  resolveConfirmation(confirmed: boolean): boolean;
  destroy(): void;
}

interface PendingOperation {
  readonly key: string;
  readonly promise: Promise<boolean>;
  readonly resolve: (confirmed: boolean) => void;
}

const CONFIRMATION_COPY = Object.freeze({
  close: Object.freeze({ title: "关闭窗口？", message: "此窗口有未保存的更改。关闭前请确认放弃这些更改。", confirmLabel: "放弃并关闭" }),
  minimize: Object.freeze({ title: "最小化窗口？", message: "此窗口有未保存的更改。最小化前请确认放弃这些更改。", confirmLabel: "放弃并最小化" }),
  leave: Object.freeze({ title: "切换应用？", message: "当前窗口有未保存的更改。切换前请确认放弃这些更改。", confirmLabel: "放弃并切换" }),
});

function copyRect(rect: WindowRect): WindowRect {
  return Object.freeze({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
}

function freezeState(state: ShellState): ShellState {
  return Object.freeze({
    ...state,
    windows: Object.freeze(state.windows.map((record) => Object.freeze({
      ...record,
      rect: copyRect(record.rect),
    }))),
    confirmation: state.confirmation ? Object.freeze({ ...state.confirmation }) : null,
  });
}

function focusedApplication(windows: readonly WindowRecord[]): ApplicationId | null {
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    if (windows[index].state !== "minimized") return windows[index].appId;
  }
  return null;
}

export function isDockHidden(state: ShellState): boolean {
  const focused = state.focusedAppId === null
    ? null
    : state.windows.find(({ appId }) => appId === state.focusedAppId) ?? null;
  return focused?.state === "maximized";
}

export function createShellStore({
  persistence = null,
  hasUnsavedChanges = () => false,
}: {
  readonly persistence?: ShellPersistence | null;
  readonly hasUnsavedChanges?: (appId: ApplicationId) => boolean;
} = {}): ShellStore {
  let state = freezeState({
    windows: [],
    focusedAppId: null,
    applicationCenterOpen: false,
    openMenu: null,
    dockOverflowOpen: false,
    confirmation: null,
  });
  const listeners = new Set<(next: ShellState) => void>();
  let pendingOperation: PendingOperation | null = null;
  let destroyed = false;

  const publish = (next: ShellState): void => {
    if (destroyed) return;
    state = freezeState(next);
    for (const listener of listeners) listener(state);
  };

  const publishWindows = (windows: readonly WindowRecord[]): void => {
    const focusedAppId = focusedApplication(windows);
    const next = {
      ...state,
      windows,
      focusedAppId,
      applicationCenterOpen: false,
      openMenu: null,
      dockOverflowOpen: false,
    };
    publish(next);
    persistence?.writeCurrentApp(focusedAppId);
  };

  const savePlacement = (record: WindowRecord, maximized = record.state === "maximized"): void => {
    persistence?.writeWindowPlacement({ appId: record.appId, rect: record.rect, maximized });
  };

  const recordFor = (appId: ApplicationId): WindowRecord | null => (
    state.windows.find((record) => record.appId === appId) ?? null
  );

  const openApplication = (appId: ApplicationId): boolean => {
    const definition = getApplicationDefinition(appId);
    const existing = recordFor(appId);
    const placement = existing ? null : persistence?.readWindowPlacement(appId) ?? null;
    const opened: WindowRecord = existing
      ? { ...existing, state: existing.state === "minimized" ? "normal" : existing.state }
      : {
          appId,
          state: placement ? (placement.maximized ? "maximized" : "normal") : definition.defaultWindow.state,
          rect: copyRect(placement?.rect ?? definition.defaultWindow.rect),
        };
    const windows = [...state.windows.filter((record) => record.appId !== appId), opened];
    const unchanged = existing !== null
      && existing.state !== "minimized"
      && state.windows.at(-1)?.appId === appId
      && state.focusedAppId === appId
      && !state.applicationCenterOpen
      && state.openMenu === null
      && !state.dockOverflowOpen;
    if (unchanged) return false;
    publishWindows(windows);
    return true;
  };

  const focusApplication = (appId: ApplicationId): boolean => {
    const record = recordFor(appId);
    if (!record || record.state === "minimized" || state.focusedAppId === appId) return false;
    publishWindows([...state.windows.filter((item) => item.appId !== appId), record]);
    return true;
  };

  const minimizeNow = (appId: ApplicationId): boolean => {
    const record = recordFor(appId);
    if (!record || record.state === "minimized") return false;
    const minimized = { ...record, state: "minimized" as const };
    publishWindows(state.windows.map((item) => item.appId === appId ? minimized : item));
    savePlacement(minimized, false);
    return true;
  };

  const closeNow = (appId: ApplicationId): boolean => {
    publishWindows(state.windows.filter((record) => record.appId !== appId));
    return true;
  };

  const needsConfirmation = (appId: ApplicationId): boolean => {
    try {
      return hasUnsavedChanges(appId) === true;
    } catch {
      return true;
    }
  };

  const protectedOperation = (
    appId: ApplicationId,
    intent: ConfirmationIntent,
    operation: () => boolean,
  ): Promise<boolean> => {
    if (!needsConfirmation(appId)) return Promise.resolve(operation());
    const key = `${appId}:${intent}`;
    if (pendingOperation) {
      return pendingOperation.key === key ? pendingOperation.promise : Promise.resolve(false);
    }

    let resolveChoice!: (confirmed: boolean) => void;
    const choice = new Promise<boolean>((resolve) => { resolveChoice = resolve; });
    const promise = choice.then((confirmed) => confirmed && operation()).finally(() => {
      if (pendingOperation?.key === key) pendingOperation = null;
    });
    pendingOperation = { key, promise, resolve: resolveChoice };
    publish({
      ...state,
      applicationCenterOpen: false,
      openMenu: null,
      dockOverflowOpen: false,
      confirmation: { appId, intent, ...CONFIRMATION_COPY[intent] },
    });
    return promise;
  };

  return Object.freeze({
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    openApplication,
    focusApplication,
    restoreApplication: openApplication,
    requestMinimize(appId) {
      return recordFor(appId)
        ? protectedOperation(appId, "minimize", () => minimizeNow(appId))
        : Promise.resolve(false);
    },
    requestClose(appId) {
      return recordFor(appId)
        ? protectedOperation(appId, "close", () => closeNow(appId))
        : Promise.resolve(false);
    },
    requestLeave(appId) {
      return recordFor(appId)
        ? protectedOperation(appId, "leave", () => true)
        : Promise.resolve(false);
    },
    toggleMaximized(appId) {
      const record = recordFor(appId);
      if (!record || record.state === "minimized") return false;
      const changed: WindowRecord = {
        ...record,
        state: record.state === "maximized" ? "normal" : "maximized",
      };
      publishWindows(state.windows.map((item) => item.appId === appId ? changed : item));
      savePlacement(changed);
      return true;
    },
    commitWindowRect(appId, rect) {
      const record = recordFor(appId);
      if (!record || record.state !== "normal" || sameWindowRect(record.rect, rect)) return false;
      const changed = { ...record, rect: copyRect(rect) };
      publishWindows(state.windows.map((item) => item.appId === appId ? changed : item));
      savePlacement(changed, false);
      return true;
    },
    setApplicationCenter(open) {
      if (state.applicationCenterOpen === open) return;
      publish({ ...state, applicationCenterOpen: open, openMenu: null, dockOverflowOpen: false });
    },
    setOpenMenu(menu) {
      if (state.openMenu === menu) return;
      publish({ ...state, openMenu: menu, applicationCenterOpen: false, dockOverflowOpen: false });
    },
    setDockOverflow(open) {
      if (state.dockOverflowOpen === open || isDockHidden(state)) return;
      publish({ ...state, dockOverflowOpen: open, openMenu: null, applicationCenterOpen: false });
    },
    resolveConfirmation(confirmed) {
      if (!pendingOperation) return false;
      const pending = pendingOperation;
      publish({ ...state, confirmation: null });
      pending.resolve(confirmed);
      return true;
    },
    destroy() {
      if (destroyed) return;
      pendingOperation?.resolve(false);
      pendingOperation = null;
      listeners.clear();
      destroyed = true;
    },
  } satisfies ShellStore);
}
