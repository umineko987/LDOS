import { describe, expect, it } from "vitest";

import {
  clampPan,
  containedRect,
  dragPan,
  flightTransform,
  MAX_SCALE,
  RESET,
  stepIndex,
  stripWindow,
  wheelZoom,
} from "./viewer-model.ts";

const VIEWPORT = { width: 1000, height: 800 };
// 2000×1000 的横图：适配后 1000×500，竖直方向有空白。
const WIDE = { width: 2000, height: 1000 };

describe("clampPan", () => {
  it("适配时不能平移，放大后只在超出视口的方向平移", () => {
    expect(clampPan({ scale: 1, x: 50, y: -50 }, WIDE, VIEWPORT)).toEqual(RESET);
    // 2 倍：2000×1000，横向可移 ±500，纵向 (1000 − 800) / 2 = ±100。
    expect(clampPan({ scale: 2, x: 900, y: -300 }, WIDE, VIEWPORT)).toEqual({ scale: 2, x: 500, y: -100 });
    expect(clampPan({ scale: 2, x: 120, y: 40 }, WIDE, VIEWPORT)).toEqual({ scale: 2, x: 120, y: 40 });
  });

  it("缩放夹在 [1, 8]，尺寸未知时回到中心", () => {
    expect(clampPan({ scale: 20, x: 0, y: 0 }, WIDE, VIEWPORT).scale).toBe(MAX_SCALE);
    expect(clampPan({ scale: 0.2, x: 0, y: 0 }, WIDE, VIEWPORT).scale).toBe(1);
    expect(clampPan({ scale: Number.NaN, x: 3, y: 3 }, WIDE, VIEWPORT)).toEqual(RESET);
    expect(clampPan({ scale: 3, x: 30, y: 30 }, null, VIEWPORT)).toEqual({ scale: 3, x: 0, y: 0 });
    expect(clampPan({ scale: 3, x: 30, y: 30 }, WIDE, { width: 0, height: 800 })).toEqual({ scale: 3, x: 0, y: 0 });
    expect(Object.is(clampPan({ scale: 1, x: -0, y: -0 }, WIDE, VIEWPORT).x, 0)).toBe(true);
  });
});

describe("wheelZoom / dragPan", () => {
  it("向上滚放大，指针下的点不动", () => {
    const zoomed = wheelZoom(RESET, -100, { x: 200, y: 0 }, WIDE, VIEWPORT);
    expect(zoomed.scale).toBeCloseTo(1.12);
    // 指针处 x=200：新偏移 200 − 200 × 1.12 = −24。
    expect(zoomed.x).toBeCloseTo(-24);
    expect(zoomed.y).toBe(0);
    expect(wheelZoom(zoomed, 100, { x: 200, y: 0 }, WIDE, VIEWPORT).scale).toBeCloseTo(1);
    expect(wheelZoom(RESET, 100, { x: 0, y: 0 }, WIDE, VIEWPORT)).toEqual(RESET);
    expect(wheelZoom(zoomed, 0, { x: 0, y: 0 }, WIDE, VIEWPORT)).toBe(zoomed);
  });

  it("拖动从按下时的位置累加并受边缘约束", () => {
    const start = { scale: 2, x: 0, y: 0 };
    expect(dragPan(start, 120, -30, WIDE, VIEWPORT)).toEqual({ scale: 2, x: 120, y: -30 });
    expect(dragPan(start, 2000, 2000, WIDE, VIEWPORT)).toEqual({ scale: 2, x: 500, y: 100 });
  });
});

describe("stepIndex / stripWindow", () => {
  it("翻页在两端停住", () => {
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(2, 1, 5)).toBe(3);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(3, 0, 0)).toBe(-1);
  });

  it("缩略条窗口以当前项为中心，靠边时贴边", () => {
    expect(stripWindow(50, 100, 2)).toEqual([48, 53]);
    expect(stripWindow(0, 100, 2)).toEqual([0, 5]);
    expect(stripWindow(99, 100, 2)).toEqual([95, 100]);
    expect(stripWindow(1, 3, 2)).toEqual([0, 3]);
    expect(stripWindow(0, 0)).toEqual([0, 0]);
  });
});

describe("containedRect / flightTransform", () => {
  it("contain 后的图片矩形", () => {
    expect(containedRect({ x: 0, y: 0, width: 1000, height: 800 }, WIDE)).toEqual({ x: 0, y: 150, width: 1000, height: 500 });
    expect(containedRect({ x: 10, y: 0, width: 100, height: 100 }, { width: 1, height: 2 })).toEqual({
      x: 35,
      y: 0,
      width: 50,
      height: 100,
    });
    expect(containedRect({ x: 0, y: 0, width: 0, height: 10 }, WIDE)).toBeNull();
    expect(containedRect({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 1 })).toBeNull();
  });

  it("起始帧把大图缩到缩略图的位置", () => {
    expect(flightTransform({ x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 150, width: 1000, height: 500 })).toBe(
      "translate(-450px, -375px) scale(0.1, 0.1)",
    );
    expect(flightTransform({ x: 0, y: 0, width: 0, height: 50 }, { x: 0, y: 0, width: 10, height: 10 })).toBeNull();
    expect(flightTransform({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 0 })).toBeNull();
  });
});
