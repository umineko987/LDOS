import type { ReviewSnapshot } from "./model";

export const REVIEW_LAYOUT_GAP = 12;
const REVIEW_MIN_TILE = 1;
const REVIEW_MIN_RATIO = 0.38;
const REVIEW_MAX_RATIO = 2.6;
const REVIEW_ZOOM_MIN = 1;
const REVIEW_ZOOM_MAX = 8;
const REVIEW_ZOOM_STEP = 1.0015;

export interface ReviewEngineImage {
  readonly id: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly readable: boolean;
  readonly recommended: boolean;
}

export interface ReviewEngineFrame {
  readonly key: string;
  readonly images: readonly ReviewEngineImage[];
  readonly preloadUrls: readonly string[];
  readonly activeImageId: string;
}

export interface NormalizedReviewImage {
  readonly width: number;
  readonly height: number;
  readonly readable: boolean;
  readonly recommended: boolean;
}

export interface ReviewLayout {
  readonly columns: number;
  readonly rows: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly ratio: number;
  readonly readable: boolean;
}

export interface ReviewEngine {
  update(frame: ReviewEngineFrame): void;
  release(): void;
  destroy(): void;
  getResourceCounts(): Readonly<{ listeners: number; observer: number; frame: number; images: number; preloads: number }>;
}

interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

type FrameHandle = number;
type RequestFrame = (callback: FrameRequestCallback) => FrameHandle;
type CancelFrame = (handle: FrameHandle) => void;
type ImageFactory = () => HTMLImageElement | null;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown, code: string): number {
  if (!finite(value) || value <= 0 || value > 1_000_000) throw new TypeError(code);
  return value;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function normalizeReviewImageDimensions(value: unknown): NormalizedReviewImage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !Object.hasOwn(descriptors[key], "value"))) return null;
    const metadataValue = descriptors.metadata?.value;
    const metadata = metadataValue !== null && typeof metadataValue === "object" && !Array.isArray(metadataValue)
      ? Object.getOwnPropertyDescriptors(metadataValue)
      : null;
    if (metadata && Reflect.ownKeys(metadata).some((key) => typeof key !== "string" || !Object.hasOwn(metadata[key], "value"))) return null;
    const width = descriptors.width?.value ?? descriptors.naturalWidth?.value ?? metadata?.w?.value ?? metadata?.width?.value;
    const height = descriptors.height?.value ?? descriptors.naturalHeight?.value ?? metadata?.h?.value ?? metadata?.height?.value;
    const readable = descriptors.readable?.value ?? true;
    const recommended = descriptors.recommended?.value ?? false;
    if (!finite(width) || width <= 0 || width > 1_000_000 || !finite(height) || height <= 0 || height > 1_000_000 || typeof readable !== "boolean" || typeof recommended !== "boolean") return null;
    return freeze({ width, height, readable, recommended });
  } catch {
    return null;
  }
}

