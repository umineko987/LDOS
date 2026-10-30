// 查看器的纯逻辑：缩放和平移的约束、翻页、底部缩略条的窗口、打开时的飞入变换。
// 手感沿用旧版图库查看器：
// 缩放下限是“适配”（1），上限 8 倍，滚轮每格 1.12 倍并以指针为中心；平移被图片边缘约束。

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const WHEEL_FACTOR = 1.12;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface PanState {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const RESET: PanState = Object.freeze({ scale: 1, x: 0, y: 0 });

const positive = (value: number) => Number.isFinite(value) && value > 0;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * 把平移限制在图片边缘以内：图片（object-fit: contain 后再乘 scale）比视口小的方向不能平移。
 * 尺寸未知（图片还没加载）时只约束缩放。
 */
export function clampPan(state: PanState, natural: Size | null, viewport: Size): PanState {
  const scale = clamp(Number.isFinite(state.scale) ? state.scale : 1, MIN_SCALE, MAX_SCALE);
  if (!natural || !positive(natural.width) || !positive(natural.height) || !positive(viewport.width) || !positive(viewport.height)) {
    return { scale, x: 0, y: 0 };
  }
  const fit = Math.min(viewport.width / natural.width, viewport.height / natural.height);
  const spanX = Math.max(0, (natural.width * fit * scale - viewport.width) / 2);
  const spanY = Math.max(0, (natural.height * fit * scale - viewport.height) / 2);
  // `+ 0` 把 -0 变成 0。
  return { scale, x: clamp(state.x, -spanX, spanX) + 0, y: clamp(state.y, -spanY, spanY) + 0 };
}

/** 滚轮缩放。`pointer` 是指针相对视口中心的坐标；缩放后指针下的那一点保持不动。 */
export function wheelZoom(
  state: PanState,
  deltaY: number,
  pointer: { readonly x: number; readonly y: number },
  natural: Size | null,
  viewport: Size,
): PanState {
  if (deltaY === 0) return state;
  const factor = deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
  const scale = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);
  const ratio = scale / state.scale;
  return clampPan(
    { scale, x: pointer.x - (pointer.x - state.x) * ratio, y: pointer.y - (pointer.y - state.y) * ratio },
    natural,
    viewport,
  );
}

/** 拖动平移：从按下时的状态加上指针位移。 */
export function dragPan(start: PanState, dx: number, dy: number, natural: Size | null, viewport: Size): PanState {
  return clampPan({ scale: start.scale, x: start.x + dx, y: start.y + dy }, natural, viewport);
}

/** 上一张 / 下一张：两端停住，不循环。 */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return clamp(Math.trunc(index) + Math.trunc(delta), 0, count - 1);
}

/** 底部缩略条只渲染当前项附近 `radius` 张：返回 [start, end)。 */
export function stripWindow(index: number, count: number, radius = 12): readonly [number, number] {
  if (count <= 0) return [0, 0];
  const size = Math.min(count, radius * 2 + 1);
  const start = clamp(index - radius, 0, count - size);
  return [start, start + size];
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** object-fit: contain 时图片实际占的矩形。 */
export function containedRect(box: Rect, natural: Size): Rect | null {
  if (!positive(box.width) || !positive(box.height) || !positive(natural.width) || !positive(natural.height)) return null;
  const ratio = natural.width / natural.height;
  const width = Math.min(box.width, box.height * ratio);
  const height = width / ratio;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

/** 打开时从缩略图飞到大图：起始帧的 transform（终点是 none）。只用 translate 和 scale。 */
export function flightTransform(from: Rect, to: Rect): string | null {
  if (!positive(from.width) || !positive(from.height) || !positive(to.width) || !positive(to.height)) return null;
  const dx = from.x + from.width / 2 - (to.x + to.width / 2);
  const dy = from.y + from.height / 2 - (to.y + to.height / 2);
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  return `translate(${round(dx)}px, ${round(dy)}px) scale(${round(sx, 4)}, ${round(sy, 4)})`;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor + 0;
}

/** 查看器里的一张图。 */
export interface ViewerItem {
  readonly id: string;
  readonly name: string;
  /** 原图地址。 */
  readonly src: string;
  /** 缩略图：原图加载完之前垫在下面，也用于底部缩略条。 */
  readonly thumb?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  /** 工具栏里名字旁边的一行说明（尺寸、来源……）。 */
  readonly meta?: string;
}
