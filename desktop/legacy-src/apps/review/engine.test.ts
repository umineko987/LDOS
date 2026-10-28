import { describe, expect, it } from "vitest";

import {
  calculateReviewLayout,
  createReviewEngine,
  normalizeReviewImageDimensions,
  clampReviewPan,
  panReviewZoom,
  updateReviewZoom,
  type ReviewEngineFrame,
} from "./engine";
import type { ReviewImage } from "./model";

function image(id: string, width: number, height: number, recommended = false): ReviewImage {
  return Object.freeze({ id, ordinal: 1, readable: true, recommended, selected: true, width, height, sourceLabel: "Source", relativePath: `${id}.jpg`, failed: false, classification: "" });
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
}

class FakeCard {
  readonly preview = new FakeImage();
  readonly dataset: { reviewEngineCard: string };
  constructor(id: string) { this.dataset = { reviewEngineCard: id }; }
  querySelector(selector: string) {
    if (selector === "[data-review-engine-image]") return this.preview;
    return null;
  }
}

class FakeHost {
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly cards = new Map<string, FakeCard>();
  readonly grid = {
    style: { gridTemplateColumns: "" },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }),
  };
  constructor(ids: readonly string[]) { for (const id of ids) this.cards.set(id, new FakeCard(id)); }
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
  querySelectorAll(_selector: string) { return []; }
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
  });
  return { engine, host, frames, preloads, observers };
}

function frame(overrides: Partial<ReviewEngineFrame> = {}): ReviewEngineFrame {
  const images = Object.freeze([
    Object.freeze({ id: "image-1", url: "http://127.0.0.1:8787/api/v1/gallery/reviews/batch/images/image-1", width: 1200, height: 1800, readable: true, recommended: false }),
    Object.freeze({ id: "image-2", url: "http://localhost:8787/api/v1/gallery/reviews/batch/images/image-2", width: 800, height: 1200, readable: true, recommended: true }),
  ]);
  return Object.freeze({ key: "batch:group", images, preloadUrls: Object.freeze([images[1].url]), activeImageId: "image-1", ...overrides });
}

