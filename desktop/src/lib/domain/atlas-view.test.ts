import { describe, expect, it } from "vitest";

import {
  baseScale,
  clampZoom,
  focusOn,
  HOME_CAMERA,
  keyPan,
  lodMode,
  MAX_SPRITES,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  pixelsPerUnit,
  screenToWorld,
  spriteSize,
  SPRITE_MAX_PX,
  SPRITE_MIN_PX,
  visibleWorldRect,
  wheelFactor,
  worldToScreen,
  zoomAt,
} from "./atlas-view.ts";

const viewport = { width: 1000, height: 500 };

describe("atlas camera", () => {
  it("k = 1 时短边放下 [-1.25, 1.25]，原点在视口中心", () => {
    expect(baseScale(viewport)).toBe(200);
    expect(baseScale({ width: 0, height: 0 })).toBe(0.4);
    expect(worldToScreen(HOME_CAMERA, viewport, 0, 0)).toEqual([500, 250]);
    expect(worldToScreen(HOME_CAMERA, viewport, 1.25, -1.25)).toEqual([750, 0]);
    expect(pixelsPerUnit({ x: 0, y: 0, k: 2 }, viewport)).toBe(400);
  });

  it("屏幕和世界坐标互为逆变换", () => {
    const camera = { x: 0.3, y: -0.2, k: 3.5 };
    const [sx, sy] = worldToScreen(camera, viewport, -0.4, 0.7);
    const [wx, wy] = screenToWorld(camera, viewport, sx, sy);
    expect(wx).toBeCloseTo(-0.4, 10);
    expect(wy).toBeCloseTo(0.7, 10);
  });

  it("以指针为中心缩放，指针下的世界坐标不动；到达上下限后不再变化", () => {
    const camera = { x: 0.1, y: 0.2, k: 1 };
    const before = screenToWorld(camera, viewport, 800, 100);
    const zoomed = zoomAt(camera, viewport, 800, 100, 2);
    expect(zoomed.k).toBe(2);
    const after = screenToWorld(zoomed, viewport, 800, 100);
    expect(after[0]).toBeCloseTo(before[0], 10);
    expect(after[1]).toBeCloseTo(before[1], 10);

    const top = { x: 0, y: 0, k: MAX_ZOOM };
    expect(zoomAt(top, viewport, 10, 10, 2)).toBe(top);
    expect(zoomAt({ x: 0, y: 0, k: 1 }, viewport, 500, 250, 0.01).k).toBe(MIN_ZOOM);
  });

  it("缩放倍数被夹在范围内，非数值回到 1", () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(3)).toBe(3);
  });

  it("拖动时内容跟着指针走；方向键按视口短边的比例平移", () => {
    const moved = panBy(HOME_CAMERA, viewport, 200, -100);
    expect(moved).toEqual({ x: -1, y: 0.5, k: 1 });
    const right = keyPan(HOME_CAMERA, viewport, 1, 0);
    // 视野往右走：相机 x 增大，内容往左移。
    expect(right.x).toBeCloseTo(0.3, 10);
    expect(right.y).toBe(0);
    expect(keyPan(HOME_CAMERA, viewport, 0, -1).y).toBeCloseTo(-0.3, 10);
  });

  it("滚轮向下缩小、向上放大；按行和按页滚动折算成像素并截断", () => {
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(3, 1)).toBeCloseTo(wheelFactor(48), 10);
    expect(wheelFactor(1, 2)).toBeCloseTo(wheelFactor(320), 10);
    expect(wheelFactor(2, 2)).toBe(wheelFactor(400));
    expect(wheelFactor(10_000)).toBe(wheelFactor(400));
  });

  it("视野矩形含外扩的边距", () => {
    expect(visibleWorldRect(HOME_CAMERA, viewport)).toEqual({ minX: -2.5, minY: -1.25, maxX: 2.5, maxY: 1.25 });
    const rect = visibleWorldRect(HOME_CAMERA, viewport, 100);
    expect(rect.minX).toBeCloseTo(-3, 10);
    expect(rect.maxY).toBeCloseTo(1.75, 10);
  });

  it("细节层级有回差；没有雪碧图或同屏太多时只画点", () => {
    expect(lodMode(2.3, "points", 10, true)).toBe("points");
    expect(lodMode(2.4, "points", 10, true)).toBe("sprites");
    expect(lodMode(2.3, "sprites", 10, true)).toBe("sprites");
    expect(lodMode(2.1, "sprites", 10, true)).toBe("points");
    expect(lodMode(10, "sprites", 10, false)).toBe("points");
    expect(lodMode(10, "sprites", MAX_SPRITES + 1, true)).toBe("points");
  });

  it("缩略图边长随缩放变化并有上下限；聚焦把相机移到点上", () => {
    expect(spriteSize(0.5)).toBe(SPRITE_MIN_PX);
    expect(spriteSize(4)).toBe(52);
    expect(spriteSize(30)).toBe(SPRITE_MAX_PX);
    expect(focusOn(0.2, -0.3)).toEqual({ x: 0.2, y: -0.3, k: 4 });
    expect(focusOn(0, 0, 1000).k).toBe(MAX_ZOOM);
  });
});
