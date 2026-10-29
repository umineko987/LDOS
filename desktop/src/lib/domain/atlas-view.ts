// 语义地图的相机：世界坐标（atlas 的 x、y ∈ [-1, 1]，y 朝下）↔ 屏幕 CSS 像素，缩放、平移和细节层级。
//
// k = 1 时边长 2 × WORLD_EXTENT 的方框正好放进视口较短的一边，所以整张图四周留一圈边。
// 缩小时画点，放大到 SPRITE_ZOOM 以上换成缩略图；离开时用稍低的阈值，避免在边界上来回闪。

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface WorldRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export type LodMode = "points" | "sprites";

export const HOME_CAMERA: Camera = Object.freeze({ x: 0, y: 0, k: 1 });
export const WORLD_EXTENT = 1.25;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 32;
export const SPRITE_ZOOM = 2.4;
export const SPRITE_ZOOM_EXIT = 2.2;
/** 缩略图模式里同屏最多画多少张；再多就退回画点，单帧工作量有上限。 */
export const MAX_SPRITES = 2500;
export const POINT_RADIUS = 3.5;
export const SPRITE_MIN_PX = 24;
export const SPRITE_MAX_PX = 96;
/** 键盘平移一步占视口短边的比例；缩放一步的倍数。 */
export const KEY_PAN_FRACTION = 0.12;
export const KEY_ZOOM_STEP = 1.4;

/** 世界单位到 CSS 像素的基础比例（k = 1 时）。 */
export function baseScale(viewport: Viewport): number {
  return Math.max(1, Math.min(viewport.width, viewport.height)) / (2 * WORLD_EXTENT);
}

export function pixelsPerUnit(camera: Camera, viewport: Viewport): number {
  return baseScale(viewport) * camera.k;
}

export function worldToScreen(camera: Camera, viewport: Viewport, wx: number, wy: number): [number, number] {
  const scale = pixelsPerUnit(camera, viewport);
  return [viewport.width / 2 + (wx - camera.x) * scale, viewport.height / 2 + (wy - camera.y) * scale];
}

export function screenToWorld(camera: Camera, viewport: Viewport, sx: number, sy: number): [number, number] {
  const scale = pixelsPerUnit(camera, viewport);
  return [(sx - viewport.width / 2) / scale + camera.x, (sy - viewport.height / 2) / scale + camera.y];
}

export function clampZoom(k: number): number {
  if (!Number.isFinite(k)) return HOME_CAMERA.k;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** 以屏幕上的 (sx, sy) 为中心缩放：那一点下面的世界坐标保持不动。 */
export function zoomAt(camera: Camera, viewport: Viewport, sx: number, sy: number, factor: number): Camera {
  const k = clampZoom(camera.k * factor);
  if (k === camera.k) return camera;
  const [wx, wy] = screenToWorld(camera, viewport, sx, sy);
  const scale = baseScale(viewport) * k;
  return { x: wx - (sx - viewport.width / 2) / scale, y: wy - (sy - viewport.height / 2) / scale, k };
}

/** 内容跟着指针移动 (dx, dy) 个 CSS 像素。 */
export function panBy(camera: Camera, viewport: Viewport, dx: number, dy: number): Camera {
  const scale = pixelsPerUnit(camera, viewport);
  return { x: camera.x - dx / scale, y: camera.y - dy / scale, k: camera.k };
}

/** 方向键平移一步：`dx`、`dy` 取 -1、0、1，表示视野往哪边走。 */
export function keyPan(camera: Camera, viewport: Viewport, dx: number, dy: number): Camera {
  const step = Math.min(viewport.width, viewport.height) * KEY_PAN_FRACTION;
  return panBy(camera, viewport, -dx * step, -dy * step);
}

const LINE_PX = 16;

/** 滚轮的缩放倍数；按行滚动的设备（deltaMode = 1）按每行 16px 折算。 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * LINE_PX * 20 : deltaY;
  // 一次跳得太猛（触控板惯性、按页滚动）时截一下。
  return Math.exp(-Math.max(-400, Math.min(400, pixels)) * 0.0015);
}

export function visibleWorldRect(camera: Camera, viewport: Viewport, marginPx = 0): WorldRect {
  const [minX, minY] = screenToWorld(camera, viewport, -marginPx, -marginPx);
  const [maxX, maxY] = screenToWorld(camera, viewport, viewport.width + marginPx, viewport.height + marginPx);
  return { minX, minY, maxX, maxY };
}

/** 细节层级：`visibleCount` 是视野里能画缩略图的点数，超过上限时仍然画点。 */
export function lodMode(k: number, previous: LodMode, visibleCount: number, spritesAvailable: boolean): LodMode {
  if (!spritesAvailable || visibleCount > MAX_SPRITES) return "points";
  const threshold = previous === "sprites" ? SPRITE_ZOOM_EXIT : SPRITE_ZOOM;
  return k >= threshold ? "sprites" : "points";
}

/** 缩略图在屏幕上的边长（CSS 像素），随缩放变大，有上下限。 */
export function spriteSize(k: number): number {
  return Math.min(SPRITE_MAX_PX, Math.max(SPRITE_MIN_PX, 13 * k));
}

/** 把相机移到某一点并放大到至少 `k`。 */
export function focusOn(wx: number, wy: number, k = 4): Camera {
  return { x: wx, y: wy, k: clampZoom(k) };
}
