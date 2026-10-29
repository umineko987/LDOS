// 语义地图的 WebGL2 后端：点和缩略图都是实例化的四边形。
//
// - 点：位置和簇号随 model 上传一次，状态位随 flags 上传；画两遍，第二遍只画选中和保留预览里的点，
//   让它们盖在别的点上面。圆和环用距离场在片元着色器里画，边缘按设备像素抗锯齿。
// - 缩略图：每个实例是（世界坐标、格子左上角 uv、状态位），按雪碧图分段，一段一次绘制调用。
//   纹理最多留 MAX_TEXTURES 张，超出时删掉最久没用的。
// 颜色按预乘 alpha 输出，混合用 ONE / ONE_MINUS_SRC_ALPHA。

import { FLAG_DROP, FLAG_HIDDEN, FLAG_OUTLIER, FLAG_REMOVED, FLAG_SELECTED, type AtlasModel } from "#lib/domain/atlas-model.ts";
import { pixelsPerUnit, POINT_RADIUS } from "#lib/domain/atlas-view.ts";

import { createProgram, uniformLocation } from "../gl.ts";
import type { GfxBackend } from "../host.ts";
import { MAX_PALETTE, sheetRuns, spriteSource, type AtlasScene, type Rgb, type SceneColors, type SheetRun } from "./scene.ts";

const MAX_TEXTURES = 8;
/** 点的四边形比圆大这么多（CSS 像素），给外环和抗锯齿留地方。 */
const POINT_PAD = 4.5;
const SPRITE_BORDER = 2;
const SPRITE_STRIDE = 5;

