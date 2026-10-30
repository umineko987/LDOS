// 语义地图的前端模型：把 GET /datasets/{id}/atlas 的响应整理成渲染和命中测试用的紧凑数组。
//
// - 坐标无效的点直接丢掉；vectorRow 记下每个点对应 vectors 的哪一行（vectors 按响应里 items 的顺序）。
// - `delta.removed_asset_ids` 里的点是已经从打标输入里移除的（地图上移除、或之后被清洗/去重排除），
//   默认隐藏；打开“显示已移除”时画成空心圈，可以选中再恢复。
// - 雪碧图格子越界（sheet 超出 urls、cell 超出 per_sheet）时当作没有缩略图。
// - 文件名（已移除的点后端给 null）和簇的代表标签（最多 3 个）只做类型和长度检查。

import type { components } from "#lib/api/schema.d.ts";

import { decodeVectors, type PcaVectors } from "./farthest.ts";

export type AtlasResponse = components["schemas"]["AtlasResponse"];
export type AtlasStatus = AtlasResponse["status"];

export interface SpriteSheets {
  readonly urls: readonly string[];
  readonly sheetSize: number;
  readonly cellSize: number;
  readonly columns: number;
  readonly perSheet: number;
}

export interface AtlasClusterInfo {
  readonly id: number;
  readonly size: number;
  readonly liveSize: number;
  readonly liveShare: number;
  readonly medoid: number;
  readonly x: number;
  readonly y: number;
  readonly overRepresented: boolean;
  /** 簇里最多图片带着的标签（触发词除外），最多 3 个；没有 caption 时为空。 */
  readonly topTags: readonly string[];
}

export interface AtlasModel {
  readonly runId: string | null;
  readonly count: number;
  readonly ids: readonly string[];
  /** 每个点的文件名；已移除或后端没给时为 null。 */
  readonly names: readonly (string | null)[];
  readonly indexOf: ReadonlyMap<string, number>;
  /** (x0, y0, x1, y1, …)，世界坐标。 */
  readonly positions: Float32Array;
  readonly clusters: Uint16Array;
  readonly outlier: Float32Array;
  /** (sheet0, cell0, …)；没有缩略图时两项都是 -1。 */
  readonly sprites: Int32Array;
  readonly removed: Uint8Array;
  readonly removedCount: number;
  readonly vectorRow: Int32Array;
  readonly vectors: PcaVectors | null;
  readonly sheets: SpriteSheets | null;
  readonly clusterList: readonly AtlasClusterInfo[];
  /** 簇 id → 代表标签（只收有标签的簇）。 */
  readonly clusterTags: ReadonlyMap<number, readonly string[]>;
  /** 离群图的下标，离群分从高到低；不含已移除的。 */
  readonly outliers: readonly number[];
  readonly outlierThreshold: number;
  readonly shareThreshold: number;
}

/** 每个点的绘制状态位（渲染器读，Uint8Array）。 */
export const FLAG_SELECTED = 1;
export const FLAG_REMOVED = 2;
export const FLAG_DROP = 4;
export const FLAG_OUTLIER = 8;
export const FLAG_HIDDEN = 16;

const MAX_CLUSTER = 0xffff;
const MAX_TOP_TAGS = 3;

function nameOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function topTagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, MAX_TOP_TAGS);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function sanitizeSheets(sprites: AtlasResponse["sprites"]): SpriteSheets | null {
  if (!sprites || !Array.isArray(sprites.urls) || !sprites.urls.length) return null;
  const sheetSize = positiveInt(sprites.sheet_size);
  const cellSize = positiveInt(sprites.cell_size);
  const columns = positiveInt(sprites.columns);
  const perSheet = positiveInt(sprites.per_sheet);
  if (!sheetSize || !cellSize || !columns || !perSheet || columns * cellSize > sheetSize) return null;
  if (!sprites.urls.every((url) => typeof url === "string" && url.startsWith("/") && !url.startsWith("//"))) return null;
  return { urls: [...sprites.urls], sheetSize, cellSize, columns, perSheet };
}

function spriteCell(value: unknown, sheets: SpriteSheets | null): [number, number] {
  if (!sheets || !Array.isArray(value) || value.length !== 2) return [-1, -1];
  const [sheet, cell] = value as unknown[];
  if (!Number.isInteger(sheet) || !Number.isInteger(cell)) return [-1, -1];
  const s = sheet as number;
  const c = cell as number;
  if (s < 0 || s >= sheets.urls.length || c < 0 || c >= sheets.perSheet) return [-1, -1];
  // 格子必须完整落在雪碧图里。
  const rows = Math.floor(sheets.sheetSize / sheets.cellSize);
  if (Math.floor(c / sheets.columns) >= rows) return [-1, -1];
  return [s, c];
}

