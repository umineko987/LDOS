import { describe, expect, it } from "vitest";

import {
  createSpriteField,
  MAX_PALETTE,
  mulberry32,
  parseHexColor,
  resizeSpriteField,
  stepSpriteField,
  type Rgb,
} from "./sprites.ts";

const PALETTE: Rgb[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];

describe("mulberry32", () => {
  it("同一个种子得到同一串数，范围在 [0, 1)", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const values = Array.from({ length: 100 }, () => a());
    expect(values).toEqual(Array.from({ length: 100 }, () => b()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(mulberry32(8)()).not.toBe(values[0]);
  });
});

describe("createSpriteField", () => {
  it("在画布内生成方块，颜色按块分配", () => {
    const field = createSpriteField({ count: 9, width: 100, height: 50, palette: PALETTE, size: 4, speed: [10, 20] });
    expect(field.positions).toHaveLength(18);
    expect(Array.from(field.colors)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    for (let i = 0; i < field.count; i += 1) {
      expect(field.positions[i * 2]).toBeGreaterThanOrEqual(0);
      expect(field.positions[i * 2]).toBeLessThanOrEqual(96);
      expect(field.positions[i * 2 + 1]).toBeLessThanOrEqual(46);
      const speed = Math.hypot(field.velocities[i * 2]!, field.velocities[i * 2 + 1]!);
      expect(speed).toBeGreaterThanOrEqual(10 - 1e-4);
      expect(speed).toBeLessThanOrEqual(20 + 1e-4);
    }
    expect(createSpriteField({ count: 9, width: 100, height: 50, palette: PALETTE }).positions).toEqual(
      createSpriteField({ count: 9, width: 100, height: 50, palette: PALETTE }).positions,
    );
  });

  it("调色板长度要在 1..MAX_PALETTE 之间", () => {
    expect(() => createSpriteField({ count: 1, width: 1, height: 1, palette: [] })).toThrow(RangeError);
    const tooMany = Array.from({ length: MAX_PALETTE + 1 }, (): Rgb => [0, 0, 0]);
    expect(() => createSpriteField({ count: 1, width: 1, height: 1, palette: tooMany })).toThrow(RangeError);
  });
});

describe("stepSpriteField", () => {
  function single(x: number, y: number, vx: number, vy: number) {
    const field = createSpriteField({ count: 1, width: 100, height: 100, palette: PALETTE, size: 10 });
    field.positions.set([x, y]);
    field.velocities.set([vx, vy]);
    return field;
  }

  it("匀速运动", () => {
    const field = single(10, 20, 100, -50);
    stepSpriteField(field, 0.05);
    expect(Array.from(field.positions)).toEqual([15, 17.5]);
  });

  it("碰到边界反弹", () => {
    const field = single(88, 3, 100, -100);
    stepSpriteField(field, 0.05);
    // x 越过右边界 90 三个像素，折回 87；y 越过 0 两个像素，折回 2。
    expect(field.positions[0]).toBeCloseTo(87);
    expect(field.velocities[0]).toBe(-100);
    expect(field.positions[1]).toBeCloseTo(2);
    expect(field.velocities[1]).toBe(100);
  });

  it("一帧最多推进 0.1 秒，负的时间不动", () => {
    const field = single(0, 0, 100, 100);
    stepSpriteField(field, 5);
    expect(Array.from(field.positions)).toEqual([10, 10]);
    stepSpriteField(field, -1);
    expect(Array.from(field.positions)).toEqual([10, 10]);
  });

  it("画布比方块还小时贴在原点", () => {
    const field = single(0, 0, 100, 100);
    field.width = 4;
    field.height = 4;
    stepSpriteField(field, 0.1);
    expect(Array.from(field.positions)).toEqual([0, 0]);
  });
});

describe("resizeSpriteField", () => {
  it("缩小时把跑出边界的方块收回来", () => {
    const field = createSpriteField({ count: 2, width: 100, height: 100, palette: PALETTE, size: 10 });
    field.positions.set([80, 5, 20, 70]);
    resizeSpriteField(field, 50, 40);
    expect([field.width, field.height]).toEqual([50, 40]);
    expect(Array.from(field.positions)).toEqual([40, 5, 20, 30]);
  });
});

describe("parseHexColor", () => {
  it("解析 #rgb 和 #rrggbb", () => {
    expect(parseHexColor(" #B39BE0 ")).toEqual([179, 155, 224]);
    expect(parseHexColor("#fa0")).toEqual([255, 170, 0]);
    expect(parseHexColor("rgb(1 2 3)")).toBeNull();
    expect(parseHexColor("")).toBeNull();
  });
});
