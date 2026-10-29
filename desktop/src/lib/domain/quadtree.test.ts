import { describe, expect, it } from "vitest";

import { buildQuadtree } from "./quadtree.ts";

/** 确定性的伪随机点。 */
function scatter(count: number, seed = 7): Float32Array {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const positions = new Float32Array(count * 2);
  for (let index = 0; index < positions.length; index += 1) positions[index] = next() * 2 - 1;
  return positions;
}

function bruteRect(positions: Float32Array, minX: number, minY: number, maxX: number, maxY: number) {
  const out: number[] = [];
  for (let index = 0; index < positions.length / 2; index += 1) {
    const x = positions[index * 2]!;
    const y = positions[index * 2 + 1]!;
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(index);
  }
  return out;
}

describe("quadtree", () => {
  it("矩形查询和逐个比较的结果一致", () => {
    const positions = scatter(3000);
    const tree = buildQuadtree(positions);
    expect(tree.size).toBe(3000);
    for (const rect of [
      [-1, -1, 1, 1],
      [-0.2, -0.3, 0.1, 0.4],
      [0.5, 0.5, 0.6, 0.55],
      [2, 2, 3, 3],
    ] as [number, number, number, number][]) {
      expect(tree.queryRect(...rect)).toEqual(bruteRect(positions, ...rect));
    }
  });

  it("最近点在半径内取最近，可以跳过不接受的点", () => {
    const positions = Float32Array.from([0, 0, 0.1, 0, 0.5, 0.5, 0.11, 0]);
    const tree = buildQuadtree(positions);
    expect(tree.nearest(0.09, 0, 0.05)).toBe(1);
    expect(tree.nearest(0.09, 0, 0.05, (index) => index !== 1)).toBe(3);
    expect(tree.nearest(0.3, 0.3, 0.05)).toBe(-1);
    // 正好在半径上也算命中。
    expect(tree.nearest(0.5, 0.25, 0.25)).toBe(2);
  });

  it("距离相同时取下标小的", () => {
    const tree = buildQuadtree(Float32Array.from([1, 0, -1, 0]));
    expect(tree.nearest(0, 0, 2)).toBe(0);
  });

  it("大量重合点停在最大深度；坐标无效的点不进树；空树查询为空", () => {
    const same = new Float32Array(200 * 2).fill(0.25);
    const tree = buildQuadtree(same);
    expect(tree.queryRect(0.2, 0.2, 0.3, 0.3)).toHaveLength(200);
    expect(tree.nearest(0.25, 0.25, 0.01)).toBe(0);

    const invalid = buildQuadtree(Float32Array.from([Number.NaN, 0, 0.5, Infinity, 0.2, 0.2]));
    expect(invalid.size).toBe(1);
    expect(invalid.queryRect(-1, -1, 1, 1)).toEqual([2]);

    const empty = buildQuadtree(new Float32Array(0));
    expect(empty.size).toBe(0);
    expect(empty.queryRect(-1, -1, 1, 1)).toEqual([]);
    expect(empty.nearest(0, 0, 1)).toBe(-1);
  });
});
