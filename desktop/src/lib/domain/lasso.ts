// 套索：拖动时收集指针轨迹，松开后闭合成多边形，选出落在里面的点。
//
// 轨迹点按最小间距采样，松开时再用 Ramer–Douglas–Peucker 简化，多边形顶点数有上限，
// 判断点在不在里面的开销也就有上限。

import type { Quadtree } from "./quadtree.ts";

export type Point = readonly [number, number];

/** 偶奇规则；边上的点归属不保证，套索场景里无所谓。 */
export function pointInPolygon(x: number, y: number, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 和上一个点相距不小于 `minDistance` 时才追加；返回是否追加了。 */
export function appendLassoPoint(points: Point[], point: Point, minDistance = 3): boolean {
  const last = points.at(-1);
  if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < minDistance) return false;
  points.push(point);
  return true;
}

function segmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

/** Ramer–Douglas–Peucker：保留首尾，删掉离折线不超过 `tolerance` 的点。 */
export function simplifyPolyline(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const distance = segmentDistance(points[index]!, points[first]!, points[last]!);
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

export function polygonBounds(polygon: readonly Point[]) {
  if (!polygon.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** 多边形（世界坐标）里的点，按下标升序；先用包围盒在四叉树里粗筛。少于 3 个顶点时为空。 */
export function selectInPolygon(
  polygon: readonly Point[],
  tree: Quadtree,
  positions: ArrayLike<number>,
  accept?: (index: number) => boolean,
): number[] {
  const bounds = polygon.length >= 3 ? polygonBounds(polygon) : null;
  if (!bounds) return [];
  return tree
    .queryRect(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY)
    .filter(
      (index) =>
        (!accept || accept(index)) && pointInPolygon(positions[index * 2]!, positions[index * 2 + 1]!, polygon),
    );
}
