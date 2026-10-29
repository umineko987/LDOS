import { describe, expect, it, vi } from "vitest";

import {
  chooseRenderer,
  isSoftwareRenderer,
  parsePreference,
  probeWebGL2,
  readPreference,
  RENDERER_STORAGE_KEY,
  writePreference,
  type RendererPreference,
  type WebGL2Support,
} from "./renderer.ts";

const ACCELERATED: WebGL2Support = { available: true, accelerated: true, renderer: null };
const SOFTWARE: WebGL2Support = { available: true, accelerated: false, renderer: null };
const NONE: WebGL2Support = { available: false, accelerated: false, renderer: null };

const RENDERER = 0x1f01;
const UNMASKED_RENDERER_WEBGL = 0x9246;

interface Behaviour {
  /** 带 failIfMajorPerformanceCaveat 时是否给上下文。 */
  accelerated: boolean;
  /** 不带时是否给上下文。 */
  software: boolean;
  throws?: boolean;
  /** 设备名；debugInfo 为 false 时只能读到被遮盖的 RENDERER。 */
  renderer?: unknown;
  debugInfo?: boolean;
  parameterThrows?: boolean;
}

/** 按 failIfMajorPerformanceCaveat 决定是否给上下文的假画布。 */
function canvasFactory(behaviour: Behaviour) {
  const loseContext = vi.fn();
  const requests: (WebGLContextAttributes | undefined)[] = [];
  const gl = {
    RENDERER,
    getExtension(name: string) {
      if (name === "WEBGL_lose_context") return { loseContext };
      if (name === "WEBGL_debug_renderer_info" && behaviour.debugInfo !== false) return { UNMASKED_RENDERER_WEBGL };
      return null;
    },
    getParameter(parameter: number) {
      if (behaviour.parameterThrows) throw new Error("lost");
      if (parameter === UNMASKED_RENDERER_WEBGL) return behaviour.renderer ?? "Mesa Intel(R) Graphics (ADL GT2)";
      return parameter === RENDERER ? "WebKit WebGL" : null;
    },
  };
  const create = () =>
    ({
      getContext(type: string, attributes?: WebGLContextAttributes) {
        expect(type).toBe("webgl2");
        requests.push(attributes);
        if (behaviour.throws) throw new Error("blocked");
        const ok = attributes?.failIfMajorPerformanceCaveat ? behaviour.accelerated : behaviour.software;
        return ok ? gl : null;
      },
    }) as unknown as HTMLCanvasElement;
  return { create, loseContext, requests };
}

describe("chooseRenderer", () => {
  it.each<[RendererPreference, WebGL2Support, boolean, string, string]>([
    ["auto", ACCELERATED, false, "webgl2", "auto"],
    ["auto", SOFTWARE, false, "canvas2d", "software"],
    ["auto", NONE, false, "canvas2d", "unsupported"],
    ["auto", ACCELERATED, true, "canvas2d", "context_lost"],
    ["webgl2", SOFTWARE, false, "webgl2", "forced"],
    ["webgl2", NONE, false, "canvas2d", "unsupported"],
    ["webgl2", ACCELERATED, true, "canvas2d", "context_lost"],
    ["canvas2d", ACCELERATED, false, "canvas2d", "forced"],
    ["canvas2d", ACCELERATED, true, "canvas2d", "forced"],
  ])("%s + %o (lost=%s) → %s/%s", (preference, support, lost, kind, reason) => {
    expect(chooseRenderer(preference, support, lost)).toEqual({ kind, reason });
  });
});

