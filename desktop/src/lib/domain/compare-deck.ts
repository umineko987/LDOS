// 去重卡组的纯逻辑：卡片怎么排、组内所有图共用的同步缩放和平移。
// 从旧版 legacy-src/apps/review/engine.ts 移植（calculateReviewLayout、updateReviewZoom、panReviewZoom、clampReviewPan），
// 去掉了旧版对不可信输入的防御（这里的尺寸来自已生成类型的接口），不合法的数值按“没有尺寸”处理而不是抛错。

export const DECK_GAP = 12;
const MIN_TILE = 1;
const MIN_RATIO = 0.38;
const MAX_RATIO = 2.6;
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
/** 每单位 deltaY 的缩放倍数（触控板细粒度、鼠标滚轮一格约 1.16 倍）。 */
export const ZOOM_STEP = 1.0015;

export interface DeckImage {
  readonly width: number;
  readonly height: number;
  readonly readable: boolean;
}

export interface DeckLayout {
  readonly columns: number;
  readonly rows: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** 卡片的宽高比（可读图片宽高比的中位数，限制在 0.38–2.6）。 */
  readonly ratio: number;
  /** 最短边够不够看清（宽屏 160px，窄屏 112px）。 */
  readonly readable: boolean;
}

export interface Zoom {
  readonly scale: number;
  /** 相对卡片中心的平移，像素。 */
  readonly x: number;
  readonly y: number;
}

export const ZOOM_RESET: Zoom = Object.freeze({ scale: 1, x: 0, y: 0 });

const finite = (value: number) => Number.isFinite(value);
const positive = (value: number) => finite(value) && value > 0;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function median(values: readonly number[]): number | null {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered.length ? ordered[Math.floor(ordered.length / 2)]! : null;
}

/**
 * 在给定区域里给 N 张卡片选列数：优先让每张的短边够看清，其次面积最大，面积相同取列少的。
 * 每张卡片同样大小（宽高比取中位数），这样同步缩放的像素平移对每张都成立。
 */
export function deckLayout(
  images: readonly DeckImage[],
  width: number,
  height: number,
  gap = DECK_GAP,
  minimumShortEdge = width < 700 ? 112 : 160,
): DeckLayout {
  if (!positive(width) || !positive(height) || images.length === 0) {
    return { columns: 0, rows: 0, tileWidth: 0, tileHeight: 0, ratio: 1, readable: false };
  }
  const ratios = images.filter((image) => image.readable && positive(image.width) && positive(image.height)).map((image) => image.width / image.height);
  const ratio = clamp(median(ratios) ?? 1, MIN_RATIO, MAX_RATIO);
  const spacing = Math.max(0, finite(gap) ? gap : DECK_GAP);
  let best: (DeckLayout & { area: number }) | null = null;
  for (let columns = 1; columns <= images.length; columns += 1) {
    const rows = Math.ceil(images.length / columns);
    const cellWidth = Math.max(MIN_TILE, (width - spacing * (columns - 1)) / columns);
    const cellHeight = Math.max(MIN_TILE, (height - spacing * (rows - 1)) / rows);
    const tileWidth = Math.max(MIN_TILE, Math.min(cellWidth, cellHeight * ratio));
    const tileHeight = tileWidth / ratio;
    const readable = Math.min(tileWidth, tileHeight) >= minimumShortEdge;
    const area = tileWidth * tileHeight;
    const better = !best || (readable !== best.readable ? readable : area > best.area);
    if (better) best = { columns, rows, tileWidth, tileHeight, ratio, readable, area };
  }
  const { area: _area, ...layout } = best!;
  return { ...layout, readable: ratios.length > 0 && layout.readable };
}

/** 滚轮缩放：`anchor` 是指针相对卡片中心的坐标，缩放后指针下的那一点不动。 */
export function zoomAt(state: Zoom, deltaY: number, anchor: { readonly x: number; readonly y: number }): Zoom {
  if (!finite(deltaY) || deltaY === 0) return state;
  const scale = clamp(state.scale * Math.pow(ZOOM_STEP, -deltaY), ZOOM_MIN, ZOOM_MAX);
  const growth = scale / state.scale;
  return { scale, x: anchor.x - (anchor.x - state.x) * growth, y: anchor.y - (anchor.y - state.y) * growth };
}

export function panBy(state: Zoom, delta: { readonly x: number; readonly y: number }): Zoom {
  if (!finite(delta.x) || !finite(delta.y)) return state;
  return { scale: state.scale, x: state.x + delta.x, y: state.y + delta.y };
}

/**
 * 以焦点卡片的图为准约束平移（视窗查看器手感）：放大后图片边缘不越出卡片，适配时回到居中。
 * 尺寸未知时只约束缩放、平移归零。
 */
export function clampZoom(state: Zoom, image: { readonly width: number; readonly height: number } | null, tile: { readonly width: number; readonly height: number }): Zoom {
  const scale = clamp(finite(state.scale) ? state.scale : 1, ZOOM_MIN, ZOOM_MAX);
  if (!image || !positive(image.width) || !positive(image.height) || !positive(tile.width) || !positive(tile.height)) {
    return { scale, x: 0, y: 0 };
  }
  const fit = Math.min(tile.width / image.width, tile.height / image.height);
  const spanX = Math.max(0, (image.width * fit * scale - tile.width) / 2);
  const spanY = Math.max(0, (image.height * fit * scale - tile.height) / 2);
  // `+ 0` 把 -0 变成 0。
  return { scale, x: clamp(finite(state.x) ? state.x : 0, -spanX, spanX) + 0, y: clamp(finite(state.y) ? state.y : 0, -spanY, spanY) + 0 };
}

export function isZoomed(state: Zoom): boolean {
  return state.scale !== 1 || state.x !== 0 || state.y !== 0;
}

/** 卡片里 `<img>` 的 transform（只动 transform，WebKitGTK 上也走合成层）。 */
export function zoomTransform(state: Zoom): string {
  return `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
}
