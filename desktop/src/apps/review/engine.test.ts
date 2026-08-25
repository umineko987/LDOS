import { describe, expect, it, vi } from "vitest";

import {
  REVIEW_MAX_CANVAS_DPR,
  calculateReviewCrop,
  calculateReviewLayout,
  createReviewEngine,
  formatReviewMagnification,
  getReviewContainRect,
  normalizeReviewImageDimensions,
  normalizeReviewPointer,
  selectReviewReferenceImage,
  updateReviewMagnification,
  type ReviewEngineFrame,
} from "./engine";
import type { ReviewImage } from "./model";

function image(id: string, width: number, height: number, recommended = false): ReviewImage {
  return Object.freeze({ id, ordinal: 1, readable: true, recommended, selected: true, width, height });
}

class FakeImage {
  crossOrigin: string | null = null;
  loading: "eager" | "lazy" = "lazy";
  decoding: "async" | "sync" | "auto" = "auto";
  naturalWidth = 1200;
  naturalHeight = 1800;
  complete = true;
  isConnected = true;
  dataset: Record<string, string> = {};
  onload: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event | string) => unknown) | null = null;
  private value = "";
  private readonly listeners = new Map<string, Set<EventListener>>();
  set src(value: string) { this.value = value; }
  get src() { return this.value; }
  async decode() { return undefined; }
  addEventListener(type: string, listener: EventListener) {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  removeAttribute(name: string) { if (name === "src") this.value = ""; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 180, height: 120, right: 180, bottom: 120, x: 0, y: 0, toJSON: () => ({}) }; }
}

class FakeCanvas {
  width = 1;
  height = 1;
  hidden = true;
  readonly context = { imageSmoothingEnabled: true, clearRect: vi.fn(), drawImage: vi.fn() };
  getContext(contextId: "2d") { return contextId === "2d" ? this.context : null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 180, height: 120, right: 180, bottom: 120, x: 0, y: 0, toJSON: () => ({}) }; }
}

class FakeCrosshair {
  hidden = true;
  readonly style = { left: "", top: "" };
}

class FakeCard {
  readonly preview = new FakeImage();
  readonly canvas = new FakeCanvas();
  readonly crosshair = new FakeCrosshair();
  readonly attributes = new Map<string, string>();
  querySelector(selector: string) {
    if (selector === "[data-review-engine-image]") return this.preview;
    if (selector === "[data-review-engine-lens]") return this.canvas;
    if (selector === "[data-review-engine-crosshair]") return this.crosshair;
    return null;
  }
  removeAttribute(name: string) { this.attributes.delete(name); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}

class FakeHost {
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly cards = new Map<string, FakeCard>();
  readonly grid = {
    style: { gridTemplateColumns: "" },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }),
  };
  clientHeight = 400;
  constructor(ids: readonly string[]) { for (const id of ids) this.cards.set(id, new FakeCard()); }
  addEventListener(type: string, listener: EventListener) {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  querySelector(selector: string) {
    if (selector === "[data-review-engine-grid]") return this.grid;
    const id = selector.match(/data-review-engine-card="([^"]+)"/)?.[1];
    if (!id) return null;
    const card = this.cards.get(id) ?? null;
    return selector.includes("data-review-engine-image") ? card?.preview ?? null : card;
  }
  querySelectorAll(selector: string) {
    if (selector === "[data-review-engine-lens]") return [...this.cards.values()].map((card) => card.canvas);
    if (selector === "[data-review-engine-crosshair]") return [...this.cards.values()].map((card) => card.crosshair);
    return [];
  }
}

function engineHarness() {
  const frames = new Map<number, FrameRequestCallback>();
  const preloads: FakeImage[] = [];
  const observers: { connected: boolean }[] = [];
  let nextFrame = 1;
  const host = new FakeHost(["image-1", "image-2"]);
  const engine = createReviewEngine({
    host: host as unknown as HTMLElement,
    requestFrame: (callback) => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
    createImage: (() => { const value = new FakeImage(); preloads.push(value); return value as unknown as HTMLImageElement; }),
    createObserver: (() => {
      const state = { connected: false };
      observers.push(state);
      return { observe: () => { state.connected = true; }, disconnect: () => { state.connected = false; } };
    }),
    devicePixelRatio: () => 4,
  });
  return { engine, host, frames, preloads, observers };
}

function frame(overrides: Partial<ReviewEngineFrame> = {}): ReviewEngineFrame {
  const images = Object.freeze([
    Object.freeze({ id: "image-1", url: "http://127.0.0.1:8787/api/v1/crawls/batch/review/images/image-1", width: 1200, height: 1800, readable: true, recommended: false }),
    Object.freeze({ id: "image-2", url: "http://localhost:8787/api/v1/crawls/batch/review/images/image-2", width: 800, height: 1200, readable: true, recommended: true }),
  ]);
  return Object.freeze({ key: "batch:group", images, preloadUrls: Object.freeze([images[1].url]), activeImageId: "image-1", loupeEnabled: true, ...overrides });
}