function median(values: readonly number[]): number | null {
  const ordered = values.filter(finite).sort((left, right) => left - right);
  return ordered.length ? ordered[Math.floor(ordered.length / 2)] : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (![value, minimum, maximum].every(finite) || minimum > maximum) throw new TypeError("invalid_review_number");
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculateReviewLayout(
  images: readonly unknown[],
  availableWidth: number,
  availableHeight: number,
  gap = REVIEW_LAYOUT_GAP,
  minimumShortEdge = availableWidth < 700 ? 112 : 160,
): ReviewLayout {
  positive(availableWidth, "invalid_review_layout_width");
  positive(availableHeight, "invalid_review_layout_height");
  if (!finite(gap) || gap < 0 || !finite(minimumShortEdge) || minimumShortEdge <= 0) throw new TypeError("invalid_review_layout_options");
  const normalized = images.map(normalizeReviewImageDimensions).filter((image): image is NormalizedReviewImage => Boolean(image));
  if (!normalized.length) return freeze({ columns: 0, rows: 0, tileWidth: 0, tileHeight: 0, ratio: 1, readable: false });
  const ratios = normalized.filter(({ readable }) => readable).map(({ width, height }) => width / height);
  const ratio = clamp(median(ratios) ?? 1, REVIEW_MIN_RATIO, REVIEW_MAX_RATIO);
  let best: { columns: number; rows: number; tileWidth: number; tileHeight: number; readable: boolean; area: number } | null = null;
  for (let columns = 1; columns <= normalized.length; columns += 1) {
    const rows = Math.ceil(normalized.length / columns);
    const cellWidth = Math.max(REVIEW_MIN_TILE, (availableWidth - gap * (columns - 1)) / columns);
    const cellHeight = Math.max(REVIEW_MIN_TILE, (availableHeight - gap * (rows - 1)) / rows);
    const tileWidth = Math.max(REVIEW_MIN_TILE, Math.min(cellWidth, cellHeight * ratio));
    const tileHeight = tileWidth / ratio;
    const candidate = { columns, rows, tileWidth, tileHeight, readable: Math.min(tileWidth, tileHeight) >= minimumShortEdge, area: tileWidth * tileHeight };
    const better = !best
      || (candidate.readable !== best.readable
        ? candidate.readable
        : candidate.area > best.area || (candidate.area === best.area && candidate.columns < best.columns));
    if (better) best = candidate;
  }
  return freeze({
    columns: best!.columns,
    rows: best!.rows,
    tileWidth: best!.tileWidth,
    tileHeight: best!.tileHeight,
    ratio,
    readable: Boolean(ratios.length && best!.readable),
  });
}

/** 组内所有对比图共用的同步缩放变换：滚轮以指针为锚点缩放，拖拽平移。 */
export function updateReviewZoom(
  state: Readonly<{ scale: number; offsetX: number; offsetY: number }>,
  wheel: Readonly<{ deltaY: number; anchorX: number; anchorY: number }>,
  viewport: Readonly<{ width: number; height: number }>,
): Readonly<{ scale: number; offsetX: number; offsetY: number }> {
  if (!finite(state.scale) || state.scale < REVIEW_ZOOM_MIN || state.scale > REVIEW_ZOOM_MAX) throw new RangeError("invalid_review_zoom");
  positive(viewport.width, "invalid_review_zoom_viewport");
  positive(viewport.height, "invalid_review_zoom_viewport");
  const factor = Math.pow(REVIEW_ZOOM_STEP, -wheel.deltaY);
  const scale = clamp(state.scale * factor, REVIEW_ZOOM_MIN, REVIEW_ZOOM_MAX);
  const growth = scale / state.scale;
  return freeze({
    scale,
    offsetX: wheel.anchorX - (wheel.anchorX - state.offsetX) * growth,
    offsetY: wheel.anchorY - (wheel.anchorY - state.offsetY) * growth,
  });
}

export function panReviewZoom(
  state: Readonly<{ scale: number; offsetX: number; offsetY: number }>,
  delta: Readonly<{ x: number; y: number }>,
): Readonly<{ scale: number; offsetX: number; offsetY: number }> {
  if (!finite(state.scale) || state.scale < REVIEW_ZOOM_MIN || state.scale > REVIEW_ZOOM_MAX) throw new RangeError("invalid_review_zoom");
  if (!finite(delta.x) || !finite(delta.y)) throw new TypeError("invalid_review_zoom_pan");
  return freeze({ scale: state.scale, offsetX: state.offsetX + delta.x, offsetY: state.offsetY + delta.y });
}

/** 视窗查看器手感：图片边缘不越出视口——放大时平移被边缘约束，适配（fit）时回到居中。 */
export function clampReviewPan(
  state: Readonly<{ scale: number; offsetX: number; offsetY: number }>,
  imageWidth: number,
  imageHeight: number,
  viewport: Readonly<{ width: number; height: number }>,
): Readonly<{ scale: number; offsetX: number; offsetY: number }> {
  if (!finite(state.scale) || state.scale < REVIEW_ZOOM_MIN || state.scale > REVIEW_ZOOM_MAX) throw new RangeError("invalid_review_zoom");
  if (!finite(imageWidth) || !finite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) throw new TypeError("invalid_review_zoom_image");
  positive(viewport.width, "invalid_review_zoom_viewport");
  positive(viewport.height, "invalid_review_zoom_viewport");
  const fit = Math.min(viewport.width / imageWidth, viewport.height / imageHeight);
  const spanX = Math.max(0, (imageWidth * fit * state.scale - viewport.width) / 2);
  const spanY = Math.max(0, (imageHeight * fit * state.scale - viewport.height) / 2);
  return freeze({ scale: state.scale, offsetX: clamp(state.offsetX, -spanX, spanX) + 0, offsetY: clamp(state.offsetY, -spanY, spanY) + 0 });
}

export function reviewImageWindow(groupCount: number, focusedIndex: number): readonly number[] {
  if (!Number.isInteger(groupCount) || groupCount < 0 || !Number.isInteger(focusedIndex) || (groupCount === 0 ? focusedIndex !== -1 : focusedIndex < 0 || focusedIndex >= groupCount)) throw new TypeError("invalid_review_image_window");
  if (!groupCount) return Object.freeze([]);
  const neighborIndex = focusedIndex + 1 < groupCount ? focusedIndex + 1 : focusedIndex > 0 ? focusedIndex - 1 : -1;
  return Object.freeze(neighborIndex < 0 ? [focusedIndex] : [focusedIndex, neighborIndex]);
}

export function buildReviewEngineFrame(
  snapshot: ReviewSnapshot | null,
  focusedGroupId: string,
  activeImageId: string,
  imageUrl: (reviewId: string, imageId: string) => string,
): ReviewEngineFrame | null {
  if (!snapshot) return null;
  const focusedIndex = snapshot.groupOrder.indexOf(focusedGroupId);
  if (focusedIndex < 0) return null;
  const group = snapshot.groups[focusedGroupId];
  const images = group.imageOrder.map((imageId) => {
    const image = group.images[imageId];
    return freeze({ ...image, url: imageUrl(snapshot.reviewId, image.id) });
  });
  const preloadUrls: string[] = [];
  for (const index of reviewImageWindow(snapshot.groupOrder.length, focusedIndex)) {
    if (index === focusedIndex) continue;
    const neighbor = snapshot.groups[snapshot.groupOrder[index]];
    for (const imageId of neighbor.imageOrder) {
      if (neighbor.images[imageId].readable) preloadUrls.push(imageUrl(snapshot.reviewId, imageId));
    }
  }
  return freeze({
    key: `${snapshot.reviewId}:${snapshot.filter}:${focusedGroupId}`,
    images: Object.freeze(images),
    preloadUrls: Object.freeze(preloadUrls),
    activeImageId,
  });
}

function safeMediaUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.hash || url.search || /(?:token|cookie|password|secret|authorization|oauth|session)/i.test(url.pathname)) throw new TypeError("invalid_review_media_url");
  return url.href;
}

