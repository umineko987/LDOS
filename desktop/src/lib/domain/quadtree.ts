// 静态四叉树：一次建好，只读查询。地图上的命中测试、套索和视野裁剪都用它。
//
// 点存成紧凑的 (x0, y0, x1, y1, …)，树里只记下标。叶子超过 BUCKET 个点就四分，
// 深度到 MAX_DEPTH 为止（大量重合点留在同一个叶子里）。

export interface Quadtree {
  readonly size: number;
  /** 落在闭区间矩形里的点，按下标升序。 */
  queryRect(minX: number, minY: number, maxX: number, maxY: number): number[];
  /** 距离 ≤ radius 的点里最近的一个；`accept` 返回 false 的点跳过。没有时返回 -1。距离相同取下标小的。 */
  nearest(x: number, y: number, radius: number, accept?: (index: number) => boolean): number;
}

const BUCKET = 16;
const MAX_DEPTH = 12;

interface Node {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly items: number[] | null;
  readonly children: Node[] | null;
}

type Positions = ArrayLike<number>;

function build(
  positions: Positions,
  indices: number[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  depth: number,
): Node {
  if (indices.length <= BUCKET || depth >= MAX_DEPTH) return { minX, minY, maxX, maxY, items: indices, children: null };
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const quadrants: number[][] = [[], [], [], []];
  for (const index of indices) {
    const east = positions[index * 2]! > midX ? 1 : 0;
    const south = positions[index * 2 + 1]! > midY ? 2 : 0;
    quadrants[east + south]!.push(index);
  }
  const bounds: readonly [number, number, number, number][] = [
    [minX, minY, midX, midY],
    [midX, minY, maxX, midY],
    [minX, midY, midX, maxY],
    [midX, midY, maxX, maxY],
  ];
  const children = quadrants.map((items, quadrant) => build(positions, items, ...bounds[quadrant]!, depth + 1));
  return { minX, minY, maxX, maxY, items: null, children };
}

function overlaps(node: Node, minX: number, minY: number, maxX: number, maxY: number): boolean {
  return node.minX <= maxX && node.maxX >= minX && node.minY <= maxY && node.maxY >= minY;
}

export function buildQuadtree(positions: Positions): Quadtree {
  const count = Math.floor(positions.length / 2);
  const indices: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const x = positions[index * 2]!;
    const y = positions[index * 2 + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    indices.push(index);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const root = indices.length
    ? build(positions, indices, minX, minY, maxX, maxY, 0)
    : { minX: 0, minY: 0, maxX: 0, maxY: 0, items: [], children: null };

  return {
    size: indices.length,
    queryRect(qMinX, qMinY, qMaxX, qMaxY) {
      const out: number[] = [];
      if (!indices.length) return out;
      const stack: Node[] = [root];
      while (stack.length) {
        const node = stack.pop()!;
        if (!overlaps(node, qMinX, qMinY, qMaxX, qMaxY)) continue;
        if (node.children) {
          stack.push(...node.children);
          continue;
        }
        for (const index of node.items!) {
          const x = positions[index * 2]!;
          const y = positions[index * 2 + 1]!;
          if (x >= qMinX && x <= qMaxX && y >= qMinY && y <= qMaxY) out.push(index);
        }
      }
      return out.sort((a, b) => a - b);
    },
    nearest(x, y, radius, accept) {
      let best = -1;
      let bestDistance = radius * radius;
      for (const index of this.queryRect(x - radius, y - radius, x + radius, y + radius)) {
        if (accept && !accept(index)) continue;
        const dx = positions[index * 2]! - x;
        const dy = positions[index * 2 + 1]! - y;
        const distance = dx * dx + dy * dy;
        // 升序遍历，严格小于时才替换：距离相同保留下标小的。
        if (distance < bestDistance || (distance === bestDistance && best === -1)) {
          best = index;
          bestDistance = distance;
        }
      }
      return best;
    },
  };
}
