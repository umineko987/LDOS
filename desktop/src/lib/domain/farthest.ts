// 最远点采样：在选中的图里挑出“最多样”的 N 张。
//
// 向量是后端给的 PCA-32 int8 量化（行主序，n × dims 字节的 base64），v[d] ≈ q[d] × scales[d]。
// 第一张取离均值最近的（最有代表性），之后每次取离已选集合最远的一张。
// 距离一样时取输入里靠前的，结果是确定的。

export interface PcaVectors {
  readonly count: number;
  readonly dims: number;
  readonly scales: Float32Array;
  readonly data: Int8Array;
}

export interface EncodedVectors {
  readonly dims: number;
  readonly scales: readonly number[];
  readonly data: string;
}

const MAX_DIMS = 256;

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 长度、维数或缩放系数对不上时返回 null（调用方把“保留最多样”禁用掉）。 */
export function decodeVectors(encoded: EncodedVectors | null | undefined, count: number): PcaVectors | null {
  if (!encoded || !Number.isInteger(encoded.dims) || encoded.dims < 1 || encoded.dims > MAX_DIMS) return null;
  if (!Array.isArray(encoded.scales) || encoded.scales.length !== encoded.dims) return null;
  if (!encoded.scales.every((scale) => Number.isFinite(scale))) return null;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(encoded.data);
  } catch {
    return null;
  }
  if (bytes.length !== count * encoded.dims) return null;
  return {
    count,
    dims: encoded.dims,
    scales: Float32Array.from(encoded.scales),
    data: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length),
  };
}

function dequantize(vectors: PcaVectors, rows: readonly number[]): Float32Array {
  const { dims, scales, data } = vectors;
  const out = new Float32Array(rows.length * dims);
  rows.forEach((row, position) => {
    for (let d = 0; d < dims; d += 1) out[position * dims + d] = data[row * dims + d]! * scales[d]!;
  });
  return out;
}

function squaredDistance(values: Float32Array, dims: number, a: number, b: Float32Array, bOffset: number): number {
  let sum = 0;
  for (let d = 0; d < dims; d += 1) {
    const delta = values[a * dims + d]! - b[bOffset + d]!;
    sum += delta * delta;
  }
  return sum;
}

/**
 * 从 `rows`（向量的行号）里挑 `n` 个，按挑选顺序返回行号。
 * n ≥ rows.length 时原样返回全部；n ≤ 0 时为空。越界和重复的行号会被忽略。
 */
export function farthestPointSample(vectors: PcaVectors, rows: readonly number[], n: number): number[] {
  const valid = [...new Set(rows)].filter((row) => Number.isInteger(row) && row >= 0 && row < vectors.count);
  const take = Math.floor(n);
  if (take <= 0) return [];
  if (take >= valid.length) return valid;
  const { dims } = vectors;
  const values = dequantize(vectors, valid);

  const mean = new Float32Array(dims);
  for (let position = 0; position < valid.length; position += 1) {
    for (let d = 0; d < dims; d += 1) mean[d]! += values[position * dims + d]! / valid.length;
  }
  let first = 0;
  let firstDistance = Infinity;
  for (let position = 0; position < valid.length; position += 1) {
    const distance = squaredDistance(values, dims, position, mean, 0);
    if (distance < firstDistance) {
      first = position;
      firstDistance = distance;
    }
  }

  // nearest[i]：到已选集合的最近距离；已选的记 -1，重复向量（距离 0）也不会被选两次。
  const chosen = [first];
  const nearest = new Float32Array(valid.length);
  for (let position = 0; position < valid.length; position += 1) {
    nearest[position] = squaredDistance(values, dims, position, values, first * dims);
  }
  nearest[first] = -1;
  while (chosen.length < take) {
    let next = 0;
    let nextDistance = -1;
    for (let position = 0; position < valid.length; position += 1) {
      if (nearest[position]! > nextDistance) {
        next = position;
        nextDistance = nearest[position]!;
      }
    }
    chosen.push(next);
    nearest[next] = -1;
    for (let position = 0; position < valid.length; position += 1) {
      if (nearest[position]! < 0) continue;
      const distance = squaredDistance(values, dims, position, values, next * dims);
      if (distance < nearest[position]!) nearest[position] = distance;
    }
  }
  return chosen.map((position) => valid[position]!);
}
