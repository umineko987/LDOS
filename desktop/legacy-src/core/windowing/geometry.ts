import type { WindowRect } from "../applications/definitions";

export const WINDOW_MIN_WIDTH = 360;
export const WINDOW_MIN_HEIGHT = 240;
export const WINDOW_VISIBLE_MARGIN = 32;
export const KEYBOARD_RESIZE_STEP = 16;

export interface WindowViewport {
  readonly width: number;
  readonly height: number;
}

export type ResizeDirection = "right" | "bottom" | "corner";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function clampWindowRect(rect: WindowRect, viewport: WindowViewport): WindowRect {
  const w = Math.max(rect.w, WINDOW_MIN_WIDTH);
  const h = Math.max(rect.h, WINDOW_MIN_HEIGHT);
  return Object.freeze({
    x: clamp(rect.x, WINDOW_VISIBLE_MARGIN - w, viewport.width - WINDOW_VISIBLE_MARGIN),
    y: clamp(rect.y, WINDOW_VISIBLE_MARGIN - h, viewport.height - h),
    w,
    h,
  });
}

export function dragWindowRect(
  startRect: WindowRect,
  delta: Readonly<{ x: number; y: number }>,
  viewport: WindowViewport,
): WindowRect {
  const start = clampWindowRect(startRect, viewport);
  return clampWindowRect({ ...start, x: start.x + delta.x, y: start.y + delta.y }, viewport);
}

export function resizeWindowRect(
  startRect: WindowRect,
  delta: Readonly<{ x: number; y: number }>,
  direction: ResizeDirection,
  viewport: WindowViewport,
): WindowRect {
  const start = clampWindowRect(startRect, viewport);
  const widthDelta = direction === "bottom" ? 0 : delta.x;
  const heightDelta = direction === "right" ? 0 : delta.y;
  const desiredWidth = Math.max(WINDOW_MIN_WIDTH, start.w + widthDelta);
  const desiredHeight = Math.max(WINDOW_MIN_HEIGHT, start.h + heightDelta);
  const horizontalRoom = viewport.width - start.x;
  const verticalRoom = viewport.height - start.y;
  const w = horizontalRoom >= WINDOW_MIN_WIDTH
    ? Math.min(desiredWidth, horizontalRoom)
    : WINDOW_MIN_WIDTH;
  const h = Math.min(desiredHeight, verticalRoom);
  return clampWindowRect({ x: start.x, y: start.y, w, h }, viewport);
}

export function keyboardResizeWindowRect(
  rect: WindowRect,
  direction: ResizeDirection,
  key: string,
  viewport: WindowViewport,
): WindowRect | null {
  const delta = {
    ArrowLeft: { x: -KEYBOARD_RESIZE_STEP, y: 0 },
    ArrowRight: { x: KEYBOARD_RESIZE_STEP, y: 0 },
    ArrowUp: { x: 0, y: -KEYBOARD_RESIZE_STEP },
    ArrowDown: { x: 0, y: KEYBOARD_RESIZE_STEP },
  }[key];
  if (!delta) return null;
  if ((direction === "right" && delta.y !== 0) || (direction === "bottom" && delta.x !== 0)) {
    return null;
  }
  return resizeWindowRect(rect, delta, direction, viewport);
}

export function maximizedWindowRect(viewport: WindowViewport): WindowRect {
  return Object.freeze({ x: 0, y: 0, w: viewport.width, h: viewport.height });
}

export function sameWindowRect(left: WindowRect, right: WindowRect): boolean {
  return left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h;
}
