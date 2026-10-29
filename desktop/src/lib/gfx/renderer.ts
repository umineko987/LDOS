// 渲染器选择：图集这类要画大量点的视图在 WebGL2 和 Canvas2D 之间选一个，规则统一放在这里。
//
// 自动模式只在 WebGL2 有硬件加速时用它：WebKitGTK 在一些核显和驱动组合上只有软件 WebGL，
// 比 Canvas2D 还慢。手动指定 WebGL2 时不看是否加速，只要能建上下文就用。

export type RendererKind = "webgl2" | "canvas2d";

export type RendererPreference = "auto" | RendererKind;

/**
 * 为什么是这个渲染器：
 * auto 自动选择；forced 手动指定；unsupported 没有 WebGL2；software WebGL2 只有软件实现；
 * context_lost WebGL 上下文丢失；init_failed WebGL2 后端初始化失败（如着色器编译不过）。
 */
export type RendererReason = "auto" | "forced" | "unsupported" | "software" | "context_lost" | "init_failed";

export interface RendererChoice {
  readonly kind: RendererKind;
  readonly reason: RendererReason;
}

export interface WebGL2Support {
  readonly available: boolean;
  /** 不是软件渲染：要求 failIfMajorPerformanceCaveat 也能建上下文，且设备名不是已知的软件实现。 */
  readonly accelerated: boolean;
  /** 驱动报告的设备名（WEBGL_debug_renderer_info），拿不到时为 null。 */
  readonly renderer: string | null;
}

export const RENDERER_PREFERENCES: readonly RendererPreference[] = ["auto", "webgl2", "canvas2d"];

/** 本机保存的手动选择；所有画布视图共用。 */
export const RENDERER_STORAGE_KEY = "ldos.renderer";

export function chooseRenderer(
  preference: RendererPreference,
  support: WebGL2Support,
  contextLost = false,
): RendererChoice {
  if (preference === "canvas2d") return { kind: "canvas2d", reason: "forced" };
  if (contextLost) return { kind: "canvas2d", reason: "context_lost" };
  if (!support.available) return { kind: "canvas2d", reason: "unsupported" };
  if (preference === "webgl2") return { kind: "webgl2", reason: "forced" };
  return support.accelerated ? { kind: "webgl2", reason: "auto" } : { kind: "canvas2d", reason: "software" };
}

type CanvasFactory = () => HTMLCanvasElement;

const defaultCanvas: CanvasFactory = () => document.createElement("canvas");

// failIfMajorPerformanceCaveat 不总是可靠：Chromium 的 SwiftShader 不会因它失败，
// 所以再按设备名认一遍常见的软件实现（Mesa llvmpipe/softpipe/lavapipe、SwiftShader、Windows 基本显示）。
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i;

export function isSoftwareRenderer(renderer: string | null): boolean {
  return renderer !== null && SOFTWARE_RENDERER.test(renderer);
}

/** 用临时画布探测 WebGL2：先要求没有性能警告，不行再看有没有软件实现。 */
export function probeWebGL2(createCanvas: CanvasFactory = defaultCanvas): WebGL2Support {
  const strict = openWebGL2(createCanvas(), { failIfMajorPerformanceCaveat: true });
  const gl = strict ?? openWebGL2(createCanvas());
  if (!gl) return { available: false, accelerated: false, renderer: null };
  const renderer = rendererName(gl);
  // 探测用的上下文立即释放：浏览器对同时存在的 WebGL 上下文数量有上限。
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { available: true, accelerated: strict !== null && !isSoftwareRenderer(renderer), renderer };
}

function openWebGL2(canvas: HTMLCanvasElement, attributes?: WebGLContextAttributes): WebGL2RenderingContext | null {
  try {
    return canvas.getContext("webgl2", attributes);
  } catch {
    return null;
  }
}

function rendererName(gl: WebGL2RenderingContext): string | null {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    return typeof name === "string" && name !== "" ? name : null;
  } catch {
    return null;
  }
}

export function parsePreference(value: unknown): RendererPreference {
  return RENDERER_PREFERENCES.find((preference) => preference === value) ?? "auto";
}

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): PreferenceStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readPreference(storage: PreferenceStorage | null = browserStorage()): RendererPreference {
  try {
    return parsePreference(storage?.getItem(RENDERER_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

export function writePreference(preference: RendererPreference, storage: PreferenceStorage | null = browserStorage()): void {
  try {
    storage?.setItem(RENDERER_STORAGE_KEY, preference);
  } catch {
    // 存储不可用（配额、隐私模式）时只在本次会话生效。
  }
}
