import type { ReviewSnapshot } from "./model";

export const REVIEW_REFERENCE_PIXEL_HEIGHT = 160;
export const REVIEW_MIN_MAGNIFICATION = 0.25;
export const REVIEW_MAX_MAGNIFICATION = 1;
export const REVIEW_DEFAULT_MAGNIFICATION = 0.5;
export const REVIEW_MAX_CANVAS_DPR = 2;
const REVIEW_LAYOUT_GAP = 12;
const REVIEW_MIN_TILE = 1;
const REVIEW_MIN_RATIO = 0.38;
const REVIEW_MAX_RATIO = 2.6;
const MAGNIFICATION_STEP_BASE = 1.18;

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
  readonly loupeEnabled: boolean;
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

export interface ReviewLoupeState {
  readonly active: boolean;
  readonly pinned: boolean;
  readonly magnification: number;
}

export interface ReviewEngine {
  update(frame: ReviewEngineFrame): void;
  setPinned(pinned: boolean): void;
  release(): void;
  destroy(): void;
  getLoupeState(): ReviewLoupeState;
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

export function selectReviewReferenceImage(images: readonly unknown[]): Readonly<{ available: boolean; index: number; image: NormalizedReviewImage | null }> {
  if (!Array.isArray(images)) throw new TypeError("invalid_review_images");
  const readable = images
    .map((value, index) => ({ index, image: normalizeReviewImageDimensions(value) }))
    .filter((entry): entry is { index: number; image: NormalizedReviewImage } => Boolean(entry.image?.readable));
  if (!readable.length) return freeze({ available: false, index: -1, image: null });
  const selected = readable.find(({ image }) => image.recommended) ?? readable[0];
  return freeze({ available: true, index: selected.index, image: selected.image });
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

export function getReviewContainRect(
  image: unknown,
  container: Readonly<{ left: number; top: number; width: number; height: number }>,
): Readonly<{ left: number; top: number; width: number; height: number }> | null {
  const dimensions = normalizeReviewImageDimensions(image);
  if (!dimensions?.readable || !finite(container.left) || !finite(container.top) || !finite(container.width) || container.width <= 0 || !finite(container.height) || container.height <= 0) return null;
  const scale = Math.min(container.width / dimensions.width, container.height / dimensions.height);
  const width = dimensions.width * scale;
  const height = dimensions.height * scale;
  return freeze({
    left: container.left + (container.width - width) / 2,
    top: container.top + (container.height - height) / 2,
    width,
    height,
  });
}

export function normalizeReviewPointer(
  point: Readonly<{ x: number; y: number }>,
  content: Readonly<{ left: number; top: number; width: number; height: number }>,
): Readonly<{ u: number; v: number }> {
  if (!finite(point.x) || !finite(point.y) || !finite(content.left) || !finite(content.top) || !finite(content.width) || content.width <= 0 || !finite(content.height) || content.height <= 0) throw new TypeError("invalid_review_pointer");
  return freeze({
    u: clamp((point.x - content.left) / content.width, 0, 1),
    v: clamp((point.y - content.top) / content.height, 0, 1),
  });
}

export function projectReviewPointer(
  pointer: Readonly<{ u: number; v: number }>,
  content: Readonly<{ left: number; top: number; width: number; height: number }>,
  container: Readonly<{ left: number; top: number }>,
): Readonly<{ left: number; top: number }> {
  if (!finite(pointer.u) || !finite(pointer.v) || !finite(container.left) || !finite(container.top)) throw new TypeError("invalid_review_pointer_projection");
  if (pointer.u < 0 || pointer.u > 1 || pointer.v < 0 || pointer.v > 1 || !finite(content.left) || !finite(content.top) || !finite(content.width) || content.width <= 0 || !finite(content.height) || content.height <= 0) {
    throw new TypeError("invalid_review_pointer_projection");
  }
  return freeze({
    left: content.left - container.left + pointer.u * content.width,
    top: content.top - container.top + pointer.v * content.height,
  });
}

export function calculateReviewCrop({
  target,
  reference,
  outputWidth,
  outputHeight,
  magnification = REVIEW_DEFAULT_MAGNIFICATION,
  u = 0.5,
  v = 0.5,
}: {
  readonly target: unknown;
  readonly reference: unknown;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly magnification?: number;
  readonly u?: number;
  readonly v?: number;
}): Readonly<{ x: number; y: number; sourceWidth: number; sourceHeight: number }> | null {
  const targetImage = normalizeReviewImageDimensions(target);
  const referenceImage = normalizeReviewImageDimensions(reference);
  if (!targetImage || !referenceImage) throw new TypeError("invalid_review_crop_image");
  if (!targetImage.readable || !referenceImage.readable) return null;
  positive(outputWidth, "invalid_review_crop_width");
  positive(outputHeight, "invalid_review_crop_height");
  if (!finite(magnification) || magnification < REVIEW_MIN_MAGNIFICATION || magnification > REVIEW_MAX_MAGNIFICATION) throw new TypeError("invalid_review_magnification");
  const normalizedU = clamp(u, 0, 1);
  const normalizedV = clamp(v, 0, 1);
  const theoreticalHeight = (REVIEW_REFERENCE_PIXEL_HEIGHT / magnification) * (targetImage.height / referenceImage.height);
  const theoreticalWidth = theoreticalHeight * (outputWidth / outputHeight);
  const fitScale = Math.min(1, targetImage.width / theoreticalWidth, targetImage.height / theoreticalHeight);
  const sourceWidth = theoreticalWidth * fitScale;
  const sourceHeight = theoreticalHeight * fitScale;
  const maximumX = Math.max(0, targetImage.width - sourceWidth);
  const maximumY = Math.max(0, targetImage.height - sourceHeight);
  const x = clamp(normalizedU * targetImage.width - sourceWidth / 2, 0, maximumX);
  const y = clamp(normalizedV * targetImage.height - sourceHeight / 2, 0, maximumY);
  return freeze({ x, y, sourceWidth, sourceHeight });
}

export function updateReviewMagnification(current: number, delta: number, deltaMode = 0, pageSize = 800): number {
  if (!finite(current) || current < REVIEW_MIN_MAGNIFICATION || current > REVIEW_MAX_MAGNIFICATION) throw new RangeError("invalid_review_magnification");
  if (!finite(delta) || !Number.isInteger(deltaMode) || ![0, 1, 2].includes(deltaMode) || !finite(pageSize) || pageSize <= 0) throw new TypeError("invalid_review_magnification");
  const normalizedDelta = delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageSize : 1);
  const steps = clamp(-normalizedDelta / 100, -3, 3);
  return clamp(current * Math.pow(MAGNIFICATION_STEP_BASE, steps), REVIEW_MIN_MAGNIFICATION, REVIEW_MAX_MAGNIFICATION);
}

export function formatReviewMagnification(value: number): string {
  if (!finite(value) || value < REVIEW_MIN_MAGNIFICATION || value > REVIEW_MAX_MAGNIFICATION) throw new RangeError("invalid_review_magnification");
  return value === REVIEW_MAX_MAGNIFICATION ? "1:1" : `${value.toFixed(2)}x`;
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
  loupeEnabled: boolean,
  imageUrl: (batchId: string, imageId: string) => string,
): ReviewEngineFrame | null {
  if (!snapshot) return null;
  const focusedIndex = snapshot.groupOrder.indexOf(focusedGroupId);
  if (focusedIndex < 0) return null;
  const group = snapshot.groups[focusedGroupId];
  const images = group.imageOrder.map((imageId) => {
    const image = group.images[imageId];
    return freeze({ ...image, url: imageUrl(snapshot.batchId, image.id) });
  });
  const preloadUrls: string[] = [];
  for (const index of reviewImageWindow(snapshot.groupOrder.length, focusedIndex)) {
    if (index === focusedIndex) continue;
    const neighbor = snapshot.groups[snapshot.groupOrder[index]];
    for (const imageId of neighbor.imageOrder) {
      if (neighbor.images[imageId].readable) preloadUrls.push(imageUrl(snapshot.batchId, imageId));
    }
  }
  return freeze({
    key: `${snapshot.batchId}:${snapshot.filter}:${focusedGroupId}`,
    images: Object.freeze(images),
    preloadUrls: Object.freeze(preloadUrls),
    activeImageId,
    loupeEnabled,
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

function decodedReviewImage(image: ReviewEngineImage, preview: HTMLImageElement): NormalizedReviewImage | null {
  if (!preview.complete || preview.naturalWidth <= 0 || preview.naturalHeight <= 0) return null;
  return freeze({
    width: preview.naturalWidth,
    height: preview.naturalHeight,
    readable: image.readable,
    recommended: image.recommended,
  });
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
  devicePixelRatio = () => globalThis.devicePixelRatio || 1,
  onLoupeState = () => {},
}: {
  readonly host: HTMLElement;
  readonly requestFrame?: RequestFrame;
  readonly cancelFrame?: CancelFrame;
  readonly createImage?: ImageFactory;
  readonly createObserver?: (callback: ResizeObserverCallback) => ResizeObserverLike | null;
  readonly devicePixelRatio?: () => number;
  readonly onLoupeState?: (state: ReviewLoupeState) => void;
}): ReviewEngine {
  if (!host || typeof host.addEventListener !== "function") throw new TypeError("invalid_review_engine_host");
  let frame: ReviewEngineFrame | null = null;
  let frameHandle: FrameHandle | null = null;
  let pointer: Readonly<{ u: number; v: number }> | null = null;
  let magnification = REVIEW_DEFAULT_MAGNIFICATION;
  let pinned = false;
  let destroyed = false;
  let observerConnected = false;
  let mediaGeneration = 0;
  const attached = new Map<HTMLImageElement, { load: EventListener; error: EventListener }>();
  const preloads: HTMLImageElement[] = [];

  const loupeState = (): ReviewLoupeState => freeze({ active: Boolean(frame?.loupeEnabled && pointer), pinned, magnification });
  const publishLoupe = (): void => {
    try { onLoupeState(loupeState()); } catch { /* UI projection must not break media cleanup. */ }
  };
  const cancelPendingFrame = (): void => {
    if (frameHandle === null) return;
    cancelFrame(frameHandle);
    frameHandle = null;
  };

  const hideLenses = (): void => {
    for (const canvas of host.querySelectorAll<HTMLCanvasElement>("[data-review-engine-lens]")) canvas.hidden = true;
    for (const crosshair of host.querySelectorAll<HTMLElement>("[data-review-engine-crosshair]")) crosshair.hidden = true;
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
    if (!frame.loupeEnabled || !pointer) {
      hideLenses();
      return;
    }
    const reference = selectReviewReferenceImage(frame.images);
    const referenceItem = reference.available ? frame.images[reference.index] : null;
    const referenceCard = referenceItem ? host.querySelector<HTMLElement>(`[data-review-engine-card="${referenceItem.id}"]`) : null;
    const referencePreview = referenceCard?.querySelector<HTMLImageElement>("[data-review-engine-image]") ?? null;
    const referenceImage = referenceItem && referencePreview ? decodedReviewImage(referenceItem, referencePreview) : null;
    if (!referenceImage) {
      hideLenses();
      return;
    }
    for (const image of frame.images) {
      if (!image.readable) continue;
      const card = host.querySelector<HTMLElement>(`[data-review-engine-card="${image.id}"]`);
      const preview = card?.querySelector<HTMLImageElement>("[data-review-engine-image]");
      const canvas = card?.querySelector<HTMLCanvasElement>("[data-review-engine-lens]");
      const crosshair = card?.querySelector<HTMLElement>("[data-review-engine-crosshair]");
      if (!card || !preview || !canvas || !crosshair) continue;
      const targetImage = decodedReviewImage(image, preview);
      if (!targetImage) continue;
      const previewRect = preview.getBoundingClientRect();
      const contentRect = getReviewContainRect(targetImage, previewRect);
      if (!contentRect) continue;
      const crosshairPoint = projectReviewPointer(pointer, contentRect, previewRect);
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(REVIEW_MAX_CANVAS_DPR, Math.max(1, devicePixelRatio()));
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      const crop = calculateReviewCrop({ target: targetImage, reference: referenceImage, outputWidth: canvas.width, outputHeight: canvas.height, magnification, ...pointer });
      const context = crop ? canvas.getContext("2d") : null;
      if (!crop || !context) continue;
      try {
        context.imageSmoothingEnabled = false;
        context.drawImage(preview, crop.x, crop.y, crop.sourceWidth, crop.sourceHeight, 0, 0, canvas.width, canvas.height);
        canvas.hidden = false;
        crosshair.style.left = `${crosshairPoint.left}px`;
        crosshair.style.top = `${crosshairPoint.top}px`;
        crosshair.hidden = false;
        card.removeAttribute("data-review-engine-error");
      } catch {
        canvas.width = 1;
        canvas.height = 1;
        canvas.hidden = true;
        crosshair.hidden = true;
        card.setAttribute("data-review-engine-error", "canvas-unavailable");
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
    for (const canvas of host.querySelectorAll<HTMLCanvasElement>("[data-review-engine-lens]")) {
      canvas.width = 1;
      canvas.height = 1;
      canvas.hidden = true;
    }
    hideLenses();
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
  const updatePointer = (event: PointerEvent | WheelEvent): boolean => {
    const target = event.target as Element | null;
    const card = target?.closest?.("[data-review-engine-card]") as HTMLElement | null;
    const imageId = card?.dataset.reviewEngineCard ?? "";
    const item = frame?.images.find((image) => image.id === imageId);
    const preview = card?.querySelector<HTMLImageElement>("[data-review-engine-image]");
    if (!item || !preview) return false;
    const targetImage = decodedReviewImage(item, preview);
    if (!targetImage) return false;
    const content = getReviewContainRect(targetImage, preview.getBoundingClientRect());
    if (!content) return false;
    pointer = normalizeReviewPointer({ x: event.clientX, y: event.clientY }, content);
    return true;
  };

  const pointerMove = (event: PointerEvent): void => {
    if (!frame?.loupeEnabled || pinned || !updatePointer(event)) return;
    publishLoupe();
    schedule();
  };

  const pointerLeave = (): void => {
    if (pinned) return;
    pointer = null;
    hideLenses();
    publishLoupe();
  };

  const wheel = (event: WheelEvent): void => {
    const target = event.target as Element | null;
    if (!(event.ctrlKey || event.metaKey) || !frame?.loupeEnabled || !target?.closest?.("[data-review-engine-card]") || (!pinned && !updatePointer(event))) return;
    event.preventDefault();
    magnification = updateReviewMagnification(magnification, event.deltaY, event.deltaMode, Math.max(1, host.clientHeight || 800));
    publishLoupe();
    schedule();
  };

  host.addEventListener("pointermove", pointerMove);
  host.addEventListener("pointerleave", pointerLeave);
  host.addEventListener("wheel", wheel, { passive: false });

  const engine: ReviewEngine = {
    update(nextFrame) {
      if (destroyed) return;
      for (const image of nextFrame.images) safeMediaUrl(image.url);
      for (const url of nextFrame.preloadUrls) safeMediaUrl(url);
      const replaceMedia = !sameMedia(frame, nextFrame);
      frame = freeze({ ...nextFrame, images: Object.freeze([...nextFrame.images]), preloadUrls: Object.freeze([...nextFrame.preloadUrls]) });
      if (replaceMedia) {
        cancelPendingFrame();
        pointer = null;
        pinned = false;
        observer?.disconnect();
        observerConnected = false;
        releaseMedia();
        loadMedia();
        reconnectObserver();
      } else if (!frame.loupeEnabled) {
        pointer = null;
        pinned = false;
        hideLenses();
      }
      publishLoupe();
      schedule();
    },
    setPinned(nextPinned) {
      if (destroyed || !frame?.loupeEnabled) return;
      pinned = Boolean(nextPinned);
      if (pinned && !pointer) pointer = freeze({ u: 0.5, v: 0.5 });
      publishLoupe();
      schedule();
    },
    release() {
      if (destroyed && frame === null) return;
      cancelPendingFrame();
      observer?.disconnect();
      observerConnected = false;
      frame = null;
      pointer = null;
      pinned = false;
      releaseMedia();
      publishLoupe();
    },
    destroy() {
      if (destroyed) return;
      engine.release();
      destroyed = true;
      host.removeEventListener("pointermove", pointerMove);
      host.removeEventListener("pointerleave", pointerLeave);
      host.removeEventListener("wheel", wheel);
    },
    getLoupeState: loupeState,
    getResourceCounts() {
      return freeze({ listeners: destroyed ? 0 : 3, observer: observerConnected ? 1 : 0, frame: frameHandle === null ? 0 : 1, images: attached.size, preloads: preloads.length });
    },
  };
  publishLoupe();
  return Object.freeze(engine);
}