const POINT_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_world;
layout(location = 2) in uint a_cluster;
layout(location = 3) in uint a_flags;
uniform vec2 u_viewport;
uniform vec3 u_camera;
uniform float u_extent;
uniform int u_pass;
uniform int u_paletteLength;
uniform vec3 u_palette[${MAX_PALETTE}];
out vec2 v_offset;
flat out uint v_flags;
flat out vec3 v_color;
void main() {
  bool emphasized = (a_flags & ${FLAG_SELECTED | FLAG_DROP}u) != 0u;
  if ((a_flags & ${FLAG_HIDDEN}u) != 0u || emphasized != (u_pass == 1)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 screen = u_viewport * 0.5 + (a_world - u_camera.xy) * u_camera.z;
  vec2 offset = a_corner * u_extent;
  vec2 clip = (screen + offset) / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_offset = offset;
  v_flags = a_flags;
  v_color = u_palette[int(a_cluster % uint(max(u_paletteLength, 1)))];
}
`;

const POINT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_offset;
flat in uint v_flags;
flat in vec3 v_color;
uniform float u_radius;
uniform float u_dpr;
uniform float u_alpha;
uniform vec3 u_selected;
uniform vec3 u_drop;
uniform vec3 u_removed;
uniform vec3 u_outlier;
out vec4 o_color;

float aa;

float disc(float d, float r) {
  return 1.0 - smoothstep(r - aa, r + aa, d);
}

float ring(float d, float r, float halfWidth) {
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(d - r));
}

vec4 over(vec4 top, vec4 bottom) {
  return top + bottom * (1.0 - top.a);
}

void main() {
  aa = 0.5 / u_dpr + 0.25;
  float d = length(v_offset);
  bool selected = (v_flags & ${FLAG_SELECTED}u) != 0u;
  vec4 color = vec4(0.0);
  if ((v_flags & ${FLAG_REMOVED}u) != 0u) {
    float a = ring(d, u_radius - 0.6, 0.6) * (selected ? 1.0 : 0.9);
    color = vec4((selected ? u_selected : u_removed) * a, a);
  } else {
    float a = selected ? disc(d, u_radius + 0.75) : disc(d, u_radius) * u_alpha;
    color = vec4((selected ? u_selected : v_color) * a, a);
    if ((v_flags & ${FLAG_OUTLIER}u) != 0u && !selected) {
      float r = ring(d, u_radius + 1.75, 0.5) * 0.55;
      color = over(color, vec4(u_outlier * r, r));
    }
  }
  if ((v_flags & ${FLAG_DROP}u) != 0u) {
    float r = ring(d, u_radius + 2.5, 0.625);
    color = over(vec4(u_drop * r, r), color);
  }
  if (color.a < 0.004) discard;
  o_color = color;
}
`;

const SPRITE_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_world;
layout(location = 2) in vec2 a_cell;
layout(location = 3) in float a_flags;
uniform vec2 u_viewport;
uniform vec3 u_camera;
uniform float u_size;
uniform float u_border;
out vec2 v_offset;
flat out vec2 v_cell;
flat out uint v_flags;
void main() {
  vec2 screen = u_viewport * 0.5 + (a_world - u_camera.xy) * u_camera.z;
  vec2 offset = a_corner * (u_size * 0.5 + u_border);
  vec2 clip = (screen + offset) / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_offset = offset;
  v_cell = a_cell;
  v_flags = uint(a_flags + 0.5);
}
`;

const SPRITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_offset;
flat in vec2 v_cell;
flat in uint v_flags;
uniform sampler2D u_sheet;
uniform int u_hasSheet;
uniform float u_size;
uniform float u_border;
uniform float u_cellUv;
uniform float u_texel;
uniform float u_dpr;
uniform vec3 u_placeholder;
uniform vec3 u_selected;
uniform vec3 u_drop;
out vec4 o_color;
void main() {
  float aa = 0.5 / u_dpr;
  float half_ = u_size * 0.5;
  float edge = max(abs(v_offset.x), abs(v_offset.y));
  float inside = 1.0 - smoothstep(half_ - aa, half_ + aa, edge);
  vec4 image = vec4(u_placeholder, 1.0);
  if (u_hasSheet == 1) {
    vec2 uv = v_cell + (v_offset / u_size + 0.5) * u_cellUv;
    uv = clamp(uv, v_cell + 0.5 * u_texel, v_cell + u_cellUv - 0.5 * u_texel);
    image = texture(u_sheet, uv);
  }
  if ((v_flags & ${FLAG_REMOVED}u) != 0u) image *= 0.35;
  vec4 color = image * inside;
  if ((v_flags & ${FLAG_SELECTED | FLAG_DROP}u) != 0u) {
    vec3 tone = (v_flags & ${FLAG_SELECTED}u) != 0u ? u_selected : u_drop;
    float band = smoothstep(half_ - aa, half_ + aa, edge) * (1.0 - smoothstep(half_ + u_border - aa, half_ + u_border + aa, edge));
    color = vec4(tone * band, band) + color * (1.0 - band);
  }
  if (color.a < 0.004) discard;
  o_color = color;
}
`;

const CORNERS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

function paletteUniform(palette: readonly Rgb[]): Float32Array {
  const values = new Float32Array(MAX_PALETTE * 3);
  palette.slice(0, MAX_PALETTE).forEach((rgb, index) => values.set(rgb.map((channel) => channel / 255), index * 3));
  return values;
}

const unit = (rgb: Rgb): [number, number, number] => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];

interface CachedTexture {
  readonly bitmap: ImageBitmap;
  readonly texture: WebGLTexture;
  used: number;
}

