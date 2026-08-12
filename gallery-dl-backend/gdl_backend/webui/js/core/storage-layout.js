import {
  applicationDefinitions,
  getApplicationDefinitionById,
} from "./app-definitions.js";
import { hasExactDataKeys, ownDataValue, parseStorageObject } from "./storage-snapshot.js";
import { clampRect } from "./window-geometry.js";

const WINDOW_STATES = new Set(["normal", "maximized", "minimized"]);
const WINDOW_RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const MAX_PLACEMENTS = 128;

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
    return clampRect(projected, normalizedViewport);
  }
}

function projectPlacement(value, { viewport = null, geometryOptions = {} } = {}) {
  if (!hasExactDataKeys(value, ["appId", "rect", "maximized"])) {
    throw new TypeError("窗口位置偏好无效");
  }
  const appId = ownDataValue(value, "appId");
  if (typeof appId !== "string" || !getApplicationDefinitionById(appId)) {
    throw new TypeError("应用 ID 无效");
  }
  const maximized = ownDataValue(value, "maximized");
  if (typeof maximized !== "boolean") throw new TypeError("最大化偏好无效");
  const projectedRect = projectWindowRect(ownDataValue(value, "rect"));
  const rect = viewport
    ? clampWindowRect(projectedRect, viewport, geometryOptions)
    : projectedRect;
  if (
    viewport
    && WINDOW_RECT_KEYS.some((key) => rect[key] !== projectedRect[key])
  ) {
    throw new RangeError("窗口位置偏好超出规范化几何边界");
  }
  return { appId, rect, maximized };
}

function projectLegacyRecord(value, viewport, geometryOptions) {
  if (!hasExactDataKeys(value, ["appId", "windowState", "rect"])) {
    throw new TypeError("旧窗口记录无效");
  }
  const appId = ownDataValue(value, "appId");
  if (typeof appId !== "string" || !getApplicationDefinitionById(appId)) {
    throw new TypeError("应用 ID 无效");
  }
  const windowState = ownDataValue(value, "windowState");
  if (!WINDOW_STATES.has(windowState)) throw new TypeError("窗口状态无效");
  return {
    appId,
    rect: clampWindowRect(ownDataValue(value, "rect"), viewport, geometryOptions),
    maximized: windowState === "maximized",
  };
}

function requireUniquePlacements(values, projector) {
  if (!Array.isArray(values) || values.length > MAX_PLACEMENTS) {
    throw new TypeError("窗口位置偏好必须是有限数组");
  }
  const seen = new Set();
  const placements = [];
  for (const value of values) {
    const placement = projector(value);
    if (seen.has(placement.appId)) throw new TypeError("窗口位置偏好包含重复应用");
    seen.add(placement.appId);
    placements.push(placement);
  }
  return placements;
}

export function projectWindowPlacements(placements) {
  return requireUniquePlacements(placements, (value) => projectPlacement(value));
}

export function serializeWindowPlacements(placements) {
  return JSON.stringify({ placements: projectWindowPlacements(placements) });
}

export function deserializeWindowPlacements(serialized, viewport, geometryOptions = {}) {
  const stored = parseStorageObject(serialized);
  if (!stored || !hasExactDataKeys(stored, ["placements"])) return null;
  const normalizedViewport = normalizeViewport(viewport);
  try {
    return requireUniquePlacements(
      ownDataValue(stored, "placements"),
      (value) => projectPlacement(value, {
        viewport: normalizedViewport,
        geometryOptions,
      }),
    );
  } catch {
    return null;
  }
}

export function migrateLegacyWindowLayout(serialized, viewport, geometryOptions = {}) {
  const stored = parseStorageObject(serialized);
  if (!stored || !hasExactDataKeys(stored, ["windows"])) return null;
  const normalizedViewport = normalizeViewport(viewport);
  try {
    const migrated = requireUniquePlacements(
      ownDataValue(stored, "windows"),
      (value) => projectLegacyRecord(value, normalizedViewport, geometryOptions),
    );
    const byId = new Map(migrated.map((placement) => [placement.appId, placement]));
    return applicationDefinitions
      .filter((definition) => byId.has(definition.id))
      .map((definition) => byId.get(definition.id));
  } catch {
    return null;
  }
}

export function placementForApplication(placements, appId) {
  if (!Array.isArray(placements) || typeof appId !== "string") return null;
  const placement = placements.find((item) => item?.appId === appId);
  return placement ? { ...placement, rect: { ...placement.rect } } : null;
}

export function placementsFromWindowStack(windows, previousPlacements = []) {
  const previous = new Map(projectWindowPlacements(previousPlacements).map((item) => [item.appId, item]));
  if (!Array.isArray(windows)) throw new TypeError("窗口栈必须是数组");
  for (const record of windows) {
    if (!hasExactDataKeys(record, ["appId", "windowState", "rect"])) {
      throw new TypeError("窗口记录无效");
    }
    const appId = ownDataValue(record, "appId");
    const app = typeof appId === "string" ? getApplicationDefinitionById(appId) : null;
    const windowState = ownDataValue(record, "windowState");
    if (!app || !WINDOW_STATES.has(windowState)) throw new TypeError("窗口记录无效");
    const rect = projectWindowRect(ownDataValue(record, "rect"));
    previous.set(appId, { appId, rect, maximized: windowState === "maximized" });
  }
  return applicationDefinitions
    .filter((definition) => previous.has(definition.id))
    .map((definition) => previous.get(definition.id));
}

// v1 helpers remain exported for one-version compatibility tests and migration callers.
export function deserializeWindowLayout(serialized, viewport, geometryOptions = {}) {
  const placements = migrateLegacyWindowLayout(serialized, viewport, geometryOptions);
  return placements?.map((placement) => ({
    appId: placement.appId,
    windowState: placement.maximized ? "maximized" : "normal",
    rect: placement.rect,
  })) ?? null;
}

export function projectWindowLayout(windows) {
  return placementsFromWindowStack(windows).map((placement) => ({
    appId: placement.appId,
    windowState: placement.maximized ? "maximized" : "normal",
    rect: placement.rect,
  }));
}

export function serializeWindowLayout(windows) {
  return JSON.stringify({ windows: projectWindowLayout(windows) });
}

export function createDefaultWindowLayout() {
  return [];
}

export function restoreWindowLayout(serialized, viewport, geometryOptions = {}) {
  return deserializeWindowLayout(serialized, viewport, geometryOptions) ?? [];
}
