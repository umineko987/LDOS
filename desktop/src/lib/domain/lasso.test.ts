import { describe, expect, it } from "vitest";

import { appendLassoPoint, pointInPolygon, polygonBounds, selectInPolygon, simplifyPolyline, type Point } from "./lasso.ts";
import { buildQuadtree } from "./quadtree.ts";

const square: Point[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

// 凹多边形（C 形）：缺口里的点不算在内。
const cShape: Point[] = [
  [0, 0],
  [10, 0],
  [10, 3],
  [3, 3],
  [3, 7],
  [10, 7],
  [10, 10],
  [0, 10],
];

describe("lasso", () => {
  it("偶奇规则判断点在多边形内，凹形的缺口在外面", () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(11, 5, square)).toBe(false);
    expect(pointInPolygon(1, 5, cShape)).toBe(true);
    expect(pointInPolygon(6, 5, cShape)).toBe(false);
    expect(pointInPolygon(6, 8, cShape)).toBe(true);
    expect(pointInPolygon(0, 0, [])).toBe(false);
  });

  it("轨迹点按最小间距追加", () => {
    const points: Point[] = [];
    expect(appendLassoPoint(points, [0, 0])).toBe(true);
    expect(appendLassoPoint(points, [1, 1])).toBe(false);
    expect(appendLassoPoint(points, [3, 0])).toBe(true);
    expect(appendLassoPoint(points, [3.5, 0], 0.5)).toBe(true);
    expect(points).toEqual([
      [0, 0],
      [3, 0],
      [3.5, 0],
    ]);
  });

  it("RDP 简化去掉共线点，保留拐角和首尾", () => {
    const line: Point[] = [
      [0, 0],
      [1, 0.01],
      [2, 0],
      [3, 0],
      [3, 1],
      [3, 2],
      [3, 2],
    ];
    expect(simplifyPolyline(line, 0.1)).toEqual([
      [0, 0],
      [3, 0],
      [3, 2],
    ]);
    // 容差为 0 时只删严格共线的点（含重复的终点）。
    expect(simplifyPolyline(line, 0)).toEqual([line[0], line[1], line[2], line[3], line[6]]);
    expect(simplifyPolyline([[1, 1]], 1)).toEqual([[1, 1]]);
  });

  it("包围盒；空多边形为 null", () => {
    expect(polygonBounds(cShape)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(polygonBounds([])).toBeNull();
  });

  it("在四叉树里选出多边形内且被接受的点", () => {
    const positions = Float32Array.from([1, 5, 6, 5, 6, 8, 20, 20, 2, 2]);
    const tree = buildQuadtree(positions);
    expect(selectInPolygon(cShape, tree, positions)).toEqual([0, 2, 4]);
    expect(selectInPolygon(cShape, tree, positions, (index) => index !== 2)).toEqual([0, 4]);
    expect(selectInPolygon(square.slice(0, 2), tree, positions)).toEqual([]);
  });
});
