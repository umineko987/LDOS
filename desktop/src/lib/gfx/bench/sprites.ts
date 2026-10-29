// 渲染基准的场景：N 个方块在画布里匀速运动、碰边反弹。坐标是 CSS 像素，指方块左上角。
//
// positions 紧凑排列（x0, y0, x1, y1, …），WebGL2 后端整块上传；
// colors 按块分配（前 1/k 是 0，依此类推），Canvas2D 后端每帧只换 k 次 fillStyle。

export type Rgb = readonly [number, number, number];

/** WebGL2 后端的调色板 uniform 长度。 */
export const MAX_PALETTE = 8;

export interface SpriteField {
  readonly count: number;
  readonly size: number;
  width: number;
  height: number;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly colors: Uint8Array;
  readonly palette: readonly Rgb[];
}

export interface SpriteFieldOptions {
  readonly count: number;
  readonly width: number;
  readonly height: number;
  readonly palette: readonly Rgb[];
  readonly size?: number;
  readonly seed?: number;
  /** 速度范围（CSS 像素/秒）。 */
  readonly speed?: readonly [number, number];
}

/** 一帧最多推进 0.1 秒：切回标签页后不会一下跳很远。 */
const MAX_STEP_SECONDS = 0.1;

/** 小而确定的伪随机数（mulberry32），同一个种子得到同一个场景。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSpriteField(options: SpriteFieldOptions): SpriteField {
  const { count, width, height, palette, size = 3, seed = 1, speed = [20, 120] } = options;
  if (palette.length === 0 || palette.length > MAX_PALETTE) {
    throw new RangeError(`palette needs 1..${MAX_PALETTE} colours, got ${palette.length}`);
  }
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 2);
  const velocities = new Float32Array(count * 2);
  const colors = new Uint8Array(count);
  const maxX = Math.max(0, width - size);
  const maxY = Math.max(0, height - size);
  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI * 2;
    const magnitude = speed[0] + random() * (speed[1] - speed[0]);
    positions[i * 2] = random() * maxX;
    positions[i * 2 + 1] = random() * maxY;
    velocities[i * 2] = Math.cos(angle) * magnitude;
    velocities[i * 2 + 1] = Math.sin(angle) * magnitude;
    colors[i] = Math.floor((i * palette.length) / count);
  }
  return { count, size, width, height, positions, velocities, colors, palette };
}

/** 一维的运动和反弹，返回新的位置；速度写回 velocities。 */
function advance(positions: Float32Array, velocities: Float32Array, index: number, dt: number, max: number) {
  let position = positions[index]! + velocities[index]! * dt;
  if (position < 0) {
    position = -position;
    velocities[index] = Math.abs(velocities[index]!);
  } else if (position > max) {
    position = 2 * max - position;
    velocities[index] = -Math.abs(velocities[index]!);
  }
  positions[index] = Math.min(Math.max(position, 0), max);
}

export function stepSpriteField(field: SpriteField, seconds: number): void {
  const dt = Math.min(Math.max(seconds, 0), MAX_STEP_SECONDS);
  if (dt === 0) return;
  const maxX = Math.max(0, field.width - field.size);
  const maxY = Math.max(0, field.height - field.size);
  for (let i = 0; i < field.count; i += 1) {
    advance(field.positions, field.velocities, i * 2, dt, maxX);
    advance(field.positions, field.velocities, i * 2 + 1, dt, maxY);
  }
}

/** 画布尺寸变了：更新边界，把跑到外面的方块收回来。 */
export function resizeSpriteField(field: SpriteField, width: number, height: number): void {
  field.width = width;
  field.height = height;
  const maxX = Math.max(0, width - field.size);
  const maxY = Math.max(0, height - field.size);
  for (let i = 0; i < field.count; i += 1) {
    field.positions[i * 2] = Math.min(field.positions[i * 2]!, maxX);
    field.positions[i * 2 + 1] = Math.min(field.positions[i * 2 + 1]!, maxY);
  }
}

/** 解析 `#rgb` / `#rrggbb`（CSS 变量里取到的值可能带空格）。 */
export function parseHexColor(value: string): Rgb | null {
  const hex = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  if (short) return [parseInt(short[1]!.repeat(2), 16), parseInt(short[2]!.repeat(2), 16), parseInt(short[3]!.repeat(2), 16)];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (long) return [parseInt(long[1]!, 16), parseInt(long[2]!, 16), parseInt(long[3]!, 16)];
  return null;
}
