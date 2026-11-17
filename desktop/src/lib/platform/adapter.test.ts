import { describe, expect, it, vi } from "vitest";

import { createPlatformAdapter, PlatformCapabilityError } from "./adapter.ts";
import { RuntimeContractError } from "./sanitize.ts";

function bridge(isDesktop: boolean, responses: Record<string, unknown> = {}) {
  const response = async (method: string) => {
    const value = responses[method];
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    isMyGo: () => isDesktop,
    host: {
      runtimeMetadata: vi.fn(() => response("runtimeMetadata")),
      backendStatus: vi.fn(() => response("backendStatus")),
      selectDirectory: vi.fn(() => response("selectDirectory")),
      selectBrowserExecutable: vi.fn(() => response("selectBrowserExecutable")),
      revealInFileManager: vi.fn((_path: string) => response("revealInFileManager")),
    },
  };
}

const unavailable = new PlatformCapabilityError("capability_unavailable");

describe("platform adapter", () => {
  it("浏览器模式使用同源后端，不调用宿主", async () => {
    const testBridge = bridge(false);
    const adapter = createPlatformAdapter({ bridge: testBridge, location: { origin: "http://localhost:8787" } });

    expect(adapter.mode).toBe("browser");
    expect(adapter.capabilities).toEqual({
      selectDirectory: false,
      selectBrowserExecutable: false,
      revealInFileManager: false,
    });
    await expect(adapter.getRuntimeMetadata()).resolves.toEqual({
      apiOrigin: "http://localhost:8787",
      backendVersion: null,
    });
    await expect(adapter.getBackendStatus()).resolves.toEqual({ state: "ready", code: null });
    await expect(adapter.selectDirectory("gallery_import")).rejects.toEqual(unavailable);
    await expect(adapter.selectBrowserExecutable()).rejects.toEqual(unavailable);
    await expect(adapter.revealInFileManager("/tmp/x")).rejects.toEqual(unavailable);
    for (const method of Object.values(testBridge.host)) expect(method).not.toHaveBeenCalled();

    const missing = createPlatformAdapter({ bridge: bridge(false), location: undefined });
    await expect(missing.getRuntimeMetadata()).rejects.toThrow("runtime_metadata_unavailable");
  });

  it("桌面模式读取并消毒运行时元数据和后端状态", async () => {
    const adapter = createPlatformAdapter({
      bridge: bridge(true, {
        runtimeMetadata: { apiOrigin: "http://127.0.0.1:9123", backendVersion: "0.5.2", configPath: "/private" },
        backendStatus: { state: "failed", code: "backend_start_failed", message: "/private/config.json" },
      }),
    });
    expect(adapter.mode).toBe("mygo");
    expect(adapter.capabilities.selectDirectory).toBe(true);
    await expect(adapter.getRuntimeMetadata()).resolves.toEqual({
      apiOrigin: "http://127.0.0.1:9123",
      backendVersion: "0.5.2",
    });
    await expect(adapter.getBackendStatus()).resolves.toEqual({ state: "failed", code: "backend_start_failed" });
  });

  it("宿主调用失败时给稳定的公开错误", async () => {
    const adapter = createPlatformAdapter({
      bridge: bridge(true, {
        runtimeMetadata: new Error("C:\\private\\config.json"),
        backendStatus: new Error("private process error"),
      }),
    });
    await expect(adapter.getRuntimeMetadata()).rejects.toEqual(new RuntimeContractError("runtime_metadata_unavailable"));
    await expect(adapter.getBackendStatus()).resolves.toEqual({ state: "failed", code: "platform_unavailable" });
  });

  it("目录和可执行文件选择返回消毒后的路径，取消返回 null", async () => {
    const testBridge = bridge(true, { selectDirectory: "/home/user/图库", selectBrowserExecutable: "/usr/bin/chromium" });
    const adapter = createPlatformAdapter({ bridge: testBridge });
    await expect(adapter.selectDirectory("gallery_import")).resolves.toBe("/home/user/图库");
    await expect(adapter.selectBrowserExecutable()).resolves.toBe("/usr/bin/chromium");
    expect(testBridge.host.selectDirectory).toHaveBeenCalledWith();
    expect(testBridge.host.selectBrowserExecutable).toHaveBeenCalledWith();

    const cancelled = createPlatformAdapter({ bridge: bridge(true, { selectDirectory: null }) });
    await expect(cancelled.selectDirectory("export_target")).resolves.toBeNull();
    await expect(cancelled.selectBrowserExecutable()).resolves.toBeNull();

    for (const bad of ["", "  ", "/tmp/a\u0000b", 42, {}, new Error("dialog crashed")]) {
      const failing = createPlatformAdapter({ bridge: bridge(true, { selectDirectory: bad, selectBrowserExecutable: bad }) });
      await expect(failing.selectDirectory("gallery_import")).rejects.toEqual(unavailable);
      await expect(failing.selectBrowserExecutable()).rejects.toEqual(unavailable);
    }
  });

  it("在文件管理器里定位前校验路径", async () => {
    const testBridge = bridge(true, { revealInFileManager: null });
    const adapter = createPlatformAdapter({ bridge: testBridge });
    await expect(adapter.revealInFileManager("/exports/manifest.jsonl")).resolves.toBeUndefined();
    expect(testBridge.host.revealInFileManager).toHaveBeenCalledWith("/exports/manifest.jsonl");
    for (const bad of ["", "  ", "/tmp/a\u0000b"]) {
      await expect(adapter.revealInFileManager(bad)).rejects.toEqual(unavailable);
    }
    expect(testBridge.host.revealInFileManager).toHaveBeenCalledTimes(1);

    const failing = createPlatformAdapter({ bridge: bridge(true, { revealInFileManager: new Error("opener failed") }) });
    await expect(failing.revealInFileManager("/tmp/x")).rejects.toEqual(unavailable);
  });

  it("默认桥接通过真实生成的 Host 绑定与 mygo-runtime 调用五个宿主方法", async () => {
    const call = vi.fn(async (method: string, ..._args: unknown[]) => {
      if (method === "Host.RuntimeMetadata") return { apiOrigin: "http://127.0.0.1:9123", backendVersion: null, configPath: "/private" };
      if (method === "Host.BackendStatus") return { state: "ready", code: null };
      if (method === "Host.SelectDirectory") return "/home/user/图库";
      if (method === "Host.SelectBrowserExecutable") return null;
      if (method === "Host.RevealInFileManager") return undefined;
      throw new Error(`unexpected method ${method}`);
    });
    vi.stubGlobal("mygo", { call });
    try {
      const adapter = createPlatformAdapter();
      expect(adapter.mode).toBe("mygo");
      await expect(adapter.getRuntimeMetadata()).resolves.toEqual({ apiOrigin: "http://127.0.0.1:9123", backendVersion: null });
      await expect(adapter.getBackendStatus()).resolves.toEqual({ state: "ready", code: null });
      await expect(adapter.selectDirectory("gallery_import")).resolves.toBe("/home/user/图库");
      await expect(adapter.selectBrowserExecutable()).resolves.toBeNull();
      await expect(adapter.revealInFileManager("/exports/manifest.jsonl")).resolves.toBeUndefined();
      expect(call.mock.calls).toEqual([
        ["Host.RuntimeMetadata"],
        ["Host.BackendStatus"],
        ["Host.SelectDirectory"],
        ["Host.SelectBrowserExecutable"],
        ["Host.RevealInFileManager", "/exports/manifest.jsonl"],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("默认使用 MyGo 桥；node 里没有宿主时是浏览器模式", () => {
    expect(createPlatformAdapter({ location: { origin: "http://127.0.0.1:1" } }).mode).toBe("browser");
  });
});
