import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from "./window-geometry.js";

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
    // CSS 已在 window-layer 边界中保留 Dock；layer-local 几何不得再次扣减。
    taskbarHeight: 0,
  };
}
