import { describe, expect, it } from "vitest";

import { clampZoom, deckLayout, isZoomed, panBy, ZOOM_MAX, ZOOM_RESET, zoomAt, zoomTransform } from "./compare-deck.ts";

const image = (width: number, height: number, readable = true) => ({ width, height, readable });

describe("deckLayout", () => {
  it("两张竖图在宽屏上并排", () => {
    const layout = deckLayout([image(800, 1200), image(800, 1200)], 1200, 700);
    expect(layout.columns).toBe(2);
    expect(layout.rows).toBe(1);
    expect(layout.ratio).toBeCloseTo(800 / 1200);
    expect(layout.tileHeight).toBeCloseTo(700);
    expect(layout.readable).toBe(true);
  });

  it("四张横图在方形区域里排成 2×2", () => {
    const layout = deckLayout(Array(4).fill(image(1600, 900)), 900, 900);
    expect([layout.columns, layout.rows]).toEqual([2, 2]);
    expect(layout.tileWidth).toBeCloseTo((900 - 12) / 2);
  });

  it("没有可读图片时宽高比按 1，readable 为 false", () => {
    const layout = deckLayout([image(0, 0, false), image(10, 10, false)], 600, 400);
    expect(layout.ratio).toBe(1);
    expect(layout.readable).toBe(false);
    expect(layout.columns).toBeGreaterThan(0);
  });

  it("极端宽高比被限制；空输入或无效区域给空布局", () => {
    expect(deckLayout([image(10_000, 10)], 800, 600).ratio).toBe(2.6);
    expect(deckLayout([image(10, 10_000)], 800, 600).ratio).toBe(0.38);
    expect(deckLayout([], 800, 600).columns).toBe(0);
    expect(deckLayout([image(1, 1)], 0, 600)).toEqual({ columns: 0, rows: 0, tileWidth: 0, tileHeight: 0, ratio: 1, readable: false });
    expect(deckLayout([image(1, 1)], 800, Number.NaN).columns).toBe(0);
  });

  it("看不清时退而求其次选面积最大的；gap 无效时用默认值", () => {
    const tiny = deckLayout(Array(9).fill(image(100, 100)), 300, 300, Number.NaN);
    expect(tiny.readable).toBe(false);
    expect(tiny.columns).toBe(3);
    const narrow = deckLayout(Array(3).fill(image(100, 100)), 650, 200, -5);
    expect(narrow.columns).toBe(3);
  });
});

describe("同步缩放", () => {
  it("以指针为锚点缩放：锚点下的那一点不动", () => {
    const anchor = { x: 40, y: -20 };
    const zoomed = zoomAt(ZOOM_RESET, -200, anchor);
    expect(zoomed.scale).toBeCloseTo(Math.pow(1.0015, 200));
    // 屏幕点 p 对应图上的 (p - offset) / scale；缩放前后锚点对应同一个图上的点。
    expect((anchor.x - zoomed.x) / zoomed.scale).toBeCloseTo(anchor.x);
    expect((anchor.y - zoomed.y) / zoomed.scale).toBeCloseTo(anchor.y);
  });

  it("缩放被限制在 1–8 倍；deltaY 为 0 或无效时不变", () => {
    expect(zoomAt(ZOOM_RESET, 500, { x: 0, y: 0 }).scale).toBe(1);
    expect(zoomAt(ZOOM_RESET, -100_000, { x: 0, y: 0 }).scale).toBe(ZOOM_MAX);
    expect(zoomAt(ZOOM_RESET, 0, { x: 0, y: 0 })).toBe(ZOOM_RESET);
    expect(zoomAt(ZOOM_RESET, Number.NaN, { x: 0, y: 0 })).toBe(ZOOM_RESET);
  });

  it("平移累加位移；无效位移不变", () => {
    expect(panBy({ scale: 2, x: 1, y: 2 }, { x: 3, y: -4 })).toEqual({ scale: 2, x: 4, y: -2 });
    const state = { scale: 2, x: 1, y: 2 };
    expect(panBy(state, { x: Number.POSITIVE_INFINITY, y: 0 })).toBe(state);
  });

  it("以焦点图约束平移：放大后不越过图片边缘，适配时回到居中", () => {
    const tile = { width: 400, height: 400 };
    const square = { width: 1000, height: 1000 };
    expect(clampZoom({ scale: 2, x: 500, y: -500 }, square, tile)).toEqual({ scale: 2, x: 200, y: -200 });
    expect(clampZoom({ scale: 1, x: 30, y: -30 }, square, tile)).toEqual({ scale: 1, x: 0, y: 0 });
    // 竖图在方卡里：水平方向放大到 2 倍仍不超出卡片宽，不能横向平移。
    expect(clampZoom({ scale: 2, x: 80, y: 0 }, { width: 500, height: 1000 }, tile)).toEqual({ scale: 2, x: 0, y: 0 });
  });

  it("尺寸未知时只约束缩放；无效数值回到默认", () => {
    expect(clampZoom({ scale: 20, x: 5, y: 5 }, null, { width: 10, height: 10 })).toEqual({ scale: ZOOM_MAX, x: 0, y: 0 });
    expect(clampZoom({ scale: Number.NaN, x: 5, y: 5 }, { width: 0, height: 1 }, { width: 10, height: 10 })).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampZoom({ scale: 3, x: Number.NaN, y: Number.NaN }, { width: 10, height: 10 }, { width: 10, height: 10 })).toEqual({ scale: 3, x: 0, y: 0 });
  });

  it("isZoomed / zoomTransform", () => {
    expect(isZoomed(ZOOM_RESET)).toBe(false);
    expect(isZoomed({ scale: 1, x: 0, y: 3 })).toBe(true);
    expect(isZoomed({ scale: 2, x: 0, y: 0 })).toBe(true);
    expect(isZoomed({ scale: 1, x: 2, y: 0 })).toBe(true);
    expect(zoomTransform({ scale: 2, x: 3, y: -4 })).toBe("translate(3px, -4px) scale(2)");
  });
});