function defaultRequestFrame(callback: FrameRequestCallback): FrameHandle {
  return typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame(callback)
    : globalThis.setTimeout(() => callback(performance.now()), 0) as unknown as number;
}

function defaultCancelFrame(handle: FrameHandle): void {
  if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(handle);
  else globalThis.clearTimeout(handle);
}

function defaultImageFactory(): HTMLImageElement | null {
  try {
    return typeof globalThis.Image === "function" ? new globalThis.Image() : null;
  } catch {
    return null;
  }
}

function defaultResizeObserver(callback: ResizeObserverCallback): ResizeObserverLike | null {
  try {
    return typeof globalThis.ResizeObserver === "function" ? new globalThis.ResizeObserver(callback) : null;
  } catch {
    return null;
  }
}

function sameMedia(left: ReviewEngineFrame | null, right: ReviewEngineFrame): boolean {
  return Boolean(left && left.key === right.key && left.images.length === right.images.length && left.images.every((image, index) => {
    const candidate = right.images[index];
    return image.id === candidate.id && image.url === candidate.url && image.width === candidate.width && image.height === candidate.height && image.readable === candidate.readable && image.recommended === candidate.recommended;
  }) && left.preloadUrls.length === right.preloadUrls.length && left.preloadUrls.every((url, index) => url === right.preloadUrls[index]));
}

