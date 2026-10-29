// 画布宿主：按渲染器选择建 canvas 和上下文；WebGL2 上下文丢失或后端初始化失败时换成 Canvas2D。
//
// 换渲染器要换一块新 canvas：拿过 webgl2 上下文的 canvas 再也拿不到 2d 上下文。
// 场景数据（Scene）由调用方持有，两种后端画同一份，切换后不丢状态。
// 尺寸由调用方测量后传进来（ResizeObserver），宿主只负责把它转给当前后端。

import {
  chooseRenderer,
  probeWebGL2,
  type RendererChoice,
  type RendererPreference,
  type WebGL2Support,
} from "./renderer.ts";

export interface GfxBackend<Scene> {
  /** width、height 是 CSS 像素；后端按 dpr 设 canvas 的像素尺寸。 */
  resize(width: number, height: number, dpr: number): void;
  draw(scene: Scene): void;
  destroy(): void;
}

export interface GfxBackends<Scene> {
  /** 可以抛错（如着色器编译失败），宿主会改用 Canvas2D。 */
  webgl2(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): GfxBackend<Scene>;
  canvas2d(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): GfxBackend<Scene>;
}

export interface GfxHostOptions<Scene> {
  readonly container: HTMLElement;
  readonly backends: GfxBackends<Scene>;
  readonly preference?: RendererPreference;
  /** 默认现场探测；测试里直接给。 */
  readonly support?: WebGL2Support;
  readonly webgl2Attributes?: WebGLContextAttributes;
  readonly createCanvas?: () => HTMLCanvasElement;
  /** 每次换后端（含首次挂载）之后调用。 */
  readonly onChange?: (choice: RendererChoice) => void;
  /** WebGL2 后端初始化抛出的错误；不传就丢弃（选择里的 reason 是 init_failed）。 */
  readonly onError?: (error: unknown) => void;
}

export interface GfxHost<Scene> {
  readonly choice: RendererChoice;
  readonly support: WebGL2Support;
  readonly preference: RendererPreference;
  /** 换偏好时也清掉“上下文丢失”的记录，相当于重试 WebGL2。 */
  setPreference(preference: RendererPreference): void;
  resize(width: number, height: number, dpr: number): void;
  draw(scene: Scene): void;
  /** 开发用：通过 WEBGL_lose_context 模拟上下文丢失。当前不是 WebGL2 时返回 false。 */
  loseContext(): boolean;
  destroy(): void;
}

export class GfxUnavailableError extends Error {
  override name = "GfxUnavailableError";
}

const DEFAULT_WEBGL2_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
};

interface Mounted<Scene> {
  readonly canvas: HTMLCanvasElement;
  readonly backend: GfxBackend<Scene>;
  readonly choice: RendererChoice;
  readonly gl: WebGL2RenderingContext | null;
}

export function createGfxHost<Scene>(options: GfxHostOptions<Scene>): GfxHost<Scene> {
  const createCanvas = options.createCanvas ?? (() => document.createElement("canvas"));
  const support = options.support ?? probeWebGL2(createCanvas);
  let preference = options.preference ?? "auto";
  let size: readonly [number, number, number] | null = null;
  let current: Mounted<Scene> | null = null;
  let destroyed = false;

  function onContextLost() {
    mount(chooseRenderer(preference, support, true));
  }

  function unmount() {
    if (!current) return;
    current.canvas.removeEventListener("webglcontextlost", onContextLost);
    current.backend.destroy();
    current.canvas.remove();
    current = null;
  }

  function newCanvas(kind: RendererChoice["kind"]): HTMLCanvasElement {
    const canvas = createCanvas();
    canvas.dataset.renderer = kind;
    options.container.append(canvas);
    return canvas;
  }

  function attachCanvas2D(choice: RendererChoice): Mounted<Scene> {
    const canvas = newCanvas("canvas2d");
    const context = canvas.getContext("2d");
    if (!context) {
      canvas.remove();
      throw new GfxUnavailableError("Canvas2D is unavailable");
    }
    return { canvas, choice, gl: null, backend: options.backends.canvas2d(context, canvas) };
  }

  /** 建不了上下文或后端抛错时返回 null，由调用方回退。 */
  function attachWebGL2(choice: RendererChoice): Mounted<Scene> | null {
    const canvas = newCanvas("webgl2");
    const gl = canvas.getContext("webgl2", options.webgl2Attributes ?? DEFAULT_WEBGL2_ATTRIBUTES);
    if (gl) {
      try {
        const backend = options.backends.webgl2(gl, canvas);
        canvas.addEventListener("webglcontextlost", onContextLost);
        return { canvas, choice, gl, backend };
      } catch (error) {
        options.onError?.(error);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    }
    canvas.remove();
    return null;
  }

  function mount(choice: RendererChoice) {
    if (destroyed) return;
    unmount();
    const mounted =
      choice.kind === "webgl2"
        ? (attachWebGL2(choice) ?? attachCanvas2D({ kind: "canvas2d", reason: "init_failed" }))
        : attachCanvas2D(choice);
    current = mounted;
    if (size) mounted.backend.resize(...size);
    options.onChange?.(mounted.choice);
  }

  mount(chooseRenderer(preference, support));

  return {
    get choice() {
      return current?.choice ?? chooseRenderer(preference, support);
    },
    support,
    get preference() {
      return preference;
    },
    setPreference(next) {
      preference = next;
      mount(chooseRenderer(next, support));
    },
    resize(width, height, dpr) {
      size = [width, height, dpr];
      current?.backend.resize(width, height, dpr);
    },
    draw(scene) {
      current?.backend.draw(scene);
    },
    loseContext() {
      const extension = current?.gl?.getExtension("WEBGL_lose_context");
      if (!extension) return false;
      extension.loseContext();
      return true;
    },
    destroy() {
      unmount();
      destroyed = true;
    },
  };
}
