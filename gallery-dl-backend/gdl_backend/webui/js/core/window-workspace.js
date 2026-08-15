import { setElementInert } from "./dom.js";
import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from "./window-geometry.js";

export const WINDOW_WORKSPACE_MODES = Object.freeze({
  normal: "normal",
  maximized: "maximized",
});

export function deriveWindowWorkspaceMode(windowStack, focusedAppId) {
  if (!Array.isArray(windowStack)) throw new TypeError("窗口工作区来源必须是数组");
  if (focusedAppId !== null && typeof focusedAppId !== "string") {
    throw new TypeError("窗口工作区焦点无效");
  }
  const focusedWindow = focusedAppId === null
    ? null
    : windowStack.find((record) => record?.appId === focusedAppId) || null;
  return focusedWindow?.windowState === "maximized"
    ? WINDOW_WORKSPACE_MODES.maximized
    : WINDOW_WORKSPACE_MODES.normal;
}

export function syncWindowWorkspaceMode(windowLayer, dock, mode) {
  if (!(windowLayer instanceof HTMLElement)) throw new TypeError("窗口层无效");
  if (!(dock instanceof HTMLElement)) throw new TypeError("Dock 宿主无效");
  if (!Object.values(WINDOW_WORKSPACE_MODES).includes(mode)) {
    throw new TypeError("窗口工作区模式无效");
  }

  const maximized = mode === WINDOW_WORKSPACE_MODES.maximized;
  // Marker first: the next geometry read must observe the new layer boundary.
  windowLayer.setAttribute("data-window-workspace", mode);
  if (maximized) {
    setElementInert(dock, true);
    dock.toggleAttribute("hidden", true);
    dock.hidden = true;
    dock.setAttribute("aria-hidden", "true");
  } else {
    dock.removeAttribute("aria-hidden");
    setElementInert(dock, false);
    dock.toggleAttribute("hidden", false);
    dock.hidden = false;
  }
  return mode;
}

export function measureWindowLayerViewport(
  windowLayer,
  documentObject = globalThis.document,
) {
  if (!(windowLayer instanceof HTMLElement)) throw new TypeError("窗口层无效");
  const bounds = windowLayer.getBoundingClientRect();
  const width = bounds.width || windowLayer.clientWidth;
  const height = bounds.height || windowLayer.clientHeight;
  return {
    width: Math.max(32, width || documentObject?.documentElement?.clientWidth || 1280),
    height: Math.max(32, height || documentObject?.documentElement?.clientHeight || 720),
  };
}

export function windowLayerGeometryOptions() {
  return {
    minW: WINDOW_MIN_WIDTH,
    minH: WINDOW_MIN_HEIGHT,
    // CSS owns either the normal Dock reserve or the maximized full-height layer;
    // layer-local geometry must not subtract that boundary a second time.
    taskbarHeight: 0,
  };
}
