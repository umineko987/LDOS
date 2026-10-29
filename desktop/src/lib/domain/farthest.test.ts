import { describe, expect, it } from "vitest";

import { decodeBase64, decodeVectors, farthestPointSample, type PcaVectors } from "./farthest.ts";

function encode(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes.map((value) => value & 0xff)));
}

function vectors(rows: number[][], scales = rows[0]!.map(() => 1)): PcaVectors {
  const decoded = decodeVectors({ dims: scales.length, scales, data: encode(rows.flat()) }, rows.length);
  if (!decoded) throw new Error("fixture");
  return decoded;
}

describe("PCA vectors", () => {
  it("按 int8 解码 base64，带每维缩放", () => {
    expect([...decodeBase64(encode([0, 127, 128, 255]))]).toEqual([0, 127, 128, 255]);
    const decoded = vectors(
      [
        [1, -1],
        [-128, 127],
      ],
      [0.5, 2],
    );
    expect(decoded.count).toBe(2);
    expect(decoded.dims).toBe(2);
    expect([...decoded.data]).toEqual([1, -1, -128, 127]);
    expect([...decoded.scales]).toEqual([0.5, 2]);
  });

  it("维数、缩放系数或长度对不上时返回 null", () => {
    const data = encode([1, 2, 3, 4]);
    expect(decodeVectors(null, 2)).toBeNull();
    expect(decodeVectors(undefined, 2)).toBeNull();
    expect(decodeVectors({ dims: 0, scales: [], data }, 2)).toBeNull();
    expect(decodeVectors({ dims: 2.5, scales: [1, 1], data }, 2)).toBeNull();
    expect(decodeVectors({ dims: 2, scales: [1], data }, 2)).toBeNull();
    expect(decodeVectors({ dims: 2, scales: [1, Number.NaN], data }, 2)).toBeNull();
    expect(decodeVectors({ dims: 2, scales: [1, 1], data }, 3)).toBeNull();
    expect(decodeVectors({ dims: 2, scales: [1, 1], data: "@@not base64@@" }, 2)).toBeNull();
    expect(decodeVectors({ dims: 2, scales: [1, 1], data }, 2)).not.toBeNull();
  });
});

describe("farthestPointSample", () => {
  // 一个紧密的团（0–3）加三个远处的点（4、5、6）。
  const field = vectors([
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [100, 0],
    [0, 100],
    [-100, -100],
  ]);

  it("先取离均值最近的，再依次取离已选最远的", () => {
    const picked = farthestPointSample(field, [0, 1, 2, 3, 4, 5, 6], 4);
    expect(picked).toHaveLength(4);
    expect(new Set(picked.slice(1))).toEqual(new Set([4, 5, 6]));
    expect([0, 1, 2, 3]).toContain(picked[0]);
  });

  it("结果确定：同样输入同样输出", () => {
    const rows = [6, 5, 4, 3, 2, 1, 0];
    expect(farthestPointSample(field, rows, 3)).toEqual(farthestPointSample(field, rows, 3));
  });

  it("n 不小于候选数时原样返回；n ≤ 0 为空；越界和重复的行号被忽略", () => {
    expect(farthestPointSample(field, [3, 1, 1, 99, -1, 2.5], 10)).toEqual([3, 1]);
    expect(farthestPointSample(field, [0, 1], 0)).toEqual([]);
    expect(farthestPointSample(field, [0, 1], -3)).toEqual([]);
  });

  it("重复向量不会被选两次", () => {
    const same = vectors([
      [5, 5],
      [5, 5],
      [5, 5],
    ]);
    const picked = farthestPointSample(same, [0, 1, 2], 2);
    expect(new Set(picked).size).toBe(2);
  });
});
