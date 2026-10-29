// 渲染基准的 Canvas2D 后端：逐个 fillRect。颜色按块排好，每帧只换调色板长度那么多次 fillStyle。

import type { GfxBackend } from "../host.ts";
import type { Rgb, SpriteField } from "./sprites.ts";

export function createCanvas2DSprites(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
): GfxBackend<SpriteField> {
  let width = 1;
  let height = 1;
  let styles: string[] = [];
  let stylesFor: readonly Rgb[] | null = null;

  return {
    resize(nextWidth, nextHeight, dpr) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      // 改 canvas 尺寸会重置变换，之后再设。
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    },
    draw(field) {
      if (stylesFor !== field.palette) {
        styles = field.palette.map(([r, g, b]) => `rgb(${r} ${g} ${b})`);
        stylesFor = field.palette;
      }
      context.clearRect(0, 0, width, height);
      const { positions, colors, size, count } = field;
      let color = -1;
      for (let i = 0; i < count; i += 1) {
        if (colors[i] !== color) {
          color = colors[i]!;
          context.fillStyle = styles[color]!;
        }
        context.fillRect(positions[i * 2]!, positions[i * 2 + 1]!, size, size);
      }
    },
    destroy() {},
  };
}