export function createWebGL2Atlas(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): GfxBackend<AtlasScene> {
  const points = createProgram(gl, POINT_VERTEX, POINT_FRAGMENT);
  const sprites = createProgram(gl, SPRITE_VERTEX, SPRITE_FRAGMENT);
  const pointUniforms = Object.fromEntries(
    [
      "u_viewport",
      "u_camera",
      "u_extent",
      "u_pass",
      "u_paletteLength",
      "u_palette",
      "u_radius",
      "u_dpr",
      "u_alpha",
      "u_selected",
      "u_drop",
      "u_removed",
      "u_outlier",
    ].map((name) => [name, uniformLocation(gl, points, name)]),
  );
  const spriteUniforms = Object.fromEntries(
    [
      "u_viewport",
      "u_camera",
      "u_size",
      "u_border",
      "u_sheet",
      "u_hasSheet",
      "u_cellUv",
      "u_texel",
      "u_dpr",
      "u_placeholder",
      "u_selected",
      "u_drop",
    ].map((name) => [name, uniformLocation(gl, sprites, name)]),
  );

  const cornerBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);

  const positionBuffer = gl.createBuffer();
  const clusterBuffer = gl.createBuffer();
  const flagBuffer = gl.createBuffer();
  const spriteBuffer = gl.createBuffer();

  const pointVao = gl.createVertexArray();
  gl.bindVertexArray(pointVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, clusterBuffer);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_SHORT, 0, 0);
  gl.vertexAttribDivisor(2, 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, flagBuffer);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_BYTE, 0, 0);
  gl.vertexAttribDivisor(3, 1);

  const spriteVao = gl.createVertexArray();
  gl.bindVertexArray(spriteVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  for (const location of [1, 2, 3]) {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribDivisor(location, 1);
  }
  gl.bindVertexArray(null);

  const textures = new Map<number, CachedTexture>();
  let frame = 0;
  let width = 1;
  let height = 1;
  let dpr = 1;
  let modelFor: AtlasModel | null = null;
  let flagsFor: Uint8Array | null = null;
  let paletteFor: readonly Rgb[] | null = null;
  let spritesFor: Int32Array | null = null;
  let spriteFlagsFor: Uint8Array | null = null;
  let runs: SheetRun[] = [];

  function uploadModel(model: AtlasModel) {
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, model.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, clusterBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, model.clusters, gl.STATIC_DRAW);
    modelFor = model;
    flagsFor = null;
    spritesFor = null;
  }

  function setColors(program: Record<string, WebGLUniformLocation>, colors: SceneColors, names: readonly (keyof SceneColors)[]) {
    for (const name of names) gl.uniform3fv(program[`u_${name}`]!, unit(colors[name]));
  }

  function drawPoints(scene: AtlasScene) {
    const { model, flags, palette } = scene;
    if (flagsFor !== flags) {
      gl.bindBuffer(gl.ARRAY_BUFFER, flagBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, flags, gl.DYNAMIC_DRAW);
      flagsFor = flags;
    }
    gl.useProgram(points);
    if (paletteFor !== palette) {
      gl.uniform3fv(pointUniforms.u_palette!, paletteUniform(palette));
      gl.uniform1i(pointUniforms.u_paletteLength!, Math.min(palette.length, MAX_PALETTE));
      paletteFor = palette;
    }
    gl.uniform2f(pointUniforms.u_viewport!, width, height);
    gl.uniform3f(pointUniforms.u_camera!, scene.camera.x, scene.camera.y, pixelsPerUnit(scene.camera, { width, height }));
    gl.uniform1f(pointUniforms.u_extent!, POINT_RADIUS + POINT_PAD);
    gl.uniform1f(pointUniforms.u_radius!, POINT_RADIUS);
    gl.uniform1f(pointUniforms.u_dpr!, dpr);
    gl.uniform1f(pointUniforms.u_alpha!, 0.88);
    setColors(pointUniforms, scene.colors, ["selected", "drop", "removed", "outlier"]);
    gl.bindVertexArray(pointVao);
    for (const pass of [0, 1]) {
      gl.uniform1i(pointUniforms.u_pass!, pass);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, model.count);
    }
  }

  function texture(index: number, bitmap: ImageBitmap): WebGLTexture {
    const cached = textures.get(index);
    if (cached && cached.bitmap === bitmap) {
      cached.used = frame;
      return cached.texture;
    }
    if (cached) gl.deleteTexture(cached.texture);
    while (textures.size >= MAX_TEXTURES) {
      const [oldest] = [...textures.entries()].sort((a, b) => a[1].used - b[1].used)[0]!;
      gl.deleteTexture(textures.get(oldest)!.texture);
      textures.delete(oldest);
    }
    const created = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, created);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    textures.set(index, { bitmap, texture: created, used: frame });
    return created;
  }

  function uploadSprites(scene: AtlasScene) {
    const { model, flags } = scene;
    const list = scene.sprites;
    const data = new Float32Array(list.length * SPRITE_STRIDE);
    const sheets = model.sheets;
    for (let position = 0; position < list.length; position += 1) {
      const index = list[position]!;
      const offset = position * SPRITE_STRIDE;
      data[offset] = model.positions[index * 2]!;
      data[offset + 1] = model.positions[index * 2 + 1]!;
      const cell = model.sprites[index * 2 + 1]!;
      if (sheets && cell >= 0) {
        const [sx, sy] = spriteSource(cell, sheets);
        data[offset + 2] = sx / sheets.sheetSize;
        data[offset + 3] = sy / sheets.sheetSize;
      }
      data[offset + 4] = flags[index]!;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    if (spritesFor !== list) runs = sheetRuns(model, list);
    spritesFor = list;
    spriteFlagsFor = flags;
  }

  function drawSprites(scene: AtlasScene) {
    const sheets = scene.model.sheets;
    if (spritesFor !== scene.sprites || spriteFlagsFor !== scene.flags) uploadSprites(scene);
    gl.useProgram(sprites);
    gl.uniform2f(spriteUniforms.u_viewport!, width, height);
    gl.uniform3f(spriteUniforms.u_camera!, scene.camera.x, scene.camera.y, pixelsPerUnit(scene.camera, { width, height }));
    gl.uniform1f(spriteUniforms.u_size!, scene.spriteSize);
    gl.uniform1f(spriteUniforms.u_border!, SPRITE_BORDER);
    gl.uniform1f(spriteUniforms.u_cellUv!, sheets ? sheets.cellSize / sheets.sheetSize : 0);
    gl.uniform1f(spriteUniforms.u_texel!, sheets ? 1 / sheets.sheetSize : 0);
    gl.uniform1f(spriteUniforms.u_dpr!, dpr);
    gl.uniform1i(spriteUniforms.u_sheet!, 0);
    setColors(spriteUniforms, scene.colors, ["placeholder", "selected", "drop"]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuffer);
    const stride = SPRITE_STRIDE * 4;
    for (const run of runs) {
      const bitmap = run.sheet >= 0 ? scene.sheet(run.sheet) : null;
      gl.uniform1i(spriteUniforms.u_hasSheet!, bitmap ? 1 : 0);
      if (bitmap) gl.bindTexture(gl.TEXTURE_2D, texture(run.sheet, bitmap));
      // WebGL2 没有 baseInstance：每段把实例属性的起点挪到这一段。
      const base = run.start * stride;
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, base);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, base + 8);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, base + 16);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.count);
    }
  }

  return {
    resize(nextWidth, nextHeight, nextDpr) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      dpr = nextDpr;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    draw(scene) {
      if (gl.isContextLost()) return;
      frame += 1;
      if (modelFor !== scene.model) uploadModel(scene.model);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      if (scene.mode === "sprites") drawSprites(scene);
      else drawPoints(scene);
      gl.bindVertexArray(null);
    },
    destroy() {
      if (gl.isContextLost()) return;
      for (const cached of textures.values()) gl.deleteTexture(cached.texture);
      textures.clear();
      for (const buffer of [cornerBuffer, positionBuffer, clusterBuffer, flagBuffer, spriteBuffer]) gl.deleteBuffer(buffer);
      gl.deleteVertexArray(pointVao);
      gl.deleteVertexArray(spriteVao);
      gl.deleteProgram(points);
      gl.deleteProgram(sprites);
    },
  };
}