describe("probeWebGL2", () => {
  it("硬件加速：一次探测就够，读出设备名并释放上下文", () => {
    const canvas = canvasFactory({ accelerated: true, software: true });
    expect(probeWebGL2(canvas.create)).toEqual({ ...ACCELERATED, renderer: "Mesa Intel(R) Graphics (ADL GT2)" });
    expect(canvas.requests).toEqual([{ failIfMajorPerformanceCaveat: true }]);
    expect(canvas.loseContext).toHaveBeenCalledOnce();
  });

  it("只有带性能警告的实现", () => {
    const canvas = canvasFactory({ accelerated: false, software: true });
    expect(probeWebGL2(canvas.create)).toEqual({ ...SOFTWARE, renderer: "Mesa Intel(R) Graphics (ADL GT2)" });
    expect(canvas.requests).toEqual([{ failIfMajorPerformanceCaveat: true }, undefined]);
  });

  it("没报性能警告但设备名是软件实现（SwiftShader、llvmpipe）", () => {
    const swiftshader = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)";
    expect(probeWebGL2(canvasFactory({ accelerated: true, software: true, renderer: swiftshader }).create)).toEqual({
      ...SOFTWARE,
      renderer: swiftshader,
    });
    const llvmpipe = canvasFactory({ accelerated: true, software: true, renderer: "llvmpipe (LLVM 19.1.7, 256 bits)" });
    expect(probeWebGL2(llvmpipe.create).accelerated).toBe(false);
  });

  it("没有调试扩展时读被遮盖的 RENDERER；读不到设备名时不当软件实现", () => {
    expect(probeWebGL2(canvasFactory({ accelerated: true, software: true, debugInfo: false }).create)).toEqual({
      ...ACCELERATED,
      renderer: "WebKit WebGL",
    });
    expect(probeWebGL2(canvasFactory({ accelerated: true, software: true, renderer: "" }).create)).toEqual(ACCELERATED);
    expect(probeWebGL2(canvasFactory({ accelerated: true, software: true, parameterThrows: true }).create)).toEqual(
      ACCELERATED,
    );
  });

  it("认识常见的软件实现", () => {
    expect(isSoftwareRenderer("Microsoft Basic Render Driver")).toBe(true);
    expect(isSoftwareRenderer("softpipe")).toBe(true);
    expect(isSoftwareRenderer("AMD Radeon RX 7800 XT (radeonsi, navi32, LLVM 19.1.7, DRM 3.61)")).toBe(false);
    expect(isSoftwareRenderer(null)).toBe(false);
  });

  it("没有 WebGL2，或者 getContext 抛错", () => {
    expect(probeWebGL2(canvasFactory({ accelerated: false, software: false }).create)).toEqual(NONE);
    expect(probeWebGL2(canvasFactory({ accelerated: true, software: true, throws: true }).create)).toEqual(NONE);
  });
});

describe("preference", () => {
  it("只认识三种取值，其余当 auto", () => {
    expect(parsePreference("webgl2")).toBe("webgl2");
    expect(parsePreference("canvas2d")).toBe("canvas2d");
    expect(parsePreference("auto")).toBe("auto");
    expect(parsePreference("webgpu")).toBe("auto");
    expect(parsePreference(null)).toBe("auto");
  });

  it("读写本机存储", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
    expect(readPreference(storage)).toBe("auto");
    writePreference("canvas2d", storage);
    expect(values.get(RENDERER_STORAGE_KEY)).toBe("canvas2d");
    expect(readPreference(storage)).toBe("canvas2d");
  });

  it("存储不可用时不抛错", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readPreference(broken)).toBe("auto");
    expect(() => writePreference("webgl2", broken)).not.toThrow();
    expect(readPreference(null)).toBe("auto");
    expect(() => writePreference("webgl2", null)).not.toThrow();
  });

  it("默认用全局 localStorage；没有或访问抛错时退回 auto", () => {
    const values = new Map<string, string>([[RENDERER_STORAGE_KEY, "webgl2"]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) });
    expect(readPreference()).toBe("webgl2");
    writePreference("canvas2d");
    expect(values.get(RENDERER_STORAGE_KEY)).toBe("canvas2d");
    vi.stubGlobal("localStorage", undefined);
    expect(readPreference()).toBe("auto");
    vi.unstubAllGlobals();

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(readPreference()).toBe("auto");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