export function createReviewEngine({
  host,
  requestFrame = defaultRequestFrame,
  cancelFrame = defaultCancelFrame,
  createImage = defaultImageFactory,
  createObserver = defaultResizeObserver,
}: {
  readonly host: HTMLElement;
  readonly requestFrame?: RequestFrame;
  readonly cancelFrame?: CancelFrame;
  readonly createImage?: ImageFactory;
  readonly createObserver?: (callback: ResizeObserverCallback) => ResizeObserverLike | null;
}): ReviewEngine {
  if (!host || typeof host.addEventListener !== "function") throw new TypeError("invalid_review_engine_host");
  let frame: ReviewEngineFrame | null = null;
  let frameHandle: FrameHandle | null = null;
  let destroyed = false;
  let observerConnected = false;
  let mediaGeneration = 0;
  const attached = new Map<HTMLImageElement, { load: EventListener; error: EventListener }>();
  const preloads: HTMLImageElement[] = [];

  const cancelPendingFrame = (): void => {
    if (frameHandle === null) return;
    cancelFrame(frameHandle);
    frameHandle = null;
  };

  const draw = (): void => {
    frameHandle = null;
    if (!frame) return;
    const grid = host.querySelector<HTMLElement>("[data-review-engine-grid]");
    if (grid) {
      const rect = grid.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && frame.images.length) {
        const layout = calculateReviewLayout(frame.images, rect.width, rect.height);
        grid.style.gridTemplateColumns = `repeat(${Math.max(1, layout.columns)}, minmax(0, 1fr))`;
      }
    }
  };

  const schedule = (): void => {
    if (destroyed || frameHandle !== null) return;
    frameHandle = requestFrame(() => draw());
  };

  const observer = createObserver(() => schedule());
  const reconnectObserver = (): void => {
    observer?.disconnect();
    observerConnected = false;
    if (frame && observer) {
      observer.observe(host);
      observerConnected = true;
    }
  };

  const releaseMedia = (): void => {
    mediaGeneration += 1;
    for (const [image, listeners] of attached) {
      image.removeEventListener("load", listeners.load);
      image.removeEventListener("error", listeners.error);
      image.removeAttribute("src");
      image.dataset.reviewEngineDecoded = "false";
    }
    attached.clear();
    for (const image of preloads.splice(0)) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
    }
  };

  const loadMedia = (): void => {
    if (!frame) return;
    const generation = mediaGeneration;
    for (const image of frame.images) {
      if (!image.readable) continue;
      const element = host.querySelector<HTMLImageElement>(`[data-review-engine-card="${image.id}"] [data-review-engine-image]`);
      if (!element) continue;
      const markDecoded = async (): Promise<void> => {
        try {
          if (typeof element.decode === "function") await element.decode();
          if (generation !== mediaGeneration || !attached.has(element) || !element.isConnected || !element.naturalWidth || !element.naturalHeight) return;
          element.dataset.reviewEngineDecoded = "true";
          schedule();
        } catch {
          if (generation === mediaGeneration && attached.has(element)) element.dataset.reviewEngineDecoded = "false";
        }
      };
      const load: EventListener = () => { void markDecoded(); };
      const error: EventListener = () => {
        if (generation !== mediaGeneration || !attached.has(element)) return;
        element.dataset.reviewEngineDecoded = "false";
        element.removeAttribute("src");
        schedule();
      };
      element.crossOrigin = "anonymous";
      element.decoding = "async";
      element.loading = "eager";
      element.addEventListener("load", load);
      element.addEventListener("error", error);
      attached.set(element, { load, error });
      element.src = safeMediaUrl(image.url);
      if (element.complete && element.naturalWidth) void markDecoded();
    }
    for (const value of frame.preloadUrls) {
      const image = createImage();
      if (!image) continue;
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.src = safeMediaUrl(value);
      preloads.push(image);
    }
  };

  const engine: ReviewEngine = {
    update(nextFrame) {
      if (destroyed) return;
      for (const image of nextFrame.images) safeMediaUrl(image.url);
      for (const url of nextFrame.preloadUrls) safeMediaUrl(url);
      const replaceMedia = !sameMedia(frame, nextFrame);
      frame = freeze({ ...nextFrame, images: Object.freeze([...nextFrame.images]), preloadUrls: Object.freeze([...nextFrame.preloadUrls]) });
      if (replaceMedia) {
        cancelPendingFrame();
        observer?.disconnect();
        observerConnected = false;
        releaseMedia();
        loadMedia();
        reconnectObserver();
      }
      schedule();
    },
    release() {
      if (destroyed && frame === null) return;
      cancelPendingFrame();
      observer?.disconnect();
      observerConnected = false;
      frame = null;
      releaseMedia();
    },
    destroy() {
      if (destroyed) return;
      engine.release();
      destroyed = true;
    },
    getResourceCounts() {
      return freeze({ listeners: 0, observer: observerConnected ? 1 : 0, frame: frameHandle === null ? 0 : 1, images: attached.size, preloads: preloads.length });
    },
  };
  return Object.freeze(engine);
}
