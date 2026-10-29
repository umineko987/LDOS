// 渲染基准的 WebGL2 后端：每个方块一个 POINTS 顶点，位置每帧整块上传，颜色下标只在换场景时上传一次。

import { createProgram, uniformLocation } from "../gl.ts";
import type { GfxBackend } from "../host.ts";
import { MAX_PALETTE, type SpriteField } from "./sprites.ts";

const VERTEX = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in float a_color;
uniform vec2 u_viewport;
uniform float u_size;
uniform float u_dpr;
uniform vec3 u_palette[${MAX_PALETTE}];
flat out vec3 v_color;
void main() {
  // a_position 是左上角，点精灵以中心定位；y 轴朝下，和 Canvas2D 一致。
  vec2 clip = (a_position + 0.5 * u_size) / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = u_size * u_dpr;
  v_color = u_palette[int(a_color)];
}
`;

const FRAGMENT = `#version 300 es
precision mediump float;
flat in vec3 v_color;
out vec4 o_color;
void main() {
  o_color = vec4(v_color, 1.0);
}
`;

export function createWebGL2Sprites(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): GfxBackend<SpriteField> {
  const program = createProgram(gl, VERTEX, FRAGMENT);
  const uniforms = {
    viewport: uniformLocation(gl, program, "u_viewport"),
    size: uniformLocation(gl, program, "u_size"),
    dpr: uniformLocation(gl, program, "u_dpr"),
    palette: uniformLocation(gl, program, "u_palette"),
  };
  const vao = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  const colorBuffer = gl.createBuffer();
  let uploaded: SpriteField | null = null;
  let width = 1;
  let height = 1;
  let dpr = 1;

  function upload(field: SpriteField) {
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, field.positions.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, field.colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    const palette = new Float32Array(MAX_PALETTE * 3);
    field.palette.forEach((rgb, index) => palette.set(rgb.map((channel) => channel / 255), index * 3));
    gl.useProgram(program);
    gl.uniform3fv(uniforms.palette, palette);
    uploaded = field;
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
    draw(field) {
      if (gl.isContextLost()) return;
      if (uploaded !== field) upload(field);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, field.positions);
      gl.uniform2f(uniforms.viewport, width, height);
      gl.uniform1f(uniforms.size, field.size);
      gl.uniform1f(uniforms.dpr, dpr);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, field.count);
    },
    destroy() {
      if (gl.isContextLost()) return;
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(colorBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
