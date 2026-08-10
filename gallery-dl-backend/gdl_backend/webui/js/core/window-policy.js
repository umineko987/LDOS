import {
  clampRect,
  maximizedRect,
  nextRectForDrag,
  nextRectForResize,
} from "./window-geometry.js";

export const KEYBOARD_RESIZE_STEP = 16;

export function deriveWindowViews(windowStack, focusedAppId, mobileViewport = false) {
  if (!Array.isArray(windowStack)) throw new TypeError("窗口视图来源必须是数组");
  const mobile = mobileViewport === true;
  return Object.freeze(windowStack.map((record) => {
    const minimized = record.windowState === "minimized";
    const open = !minimized;
    return Object.freeze({
      appId: record.appId,
      open,
      minimized,
      maximized: mobile || record.windowState === "maximized",
      visible: open && (!mobile || record.appId === focusedAppId),
      rect: Object.freeze({ ...record.rect }),
    });
  }));
}

export function deriveWindowRenderPlan(windowStack, focusedAppId, mobileViewport = false) {
  const views = deriveWindowViews(windowStack, focusedAppId, mobileViewport);
  return Object.freeze(windowStack.map((record, index) => Object.freeze({
    record,
    view: views[index],
    zIndex: index,
  })));
}

export function sameWindowRect(left, right) {
  return Boolean(left && right)
    && left.x === right.x
    && left.y === right.y
    && left.w === right.w
    && left.h === right.h;
}

export function isForcedMobileMaximized(record, mobileViewport = false) {
  return Boolean(record && mobileViewport === true);
}

export function isEffectivelyMaximized(record, mobileViewport = false) {
  return Boolean(
    record
    && (record.windowState === "maximized" || isForcedMobileMaximized(record, mobileViewport))
  );
}

export function normalWindowRect(record, viewport, geometryOptions = {}) {
  return clampRect(record.rect, viewport, geometryOptions);
}

export function displayedWindowRect(
  record,
  viewport,
  geometryOptions = {},
  mobileViewport = false,
  maximized = isEffectivelyMaximized(record, mobileViewport),
) {
  return maximized
    ? maximizedRect(viewport, geometryOptions)
    : normalWindowRect(record, viewport, geometryOptions);
}

export function nextPointerInteractionRect(interaction, point, viewport, geometryOptions = {}) {
  const pointerDelta = {
    x: point.clientX - interaction.startClientX,
    y: point.clientY - interaction.startClientY,
  };
  if (interaction.type === "drag") {
    return nextRectForDrag(
      interaction.startRect,
      pointerDelta,
      viewport,
      geometryOptions,
    );
  }
  return nextRectForResize(
    interaction.startRect,
    {
      x: interaction.resizeDirection === "bottom" ? 0 : pointerDelta.x,
      y: interaction.resizeDirection === "right" ? 0 : pointerDelta.y,
    },
    viewport,
    geometryOptions,
  );
}

export function nextKeyboardResizeRect(
  record,
  direction,
  key,
  viewport,
  geometryOptions = {},
) {
  const deltas = {
    ArrowLeft: { x: -KEYBOARD_RESIZE_STEP, y: 0 },
    ArrowRight: { x: KEYBOARD_RESIZE_STEP, y: 0 },
    ArrowUp: { x: 0, y: -KEYBOARD_RESIZE_STEP },
    ArrowDown: { x: 0, y: KEYBOARD_RESIZE_STEP },
  };
  const delta = deltas[key];
  if (!delta) return null;
  if (
    (direction === "right" && delta.y !== 0)
    || (direction === "bottom" && delta.x !== 0)
  ) return null;
  return nextRectForResize(record.rect, delta, viewport, geometryOptions);
}

export function deriveWindowManagerSnapshot(currentView, record, mobileViewport = false) {
  return Object.freeze({
    appId: currentView.appId,
    visibility: currentView.visibility,
    maximized: currentView.appId === null
      ? false
      : isEffectivelyMaximized(record, mobileViewport),
    preferredWindowState: currentView.windowState,
  });
}
