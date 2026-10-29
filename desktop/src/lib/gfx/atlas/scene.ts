// 语义地图的场景：两种渲染器画同一份数据。
//
// 渲染器按对象身份判断哪些要重新上传：model 变了重传位置和颜色，flags 变了重传状态位，
// sprites（缩略图模式下要画的点）变了重建实例数据。页面只在这些东西真的变了时换新对象，
// 并且只在有变化时才请求重画，没有每帧循环。

import { FLAG_HIDDEN, type AtlasModel, type SpriteSheets } from "#lib/domain/atlas-model.ts";
import type { Camera, LodMode } from "#lib/domain/atlas-view.ts";

import { parseHexColor, type Rgb } from "../bench/sprites.ts";

export type { Rgb };

export interface SceneColors {
  readonly selected: Rgb;
  readonly drop: Rgb;
  readonly removed: Rgb;
  readonly outlier: Rgb;
  readonly placeholder: Rgb;
}

export interface AtlasScene {
  readonly model: AtlasModel;
  readonly flags: Uint8Array;
  readonly camera: Camera;
  readonly mode: LodMode;
  /** 缩略图模式下要画的点：已去掉隐藏的，按雪碧图编号排好，没有缩略图的排最后。点模式下为空。 */
  readonly sprites: Int32Array;
  /** 缩略图在屏幕上的边长（CSS 像素）。 */
  readonly spriteSize: number;
  /** 已加载的雪碧图；还没加载好时为 null，画占位方块。 */
  sheet(index: number): ImageBitmap | null;
  /** 有新的雪碧图加载完成时递增。 */
  readonly sheetsVersion: number;
  readonly palette: readonly Rgb[];
  readonly colors: SceneColors;
}

/** 簇的颜色：低饱和，避开金色（金色只给选中态）。簇编号超过调色板长度时循环使用。 */
export const CLUSTER_PALETTE_HEX = [
  "#8ea0c8",
  "#a6b3a0",
  "#c49a8a",
  "#a993c9",
  "#86b4c8",
  "#c98a7f",
  "#9cbfa8",
  "#b48fb0",
  "#c0b4a4",
  "#7fa3a8",
] as const;

export const MAX_PALETTE = 12;

export const CLUSTER_PALETTE: readonly Rgb[] = CLUSTER_PALETTE_HEX.map((hex) => parseHexColor(hex)!);

export function clusterColorIndex(cluster: number, paletteLength: number): number {
  return paletteLength > 0 ? cluster % paletteLength : 0;
}

export function rgbCss([r, g, b]: Rgb, alpha = 1): string {
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

const COLOR_VARS: Readonly<Record<keyof SceneColors, readonly [string, string]>> = {
  selected: ["--gold", "#e6bd75"],
  drop: ["--danger", "#d77a6e"],
  removed: ["--line3", "#444a55"],
  outlier: ["--fg2", "#a19f99"],
  placeholder: ["--bg3", "#1e2127"],
};

/** 从设计令牌读颜色；读不到（测试、令牌缺失）时用默认值。 */
export function readSceneColors(read: (name: string) => string): SceneColors {
  const entries = Object.entries(COLOR_VARS).map(([key, [name, fallback]]) => [
    key,
    parseHexColor(read(name)) ?? parseHexColor(fallback)!,
  ]);
  return Object.fromEntries(entries) as unknown as SceneColors;
}

/** 雪碧图里第 `cell` 格的左上角和边长（像素）。 */
export function spriteSource(cell: number, sheets: Pick<SpriteSheets, "columns" | "cellSize">): [number, number, number] {
  return [(cell % sheets.columns) * sheets.cellSize, Math.floor(cell / sheets.columns) * sheets.cellSize, sheets.cellSize];
}

/** 缩略图模式的绘制顺序：去掉隐藏的点，按雪碧图编号稳定排序，没有缩略图的放最后。 */
export function spriteOrder(model: AtlasModel, flags: Uint8Array, indices: readonly number[]): Int32Array {
  const kept = indices.filter((index) => index >= 0 && index < model.count && !(flags[index]! & FLAG_HIDDEN));
  const sheetOf = (index: number) => {
    const sheet = model.sprites[index * 2]!;
    return sheet < 0 ? Number.MAX_SAFE_INTEGER : sheet;
  };
  kept.sort((a, b) => sheetOf(a) - sheetOf(b) || a - b);
  return Int32Array.from(kept);
}

/** `sprites` 里用到的雪碧图编号，升序。 */
export function neededSheets(model: AtlasModel, sprites: Int32Array): number[] {
  const sheets = new Set<number>();
  for (const index of sprites) {
    const sheet = model.sprites[index * 2]!;
    if (sheet >= 0) sheets.add(sheet);
  }
  return [...sheets].sort((a, b) => a - b);
}

export interface SheetRun {
  readonly sheet: number;
  readonly start: number;
  readonly count: number;
}

/** 按雪碧图分段：同一张图的点连续，一段一次绘制调用。sheet = -1 是没有缩略图的那段。 */
export function sheetRuns(model: AtlasModel, sprites: Int32Array): SheetRun[] {
  const runs: SheetRun[] = [];
  let start = 0;
  for (let position = 1; position <= sprites.length; position += 1) {
    const sheet = model.sprites[sprites[start]! * 2]!;
    if (position === sprites.length || model.sprites[sprites[position]! * 2]! !== sheet) {
      runs.push({ sheet, start, count: position - start });
      start = position;
    }
  }
  return runs;
}

/** 点模式下按颜色分组的下标，Canvas2D 每种颜色只 fill 一次。 */
export function colorGroups(model: AtlasModel, paletteLength: number): number[][] {
  const groups: number[][] = Array.from({ length: Math.max(1, paletteLength) }, () => []);
  for (let index = 0; index < model.count; index += 1) {
    groups[clusterColorIndex(model.clusters[index]!, paletteLength)]!.push(index);
  }
  return groups;
}
