import { getApplicationDefinitionById } from "./app-definitions.js";
import { ACTION_TYPES, UnknownActionError } from "./store-contract.js";
import { isPlainObject } from "./store-data.js";

const WINDOW_STATES = new Set(["normal", "maximized", "minimized"]);
const WINDOW_ACTION_TYPES = new Set([
  ACTION_TYPES.UI_WINDOW_OPENED,
  ACTION_TYPES.UI_WINDOW_CLOSED,
  ACTION_TYPES.UI_WINDOW_FOCUSED,
  ACTION_TYPES.UI_WINDOW_MOVED,
  ACTION_TYPES.UI_WINDOW_STATE_CHANGED,
  ACTION_TYPES.UI_START_MENU_CHANGED,
]);

export const DEFAULT_WINDOW_RECT = Object.freeze({ x: 160, y: 64, w: 800, h: 560 });

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function requireAppId(value) {
  if (typeof value !== "string" || !getApplicationDefinitionById(value)) {
    throw new TypeError("应用 ID 无效");
  }
  return value;
}

function requireWindowState(value) {
  if (!WINDOW_STATES.has(value)) throw new TypeError("窗口状态无效");
  return value;
}

function requireWindowRect(value) {
  if (!isPlainObject(value)) throw new TypeError("窗口位置无效");
  const keys = Object.keys(value);
  if (keys.length !== 4 || !["x", "y", "w", "h"].every((key) => keys.includes(key))) {
    throw new TypeError("窗口位置无效");
  }
  const rect = {};
  for (const key of ["x", "y", "w", "h"]) {
    if (!Number.isFinite(value[key])) throw new TypeError("窗口位置无效");
    rect[key] = value[key];
  }
  if (rect.w < 360 || rect.h < 240) throw new TypeError("窗口尺寸过小");
  return rect;
}

function requireWindowRecord(value) {
  if (!isPlainObject(value)) throw new TypeError("窗口记录无效");
  const keys = Object.keys(value);
  if (
    keys.length !== 3
    || !["appId", "windowState", "rect"].every((key) => keys.includes(key))
  ) {
    throw new TypeError("窗口记录无效");
  }
  return {
    appId: requireAppId(value.appId),
    windowState: requireWindowState(value.windowState),
    rect: requireWindowRect(value.rect),
  };
}

export function normalizeWindowStack(windows) {
  if (!Array.isArray(windows)) throw new TypeError("窗口栈必须是数组");
  const result = [];
  for (const value of windows) {
    const windowRecord = requireWindowRecord(value);
    const existing = result.findIndex((item) => item.appId === windowRecord.appId);
    if (existing >= 0) result.splice(existing, 1);
    result.push(windowRecord);
  }
  return result;
}

export function deriveFocusedAppId(windows) {
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    if (windows[index].windowState !== "minimized") return windows[index].appId;
  }
  return null;
}

export function withDerivedWindowFocus(state) {
  if (!isPlainObject(state?.ui) || !Array.isArray(state.ui.windows)) return state;
  const focusedAppId = deriveFocusedAppId(state.ui.windows);
  if (state.ui.focusedAppId === focusedAppId) return state;
  return { ...state, ui: { ...state.ui, focusedAppId } };
}

export function createInitialUiState(windows = []) {
  const normalizedWindows = normalizeWindowStack(windows);
  return {
    windows: normalizedWindows,
    focusedAppId: deriveFocusedAppId(normalizedWindows),
    startMenuOpen: false,
  };
}

export function prepareInitialWindowState(clonedInitialState) {
  if (isPlainObject(clonedInitialState.ui) && Array.isArray(clonedInitialState.ui.windows)) {
    const windows = normalizeWindowStack(clonedInitialState.ui.windows);
    clonedInitialState.ui = {
      ...clonedInitialState.ui,
      windows,
      focusedAppId: deriveFocusedAppId(windows),
    };
  }
  return clonedInitialState;
}

function defaultWindowRecord(appId) {
  const app = getApplicationDefinitionById(requireAppId(appId));
  return {
    appId,
    windowState: requireWindowState(app.defaultWindowState),
    rect: { ...DEFAULT_WINDOW_RECT },
  };
}

export function isWindowActionType(type) {
  return WINDOW_ACTION_TYPES.has(type);
}

export function reduceWindowState(state, action) {
  switch (action.type) {
    case ACTION_TYPES.UI_WINDOW_OPENED: {
      const appId = requireAppId(action.payload?.appId);
      const existingIndex = state.ui.windows.findIndex((item) => item.appId === appId);
      const existing = existingIndex >= 0 ? state.ui.windows[existingIndex] : null;
      const opened = existing
        ? {
            ...existing,
            windowState: existing.windowState === "minimized" ? "normal" : existing.windowState,
          }
        : defaultWindowRecord(appId);
      const windows = state.ui.windows.filter((item) => item.appId !== appId);
      windows.push(opened);
      return {
        ...state,
        ui: { ...state.ui, windows, startMenuOpen: false },
      };
    }
    case ACTION_TYPES.UI_WINDOW_CLOSED: {
      const appId = requireAppId(action.payload?.appId);
      const windows = state.ui.windows.filter((item) => item.appId !== appId);
      return windows.length === state.ui.windows.length
        ? state
        : { ...state, ui: { ...state.ui, windows } };
    }
    case ACTION_TYPES.UI_WINDOW_FOCUSED: {
      const appId = requireAppId(action.payload?.appId);
      const existing = state.ui.windows.find((item) => item.appId === appId);
      if (!existing || existing.windowState === "minimized") return state;
      if (state.ui.windows[state.ui.windows.length - 1]?.appId === appId) return state;
      const windows = state.ui.windows.filter((item) => item.appId !== appId);
      windows.push(existing);
      return { ...state, ui: { ...state.ui, windows } };
    }
    case ACTION_TYPES.UI_WINDOW_MOVED: {
      const appId = requireAppId(action.payload?.appId);
      const rect = requireWindowRect(action.payload?.rect);
      let changed = false;
      const windows = state.ui.windows.map((item) => {
        if (item.appId !== appId) return item;
        changed = true;
        return { ...item, rect };
      });
      return changed ? { ...state, ui: { ...state.ui, windows } } : state;
    }
    case ACTION_TYPES.UI_WINDOW_STATE_CHANGED: {
      const appId = requireAppId(action.payload?.appId);
      const windowState = requireWindowState(action.payload?.windowState);
      let changed = false;
      const windows = state.ui.windows.map((item) => {
        if (item.appId !== appId || item.windowState === windowState) return item;
        changed = true;
        return { ...item, windowState };
      });
      return changed ? { ...state, ui: { ...state.ui, windows } } : state;
    }
    case ACTION_TYPES.UI_START_MENU_CHANGED:
      return {
        ...state,
        ui: {
          ...state.ui,
          startMenuOpen: requireBoolean(action.payload?.open, "START 菜单状态"),
        },
      };
    default:
      throw new UnknownActionError(action.type);
  }
}

export function selectWindowView(state) {
  const focused = state.ui.focusedAppId === null
    ? null
    : state.ui.windows.find((item) => item.appId === state.ui.focusedAppId) || null;
  const windowRecord = focused || state.ui.windows[state.ui.windows.length - 1] || null;
  if (!windowRecord) {
    return { appId: null, windowState: "normal", visibility: "closed" };
  }
  return {
    appId: windowRecord.appId,
    windowState: windowRecord.windowState === "minimized"
      ? "normal"
      : windowRecord.windowState,
    visibility: windowRecord.windowState === "minimized" ? "minimized" : "open",
  };
}