describe("review engine kernel", () => {
  it("normalizes dimensions, reference choice, and layout without mutating inputs", () => {
    expect(normalizeReviewImageDimensions({ metadata: { w: 1448, h: 2048 }, readable: true })).toMatchObject({ width: 1448, height: 2048 });
    expect(normalizeReviewImageDimensions({ metadata: { w: 0, h: 10 }, readable: true })).toBeNull();
    const pool = [image("one", 800, 1200), image("two", 800, 1200, true)];
    expect(selectReviewReferenceImage(pool)).toMatchObject({ available: true, index: 1 });
    const before = [...pool];
    const layout = calculateReviewLayout(pool, 360, 240);
    expect(layout.readable).toBe(true);
    expect(layout.tileWidth).toBeGreaterThan(0);
    expect(pool).toEqual(before);
    expect(calculateReviewLayout([image("wide", 4000, 100)], 400, 200).ratio).toBe(2.6);
    expect(calculateReviewLayout([], 400, 200).readable).toBe(false);
  });

  it("normalizes contain geometry, pointers, crop boundaries, and magnification", () => {
    expect(getReviewContainRect({ width: 400, height: 200 }, { left: 10, top: 20, width: 500, height: 300 })).toEqual({ left: 10, top: 45, width: 500, height: 250 });
    expect(normalizeReviewPointer({ x: 260, y: 170 }, { left: 10, top: 20, width: 500, height: 300 })).toEqual({ u: 0.5, v: 0.5 });
    expect(normalizeReviewPointer({ x: -1, y: 999 }, { left: 0, top: 0, width: 500, height: 300 })).toEqual({ u: 0, v: 1 });
    const crop = calculateReviewCrop({ target: image("target", 1200, 1800), reference: image("reference", 1448, 2048), outputWidth: 180, outputHeight: 120, magnification: 0.5, u: 1, v: 1 });
    expect(crop).not.toBeNull();
    expect((crop?.x ?? 0) + (crop?.sourceWidth ?? 0)).toBeLessThanOrEqual(1200);
    expect((crop?.y ?? 0) + (crop?.sourceHeight ?? 0)).toBeLessThanOrEqual(1800);
    expect(updateReviewMagnification(0.5, -100)).toBe(0.59);
    expect(updateReviewMagnification(0.5, 100)).toBe(0.42372881355932207);
    expect(updateReviewMagnification(0.5, -1, 1)).toBeCloseTo(0.5134180412656631);
    expect(formatReviewMagnification(0.25)).toBe("0.25x");
    expect(formatReviewMagnification(0.5)).toBe("0.50x");
    expect(formatReviewMagnification(1)).toBe("1:1");
    expect(() => updateReviewMagnification(0, -1)).toThrow(RangeError);
    expect(() => updateReviewMagnification(0.5, 1, 4)).toThrow(TypeError);
  });
});

describe("review imperative engine lifecycle", () => {
  it("requests loopback media with anonymous CORS and releases every resource", async () => {
    const { engine, host, frames, preloads, observers } = engineHarness();
    engine.update(frame());
    engine.setPinned(true);
    await Promise.resolve();
    expect([...host.cards.values()].every(({ preview }) => preview.crossOrigin === "anonymous" && preview.decoding === "async" && preview.loading === "eager")).toBe(true);
    expect(preloads.every((entry) => entry.crossOrigin === "anonymous" && entry.decoding === "async")).toBe(true);
    expect(engine.getResourceCounts()).toMatchObject({ observer: 1, images: 2, preloads: 1 });
    expect(frames.size).toBe(1);
    const [[id, callback]] = frames;
    frames.delete(id);
    callback(0);
    const canvas = host.cards.get("image-1")?.canvas;
    expect(canvas?.width).toBe(180 * REVIEW_MAX_CANVAS_DPR);
    expect(canvas?.context.imageSmoothingEnabled).toBe(false);
    engine.release();
    expect(engine.getResourceCounts()).toEqual({ listeners: 3, observer: 0, frame: 0, images: 0, preloads: 0 });
    expect([...host.cards.values()].every(({ preview }) => preview.src === "")).toBe(true);
    expect(preloads.every((entry) => entry.src === "")).toBe(true);
    expect(observers.every((entry) => !entry.connected)).toBe(true);
    engine.destroy();
    expect(engine.getResourceCounts()).toEqual({ listeners: 0, observer: 0, frame: 0, images: 0, preloads: 0 });
  });

  it("returns to baseline over twenty update/release cycles and rejects unsafe media URLs", () => {
    const { engine } = engineHarness();
    const baseline = engine.getResourceCounts();
    for (let cycle = 0; cycle < 20; cycle += 1) {
      engine.update(frame({ key: `cycle-${cycle}` }));
      engine.release();
      expect(engine.getResourceCounts()).toEqual(baseline);
    }
    for (const url of ["https://private.invalid/image", "http://127.0.0.1/image?token=unsafe", "http://user@127.0.0.1/image", "data:image/png;base64,x"]) {
      const unsafe = frame({ images: Object.freeze([Object.freeze({ ...frame().images[0], url })]), preloadUrls: Object.freeze([]) });
      expect(() => engine.update(unsafe)).toThrow(TypeError);
    }
    engine.destroy();
  });
});
