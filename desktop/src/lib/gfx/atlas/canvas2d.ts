// 语义地图的 Canvas2D 后端：点模式每种簇颜色合成一条路径 fill 一次；缩略图模式逐张 drawImage。
// 画面上的样式和 WebGL2 后端一致：已移除画空心圈，离群点外加一圈淡环，选中用金色，保留预览里要去掉的加红环。

import { FLAG_DROP, FLAG_HIDDEN, FLAG_OUTLIER, FLAG_REMOVED, FLAG_SELECTED, type AtlasModel } from "#lib/domain/atlas-model.ts";
import { pixelsPerUnit, POINT_RADIUS } from "#lib/domain/atlas-view.ts";

import type { GfxBackend } from "../host.ts";
import { colorGroups, rgbCss, sheetRuns, spriteSource, type AtlasScene, type Rgb, type SheetRun } from "./scene.ts";

const TAU = Math.PI * 2;
/** 点的填充不透明度：密集处能看出叠了多少。 */
const POINT_ALPHA = 0.88;
const REMOVED_SPRITE_ALPHA = 0.35;

export function createCanvas2DAtlas(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): GfxBackend<AtlasScene> {
  let width = 1;
  let height = 1;
  let groupsFor: AtlasModel | null = null;
  let groupsPalette = 0;
  let groups: number[][] = [];
  let paletteFor: readonly Rgb[] | null = null;
  let paletteCss: string[] = [];
  let runsFor: Int32Array | null = null;
  let runs: SheetRun[] = [];

  function drawPoints(scene: AtlasScene) {
    const { model, flags, camera, palette, colors } = scene;
    if (groupsFor !== model || groupsPalette !== palette.length) {
      groups = colorGroups(model, palette.length);
      groupsFor = model;
      groupsPalette = palette.length;
    }
    if (paletteFor !== palette) {
      paletteCss = palette.map((rgb) => rgbCss(rgb, POINT_ALPHA));
      paletteFor = palette;
    }
    const scale = pixelsPerUnit(camera, { width, height });
    const originX = width / 2 - camera.x * scale;
    const originY = height / 2 - camera.y * scale;
    const radius = POINT_RADIUS;
    const margin = radius + 4;
    const positions = model.positions;
    const emphasized: number[] = [];
    const removed: number[] = [];
    const outliers: number[] = [];

    const screen = (index: number): [number, number] | null => {
      const x = originX + positions[index * 2]! * scale;
      const y = originY + positions[index * 2 + 1]! * scale;
      return x < -margin || y < -margin || x > width + margin || y > height + margin ? null : [x, y];
    };
    const circles = (indices: readonly number[], r: number) => {
      context.beginPath();
      for (const index of indices) {
        const at = screen(index);
        if (!at) continue;
        context.moveTo(at[0] + r, at[1]);
        context.arc(at[0], at[1], r, 0, TAU);
      }
    };

    groups.forEach((members, color) => {
      context.beginPath();
      for (const index of members) {
        const flag = flags[index]!;
        if (flag & FLAG_HIDDEN) continue;
        if (flag & (FLAG_SELECTED | FLAG_DROP)) emphasized.push(index);
        if (flag & FLAG_REMOVED) {
          if (!(flag & FLAG_SELECTED)) removed.push(index);
          continue;
        }
        if (flag & FLAG_OUTLIER && !(flag & FLAG_SELECTED)) outliers.push(index);
        if (flag & FLAG_SELECTED) continue;
        const at = screen(index);
        if (!at) continue;
        context.moveTo(at[0] + radius, at[1]);
        context.arc(at[0], at[1], radius, 0, TAU);
      }
      context.fillStyle = paletteCss[color]!;
      context.fill();
    });

    context.lineWidth = 1;
    circles(outliers, radius + 1.75);
    context.strokeStyle = rgbCss(colors.outlier, 0.55);
    context.stroke();

    context.lineWidth = 1.2;
    circles(removed, radius - 0.6);
    context.strokeStyle = rgbCss(colors.removed, 0.9);
    context.stroke();

    // 强调的点画在最上面：先红环（保留预览要去掉的），再金色（选中）。
    const drop = emphasized.filter((index) => flags[index]! & FLAG_DROP);
    context.lineWidth = 1.25;
    circles(drop, radius + 2.5);
    context.strokeStyle = rgbCss(colors.drop);
    context.stroke();

    const selectedLive = emphasized.filter((index) => flags[index]! & FLAG_SELECTED && !(flags[index]! & FLAG_REMOVED));
    circles(selectedLive, radius + 0.75);
    context.fillStyle = rgbCss(colors.selected);
    context.fill();

    const selectedRemoved = emphasized.filter((index) => flags[index]! & FLAG_SELECTED && flags[index]! & FLAG_REMOVED);
    context.lineWidth = 1.2;
    circles(selectedRemoved, radius - 0.6);
    context.strokeStyle = rgbCss(colors.selected);
    context.stroke();
  }

  function drawSprites(scene: AtlasScene) {
    const { model, flags, camera, sprites, colors } = scene;
    if (runsFor !== sprites) {
      runs = sheetRuns(model, sprites);
      runsFor = sprites;
    }
    const sheets = model.sheets;
    const scale = pixelsPerUnit(camera, { width, height });
    const originX = width / 2 - camera.x * scale;
    const originY = height / 2 - camera.y * scale;
    const size = scene.spriteSize;
    const half = size / 2;
    const placeholder = rgbCss(colors.placeholder);
    const outlined: number[] = [];
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "medium";

    for (const run of runs) {
      const bitmap = run.sheet >= 0 ? scene.sheet(run.sheet) : null;
      for (let position = run.start; position < run.start + run.count; position += 1) {
        const index = sprites[position]!;
        const x = originX + model.positions[index * 2]! * scale - half;
        const y = originY + model.positions[index * 2 + 1]! * scale - half;
        if (x > width || y > height || x + size < 0 || y + size < 0) continue;
        const flag = flags[index]!;
        context.globalAlpha = flag & FLAG_REMOVED ? REMOVED_SPRITE_ALPHA : 1;
        if (bitmap && sheets) {
          const [sx, sy, cell] = spriteSource(model.sprites[index * 2 + 1]!, sheets);
          context.drawImage(bitmap, sx, sy, cell, cell, x, y, size, size);
        } else {
          context.fillStyle = placeholder;
          context.fillRect(x, y, size, size);
        }
        if (flag & (FLAG_SELECTED | FLAG_DROP)) outlined.push(index);
      }
    }
    context.globalAlpha = 1;

    context.lineWidth = 2;
    for (const index of outlined) {
      const x = originX + model.positions[index * 2]! * scale - half;
      const y = originY + model.positions[index * 2 + 1]! * scale - half;
      context.strokeStyle = rgbCss(flags[index]! & FLAG_SELECTED ? colors.selected : colors.drop);
      context.strokeRect(x - 1, y - 1, size + 2, size + 2);
    }
  }

  return {
    resize(nextWidth, nextHeight, dpr) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      // 改 canvas 尺寸会重置变换，之后再设。
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    },
    draw(scene) {
      context.clearRect(0, 0, width, height);
      if (scene.mode === "sprites") drawSprites(scene);
      else drawPoints(scene);
    },
    destroy() {},
  };
}