export function buildAtlasModel(response: AtlasResponse): AtlasModel {
  const items = Array.isArray(response.items) ? response.items : [];
  const sheets = sanitizeSheets(response.sprites);
  const removedIds = new Set(response.delta?.removed_asset_ids ?? []);

  const ids: string[] = [];
  const names: (string | null)[] = [];
  const indexOf = new Map<string, number>();
  const rows: number[] = [];
  items.forEach((item, row) => {
    if (typeof item.asset_id !== "string" || indexOf.has(item.asset_id)) return;
    if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) return;
    indexOf.set(item.asset_id, ids.length);
    ids.push(item.asset_id);
    names.push(nameOf(item.name));
    rows.push(row);
  });

  const count = ids.length;
  const positions = new Float32Array(count * 2);
  const clusters = new Uint16Array(count);
  const outlier = new Float32Array(count);
  const sprites = new Int32Array(count * 2);
  const removed = new Uint8Array(count);
  const vectorRow = Int32Array.from(rows);
  let removedCount = 0;
  rows.forEach((row, index) => {
    const item = items[row]!;
    positions[index * 2] = item.x;
    positions[index * 2 + 1] = item.y;
    clusters[index] = Number.isInteger(item.cluster) ? Math.min(MAX_CLUSTER, Math.max(0, item.cluster)) : 0;
    outlier[index] = Number.isFinite(item.outlier) ? Math.min(1, Math.max(0, item.outlier)) : 0;
    const [sheet, cell] = spriteCell(item.sprite, sheets);
    sprites[index * 2] = sheet;
    sprites[index * 2 + 1] = cell;
    if (removedIds.has(item.asset_id)) {
      removed[index] = 1;
      removedCount += 1;
    }
  });

  const hints = response.hints ?? null;
  const over = new Set((hints?.over_represented ?? []).map((entry) => entry.cluster));
  const clusterList: AtlasClusterInfo[] = (response.clusters ?? []).map((cluster) => ({
    id: cluster.id,
    size: cluster.size,
    liveSize: cluster.live_size,
    liveShare: cluster.live_share,
    medoid: indexOf.get(cluster.medoid_asset_id) ?? -1,
    x: cluster.x,
    y: cluster.y,
    overRepresented: over.has(cluster.id),
    topTags: topTagsOf(cluster.top_tags),
  }));
  const clusterTags = new Map(
    clusterList.filter((cluster) => cluster.topTags.length).map((cluster) => [cluster.id, cluster.topTags] as const),
  );

  const outliers = (hints?.outliers ?? [])
    .map((id) => indexOf.get(id))
    .filter((index): index is number => index !== undefined && !removed[index]);

  return {
    runId: response.run?.run_id ?? null,
    count,
    ids,
    names,
    indexOf,
    positions,
    clusters,
    outlier,
    sprites,
    removed,
    removedCount,
    vectorRow,
    vectors: decodeVectors(response.vectors, items.length),
    sheets,
    clusterList,
    clusterTags,
    outliers,
    outlierThreshold: hints?.outlier_threshold ?? 1,
    shareThreshold: hints?.share_threshold ?? 0.08,
  };
}

export interface FlagState {
  readonly selected: ReadonlySet<number>;
  readonly drop: ReadonlySet<number>;
  /** 已发出移除请求、响应还没刷新进来的点（乐观隐藏）。 */
  readonly pendingRemoved: ReadonlySet<number>;
  /** 已发出恢复请求的点。 */
  readonly pendingRestored: ReadonlySet<number>;
  readonly showRemoved: boolean;
}

export function isRemoved(model: AtlasModel, state: Pick<FlagState, "pendingRemoved" | "pendingRestored">, index: number) {
  if (state.pendingRestored.has(index)) return false;
  return model.removed[index] === 1 || state.pendingRemoved.has(index);
}

export function buildFlags(model: AtlasModel, state: FlagState): Uint8Array {
  const flags = new Uint8Array(model.count);
  for (let index = 0; index < model.count; index += 1) {
    let flag = 0;
    if (isRemoved(model, state, index)) {
      flag |= FLAG_REMOVED;
      if (!state.showRemoved) flag |= FLAG_HIDDEN;
    } else if (model.outlier[index]! >= model.outlierThreshold) {
      flag |= FLAG_OUTLIER;
    }
    if (!(flag & FLAG_HIDDEN)) {
      if (state.selected.has(index)) flag |= FLAG_SELECTED;
      if (state.drop.has(index)) flag |= FLAG_DROP;
    }
    flags[index] = flag;
  }
  return flags;
}

/** 地图上还在打标输入里的点数。 */
export function liveCount(model: AtlasModel, state: Pick<FlagState, "pendingRemoved" | "pendingRestored">): number {
  let live = 0;
  for (let index = 0; index < model.count; index += 1) if (!isRemoved(model, state, index)) live += 1;
  return live;
}

/** 某个簇里的点；默认不含已移除的。 */
export function clusterMembers(model: AtlasModel, cluster: number, include: (index: number) => boolean): number[] {
  const out: number[] = [];
  for (let index = 0; index < model.count; index += 1) {
    if (model.clusters[index] === cluster && include(index)) out.push(index);
  }
  return out;
}

/** 选中的点按是否已移除分成两组：前者可以移除，后者可以恢复。 */
export function partitionSelection(
  model: AtlasModel,
  state: Pick<FlagState, "pendingRemoved" | "pendingRestored">,
  selected: Iterable<number>,
): { live: number[]; removed: number[] } {
  const live: number[] = [];
  const removed: number[] = [];
  for (const index of selected) {
    if (index < 0 || index >= model.count) continue;
    (isRemoved(model, state, index) ? removed : live).push(index);
  }
  live.sort((a, b) => a - b);
  removed.sort((a, b) => a - b);
  return { live, removed };
}

export type SelectMode = "replace" | "add" | "toggle";

/** 套索、点击、选簇都走这里：替换、追加，或逐个切换。 */
export function applySelection(current: ReadonlySet<number>, indices: readonly number[], mode: SelectMode): Set<number> {
  if (mode === "replace") return new Set(indices);
  const next = new Set(current);
  for (const index of indices) {
    if (mode === "toggle" && next.has(index)) next.delete(index);
    else next.add(index);
  }
  return next;
}
