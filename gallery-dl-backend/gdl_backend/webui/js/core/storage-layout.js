import {
  DEFAULT_APP_ID,
  getApplicationDefinitionById,
} from "./app-definitions.js";
import { hasExactDataKeys, ownDataValue, parseStorageObject } from "./storage-snapshot.js";
import { clampRect } from "./window-geometry.js";

const WINDOW_STATES = new Set(["normal", "maximized", "minimized"]);
const WINDOW_RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const DEFAULT_WINDOW_RECT = Object.freeze({ x: 160, y: 64, w: 800, h: 560 });

export function normalizeViewport(viewport) {
  if (!hasExactDataKeys(viewport, ["width", "height"])) return DEFAULT_VIEWPORT;
  const width = ownDataValue(viewport, "width");
  const height = ownDataValue(viewport, "height");
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return DEFAULT_VIEWPORT;
  }
  return { width, height };
}

function projectWindowRect(value) {
  if (!hasExactDataKeys(value, WINDOW_RECT_KEYS)) throw new TypeError("窗口位置无效");
  const rect = {};
  for (const key of WINDOW_RECT_KEYS) {
    const field = ownDataValue(value, key);
    if (!Number.isFinite(field)) throw new TypeError("窗口位置无效");
    rect[key] = field;
  }
  if (rect.w < 360 || rect.h < 240) throw new TypeError("窗口尺寸过小");
  return rect;
}

export function clampWindowRect(rect, viewport, geometryOptions = {}) {
  const projected = projectWindowRect(rect);
  const normalizedViewport = normalizeViewport(viewport);
  try {
    return clampRect(projected, normalizedViewport, geometryOptions);
  } catch {
    // 读取端保持 T11 的静默自愈：无效视口选项退回无任务栏的安全几何。
    return clampRect(projected, normalizedViewport);
  }
}

function projectWindowRecord(
  value,
  { readyOnly = false, viewport = null, geometryOptions = {} } = {},
) {
  if (!hasExactDataKeys(value, ["appId", "windowState", "rect"])) {
    throw new TypeError("窗口记录无效");
  }
  const appId = ownDataValue(value, "appId");
  const app = typeof appId === "string" ? getApplicationDefinitionById(appId) : null;
  if (!app) throw new TypeError("应用 ID 无效");
  if (readyOnly && app.availability !== "ready") return null;
  const windowState = ownDataValue(value, "windowState");
  if (!WINDOW_STATES.has(windowState)) throw new TypeError("窗口状态无效");
  const rect = viewport
    ? clampWindowRect(ownDataValue(value, "rect"), viewport, geometryOptions)
    : projectWindowRect(ownDataValue(value, "rect"));
  return { appId, windowState, rect };
}

function deduplicateWindowRecords(windows) {
  const result = [];
  for (const windowRecord of windows) {
    const existing = result.findIndex((item) => item.appId === windowRecord.appId);
    if (existing >= 0) result.splice(existing, 1);
    result.push(windowRecord);
  }
  return result;
}

export function createDefaultWindowLayout(
  viewport = DEFAULT_VIEWPORT,
  geometryOptions = {},
) {
  return [{
    appId: DEFAULT_APP_ID,
    windowState: getApplicationDefinitionById(DEFAULT_APP_ID).defaultWindowState,
    rect: clampWindowRect(DEFAULT_WINDOW_RECT, viewport, geometryOptions),
  }];
}

export function deserializeWindowLayout(serialized, viewport, geometryOptions = {}) {
  const stored = parseStorageObject(serialized);
  if (!stored || !hasExactDataKeys(stored, ["windows"])) return null;
  const rawWindows = ownDataValue(stored, "windows");
  if (!Array.isArray(rawWindows)) return null;
  const normalizedViewport = normalizeViewport(viewport);
  const windows = [];
  try {
    for (const value of rawWindows) {
      if (!hasExactDataKeys(value, ["appId", "windowState", "rect"])) return null;
      const appId = ownDataValue(value, "appId");
      if (typeof appId !== "string") return null;
      const app = getApplicationDefinitionById(appId);
      if (!app || app.availability !== "ready") continue;
      windows.push(projectWindowRecord(value, {
        readyOnly: true,
        viewport: normalizedViewport,
        geometryOptions,
      }));
    }
  } catch {
    return null;
  }
  return deduplicateWindowRecords(windows);
}

export function projectWindowLayout(windows) {
  if (!Array.isArray(windows)) throw new TypeError("窗口布局必须是数组");
  const projected = [];
  for (const value of windows) {
    const windowRecord = projectWindowRecord(value, { readyOnly: true });
    if (windowRecord) projected.push(windowRecord);
  }
  return deduplicateWindowRecords(projected);
}

export function serializeWindowLayout(windows) {
  return JSON.stringify({ windows: projectWindowLayout(windows) });
}

export function restoreWindowLayout(serialized, viewport, geometryOptions = {}) {
  const normalizedViewport = normalizeViewport(viewport);
  return deserializeWindowLayout(serialized, normalizedViewport, geometryOptions)
    ?? createDefaultWindowLayout(normalizedViewport, geometryOptions);
}