describe("review engine kernel", () => {
  it("normalizes dimensions and layout without mutating inputs", () => {
    expect(normalizeReviewImageDimensions({ metadata: { w: 1448, h: 2048 }, readable: true })).toMatchObject({ width: 1448, height: 2048 });
    expect(normalizeReviewImageDimensions({ metadata: { w: 0, h: 10 }, readable: true })).toBeNull();
    const pool = [image("one", 800, 1200), image("two", 800, 1200, true)];
    const before = [...pool];
    const layout = calculateReviewLayout(pool, 360, 240);
    expect(layout.readable).toBe(true);
    expect(layout.tileWidth).toBeGreaterThan(0);
    expect(pool).toEqual(before);
    expect(calculateReviewLayout([image("wide", 4000, 100)], 400, 200).ratio).toBe(2.6);
    expect(calculateReviewLayout([], 400, 200).readable).toBe(false);
  });

  it("zooms around the pointer and pans without touching scale", () => {
    const zoomed = updateReviewZoom({ scale: 1, offsetX: 0, offsetY: 0 }, { deltaY: -100, anchorX: 50, anchorY: 0 }, { width: 400, height: 300 });
    expect(zoomed.scale).toBeGreaterThan(1);
    // 锚点在指针处：内容点保持在指针下方，偏移向锚点对侧收缩。
    expect(zoomed.offsetX).toBeCloseTo(50 - 50 * zoomed.scale, 6);
    const anchorKept = updateReviewZoom(zoomed, { deltaY: -100, anchorX: 50, anchorY: 0 }, { width: 400, height: 300 });
    const contentU = (50 - zoomed.offsetX) / zoomed.scale;
    expect((50 - anchorKept.offsetX) / anchorKept.scale).toBeCloseTo(contentU, 6);
    let clamped = zoomed;
    for (let index = 0; index < 200; index += 1) clamped = updateReviewZoom(clamped, { deltaY: -500, anchorX: 0, anchorY: 0 }, { width: 400, height: 300 });
    expect(clamped.scale).toBeLessThanOrEqual(8);
    for (let index = 0; index < 200; index += 1) clamped = updateReviewZoom(clamped, { deltaY: 500, anchorX: 0, anchorY: 0 }, { width: 400, height: 300 });
    expect(clamped.scale).toBe(1);
    const panned = panReviewZoom(clamped, { x: 12, y: -8 });
    expect(panned).toEqual({ scale: clamped.scale, offsetX: clamped.offsetX + 12, offsetY: clamped.offsetY - 8 });
    expect(() => updateReviewZoom({ scale: 0.5, offsetX: 0, offsetY: 0 }, { deltaY: 0, anchorX: 0, anchorY: 0 }, { width: 400, height: 300 })).toThrow(RangeError);
    expect(() => updateReviewZoom(clamped, { deltaY: 0, anchorX: 0, anchorY: 0 }, { width: 0, height: 300 })).toThrow(TypeError);
  });

  it("clamps panning to the image edges like the Windows viewer", () => {
    // 400×300 视口内的 800×600 图：fit 后 400×300，恰好适配，任何偏移都回到 0。
    const fitted = clampReviewPan({ scale: 1, offsetX: 120, offsetY: -80 }, 800, 600, { width: 400, height: 300 });
    expect(fitted.offsetX).toBe(0);
    expect(fitted.offsetY).toBe(0);
    // 放大 2 倍：内容 800×600，水平/垂直各余量 200/150，越界偏移被夹回边缘。
    const zoomed = clampReviewPan({ scale: 2, offsetX: 400, offsetY: -300 }, 800, 600, { width: 400, height: 300 });
    expect(zoomed).toEqual({ scale: 2, offsetX: 200, offsetY: -150 });
    const inside = clampReviewZoomInside();
    function clampReviewZoomInside() { return clampReviewPan({ scale: 2, offsetX: 50, offsetY: 25 }, 800, 600, { width: 400, height: 300 }); }
    expect(inside).toEqual({ scale: 2, offsetX: 50, offsetY: 25 });
    // 竖图 600×1200：fit 后 150×300，放大 2 倍后水平仍适配（余量 0），垂直余量 150。
    const portrait = clampReviewPan({ scale: 2, offsetX: 90, offsetY: -200 }, 600, 1200, { width: 400, height: 300 });
    expect(portrait).toEqual({ scale: 2, offsetX: 0, offsetY: -150 });
    expect(() => clampReviewPan({ scale: 0.5, offsetX: 0, offsetY: 0 }, 800, 600, { width: 400, height: 300 })).toThrow(RangeError);
    expect(() => clampReviewPan({ scale: 2, offsetX: 0, offsetY: 0 }, 0, 600, { width: 400, height: 300 })).toThrow(TypeError);
  });
});

describe("review imperative engine lifecycle", () => {
  it("requests loopback media with anonymous CORS and releases every resource", async () => {
    const { engine, host, frames, preloads, observers } = engineHarness();
    engine.update(frame());
    await Promise.resolve();
    expect([...host.cards.values()].every(({ preview }) => preview.crossOrigin === "anonymous" && preview.decoding === "async" && preview.loading === "eager")).toBe(true);
    expect(preloads.every((entry) => entry.crossOrigin === "anonymous" && entry.decoding === "async")).toBe(true);
    expect(engine.getResourceCounts()).toMatchObject({ observer: 1, images: 2, preloads: 1 });
    expect(frames.size).toBe(1);
    const [[id, callback]] = frames;
    frames.delete(id);
    callback(0);
    expect(host.grid.style.gridTemplateColumns).not.toBe("");
    engine.release();
    expect(engine.getResourceCounts()).toEqual({ listeners: 0, observer: 0, frame: 0, images: 0, preloads: 0 });
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
