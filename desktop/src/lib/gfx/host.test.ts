import { describe, expect, it, vi } from "vitest";

import { createGfxHost, GfxUnavailableError, type GfxBackend, type GfxBackends } from "./host.ts";
import type { WebGL2Support } from "./renderer.ts";

const ACCELERATED: WebGL2Support = { available: true, accelerated: true, renderer: null };

interface FakeContexts {
  webgl2?: boolean;
  "2d"?: boolean;
}

/** 够宿主用的假画布：getContext、事件监听、从容器里移除。 */
class FakeCanvas {
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<() => void>>();
  parent: FakeContainer | null = null;
  readonly loseContext = vi.fn(() => this.dispatch("webglcontextlost"));
  readonly gl = {
    getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext: this.loseContext } : null),
  };
  readonly context2d = {};

  constructor(private readonly contexts: FakeContexts) {}

  getContext(type: "webgl2" | "2d") {
    if (type === "webgl2") return this.contexts.webgl2 === false ? null : this.gl;
    return this.contexts["2d"] === false ? null : this.context2d;
  }

  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  remove() {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

class FakeContainer {
  readonly children: FakeCanvas[] = [];
  append(canvas: FakeCanvas) {
    this.children.push(canvas);
    canvas.parent = this;
  }
}

type Scene = { frame: number };

function fakeBackend() {
  return { resize: vi.fn(), draw: vi.fn(), destroy: vi.fn() } satisfies GfxBackend<Scene>;
}

function setup(options: { contexts?: FakeContexts; webgl2Throws?: boolean } = {}) {
  const container = new FakeContainer();
  const canvases: FakeCanvas[] = [];
  const created: { kind: string; backend: ReturnType<typeof fakeBackend>; canvas: unknown; context: unknown }[] = [];
  const backends: GfxBackends<Scene> = {
    webgl2(gl, canvas) {
      if (options.webgl2Throws) throw new Error("shader compile failed");
      const backend = fakeBackend();
      created.push({ kind: "webgl2", backend, canvas, context: gl });
      return backend;
    },
    canvas2d(context, canvas) {
      const backend = fakeBackend();
      created.push({ kind: "canvas2d", backend, canvas, context });
      return backend;
    },
  };
  const createCanvas = () => {
    const canvas = new FakeCanvas(options.contexts ?? {});
    canvases.push(canvas);
    return canvas as unknown as HTMLCanvasElement;
  };
  return { container, canvases, created, backends, createCanvas, onChange: vi.fn(), onError: vi.fn() };
}

function host(env: ReturnType<typeof setup>, extra: Partial<Parameters<typeof createGfxHost<Scene>>[0]> = {}) {
  return createGfxHost<Scene>({
    container: env.container as unknown as HTMLElement,
    backends: env.backends,
    createCanvas: env.createCanvas,
    support: ACCELERATED,
    onChange: env.onChange,
    onError: env.onError,
    ...extra,
  });
}

describe("createGfxHost", () => {
  it("自动模式在有硬件加速时挂上 WebGL2", () => {
    const env = setup();
    const gfx = host(env);
    expect(gfx.choice).toEqual({ kind: "webgl2", reason: "auto" });
    expect(gfx.preference).toBe("auto");
    expect(env.onChange).toHaveBeenCalledWith({ kind: "webgl2", reason: "auto" });
    expect(env.container.children).toHaveLength(1);
    expect(env.container.children[0]!.dataset.renderer).toBe("webgl2");
    expect(env.created[0]).toMatchObject({ kind: "webgl2", canvas: env.canvases[0], context: env.canvases[0]!.gl });

    gfx.draw({ frame: 1 });
    expect(env.created[0]!.backend.draw).toHaveBeenCalledWith({ frame: 1 });
  });

  it("上下文丢失后换一块新画布用 Canvas2D，尺寸带过去；换偏好时重试 WebGL2", () => {
    const env = setup();
    const gfx = host(env);
    gfx.resize(640, 480, 2);
    const first = env.created[0]!;
    expect(first.backend.resize).toHaveBeenCalledWith(640, 480, 2);

    expect(gfx.loseContext()).toBe(true);
    expect(first.backend.destroy).toHaveBeenCalledOnce();
    expect(env.canvases[0]!.parent).toBeNull();
    expect(env.canvases[0]!.listeners.get("webglcontextlost")?.size).toBe(0);
    expect(gfx.choice).toEqual({ kind: "canvas2d", reason: "context_lost" });
    expect(env.container.children).toEqual([env.canvases[1]]);
    expect(env.canvases[1]!.dataset.renderer).toBe("canvas2d");
    const second = env.created[1]!;
    expect(second).toMatchObject({ kind: "canvas2d", context: env.canvases[1]!.context2d });
    expect(second.backend.resize).toHaveBeenCalledWith(640, 480, 2);
    expect(gfx.loseContext()).toBe(false);

    gfx.draw({ frame: 2 });
    expect(first.backend.draw).not.toHaveBeenCalled();
    expect(second.backend.draw).toHaveBeenCalledWith({ frame: 2 });

    gfx.setPreference("auto");
    expect(gfx.choice).toEqual({ kind: "webgl2", reason: "auto" });
    expect(second.backend.destroy).toHaveBeenCalledOnce();
    expect(env.onChange).toHaveBeenCalledTimes(3);
  });

  it("手动选择 Canvas2D", () => {
    const env = setup();
    const gfx = host(env, { preference: "canvas2d" });
    expect(gfx.choice).toEqual({ kind: "canvas2d", reason: "forced" });
    gfx.setPreference("webgl2");
    expect(gfx.choice).toEqual({ kind: "webgl2", reason: "forced" });
    expect(gfx.preference).toBe("webgl2");
  });

  it("WebGL2 后端初始化抛错：报告错误、释放上下文、回退 Canvas2D", () => {
    const env = setup({ webgl2Throws: true });
    const gfx = host(env);
    expect(gfx.choice).toEqual({ kind: "canvas2d", reason: "init_failed" });
    expect(env.onError).toHaveBeenCalledWith(new Error("shader compile failed"));
    expect(env.canvases[0]!.loseContext).toHaveBeenCalledOnce();
    expect(env.container.children).toEqual([env.canvases[1]]);
  });

  it("探测说有 WebGL2 但建不了上下文时同样回退；不传 onError 也行", () => {
    const env = setup({ contexts: { webgl2: false } });
    const gfx = host(env, { onError: undefined, onChange: undefined });
    expect(gfx.choice).toEqual({ kind: "canvas2d", reason: "init_failed" });

    const throwing = setup({ webgl2Throws: true });
    expect(host(throwing, { onError: undefined }).choice.reason).toBe("init_failed");
  });

  it("没传 support 时用同一个画布工厂现场探测", () => {
    const env = setup({ contexts: { webgl2: false } });
    const gfx = host(env, { support: undefined });
    expect(gfx.support).toEqual({ available: false, accelerated: false, renderer: null });
    expect(gfx.choice).toEqual({ kind: "canvas2d", reason: "unsupported" });
    // 两块探测画布没有挂进容器。
    expect(env.canvases).toHaveLength(3);
    expect(env.container.children).toEqual([env.canvases[2]]);
  });

  it("连 Canvas2D 都没有时抛 GfxUnavailableError", () => {
    const env = setup({ contexts: { "2d": false } });
    expect(() => host(env, { preference: "canvas2d" })).toThrow(GfxUnavailableError);
    expect(env.container.children).toHaveLength(0);
  });

  it("销毁后释放画布，之后的调用都不做事", () => {
    const env = setup();
    const gfx = host(env);
    gfx.destroy();
    expect(env.created[0]!.backend.destroy).toHaveBeenCalledOnce();
    expect(env.container.children).toHaveLength(0);
    gfx.setPreference("canvas2d");
    gfx.resize(1, 1, 1);
    gfx.draw({ frame: 3 });
    expect(gfx.loseContext()).toBe(false);
    expect(env.container.children).toHaveLength(0);
    expect(env.created).toHaveLength(1);
    expect(gfx.choice).toEqual({ kind: "canvas2d", reason: "forced" });
  });
});
