import { describe, expect, it, vi } from "vitest";

import { createPlatformAdapter, PlatformCapabilityError } from "./adapter.ts";
import { RuntimeContractError } from "./sanitize.ts";

function bridge(isDesktop: boolean, responses: Record<string, unknown> = {}) {
  return {
    isTauri: () => isDesktop,
    invoke: vi.fn(async (command: string) => {
      const value = responses[command];
      if (value instanceof Error) throw value;
      return value;
    }),
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
    expect(testBridge.invoke).not.toHaveBeenCalled();

    const missing = createPlatformAdapter({ bridge: bridge(false), location: undefined });
    await expect(missing.getRuntimeMetadata()).rejects.toThrow("runtime_metadata_unavailable");
  });

  it("桌面模式读取并消毒运行时元数据和后端状态", async () => {
    const adapter = createPlatformAdapter({
      bridge: bridge(true, {
        runtime_metadata: { apiOrigin: "http://127.0.0.1:9123", backendVersion: "0.5.2", configPath: "/private" },
        backend_status: { state: "failed", code: "backend_start_failed", message: "/private/config.json" },
      }),
    });
    expect(adapter.mode).toBe("tauri");
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
        runtime_metadata: new Error("C:\\private\\config.json"),
        backend_status: new Error("private process error"),
      }),
    });
    await expect(adapter.getRuntimeMetadata()).rejects.toEqual(new RuntimeContractError("runtime_metadata_unavailable"));
    await expect(adapter.getBackendStatus()).resolves.toEqual({ state: "failed", code: "platform_unavailable" });
  });

  it("目录和可执行文件选择返回消毒后的路径，取消返回 null", async () => {
    const testBridge = bridge(true, { select_directory: "/home/user/图库", select_browser_executable: "/usr/bin/chromium" });
    const adapter = createPlatformAdapter({ bridge: testBridge });
    await expect(adapter.selectDirectory("gallery_import")).resolves.toBe("/home/user/图库");
    await expect(adapter.selectBrowserExecutable()).resolves.toBe("/usr/bin/chromium");
    expect(testBridge.invoke).toHaveBeenCalledWith("select_directory");
    expect(testBridge.invoke).toHaveBeenCalledWith("select_browser_executable");

    const cancelled = createPlatformAdapter({ bridge: bridge(true, { select_directory: null }) });
    await expect(cancelled.selectDirectory("export_target")).resolves.toBeNull();
    await expect(cancelled.selectBrowserExecutable()).resolves.toBeNull();

    for (const bad of ["", "  ", "/tmp/a\u0000b", 42, {}, new Error("dialog crashed")]) {
      const failing = createPlatformAdapter({ bridge: bridge(true, { select_directory: bad }) });
      await expect(failing.selectDirectory("gallery_import")).rejects.toEqual(unavailable);
    }
  });

  it("在文件管理器里定位前校验路径", async () => {
    const testBridge = bridge(true, { reveal_in_file_manager: null });
    const adapter = createPlatformAdapter({ bridge: testBridge });
    await expect(adapter.revealInFileManager("/exports/manifest.jsonl")).resolves.toBeUndefined();
    expect(testBridge.invoke).toHaveBeenCalledWith("reveal_in_file_manager", { path: "/exports/manifest.jsonl" });
    for (const bad of ["", "  ", "/tmp/a\u0000b"]) {
      await expect(adapter.revealInFileManager(bad)).rejects.toEqual(unavailable);
    }
    expect(testBridge.invoke).toHaveBeenCalledTimes(1);

    const failing = createPlatformAdapter({ bridge: bridge(true, { reveal_in_file_manager: new Error("opener failed") }) });
    await expect(failing.revealInFileManager("/tmp/x")).rejects.toEqual(unavailable);
  });

  it("默认使用 Tauri 桥；node 里没有宿主时是浏览器模式", () => {
    expect(createPlatformAdapter({ location: { origin: "http://127.0.0.1:1" } }).mode).toBe("browser");
  });
});
