import { describe, expect, it, vi } from "vitest";

import { RuntimeContractError } from "../runtime/sanitize";
import { createPlatformAdapter, PlatformCapabilityError } from "./adapter";

function bridge(isDesktop: boolean, responses: Record<string, unknown>) {
  return {
    isTauri: () => isDesktop,
    invoke: vi.fn(async (command: string) => {
      const value = responses[command];
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

describe("platform adapter", () => {
  it("uses the current same-origin backend in browser mode", async () => {
    const testBridge = bridge(false, {});
    const adapter = createPlatformAdapter({
      bridge: testBridge,
      location: { origin: "http://localhost:8787" },
    });

    expect(adapter.mode).toBe("browser");
    await expect(adapter.getRuntimeMetadata()).resolves.toEqual({
      apiOrigin: "http://localhost:8787",
      backendVersion: null,
    });
    await expect(adapter.getBackendStatus()).resolves.toMatchObject({ state: "ready" });
    expect(testBridge.invoke).not.toHaveBeenCalled();
  });

  it("reads and sanitizes only runtime metadata and lifecycle status from Tauri", async () => {
    const testBridge = bridge(true, {
      runtime_metadata: {
        apiOrigin: "http://127.0.0.1:9123",
        backendVersion: "0.5.2",
        configPath: "/private/config.json",
      },
      backend_status: {
        state: "failed",
        code: "backend_start_failed",
        message: "/private/config.json",
      },
    });
    const adapter = createPlatformAdapter({ bridge: testBridge });

    expect(adapter.mode).toBe("tauri");
    await expect(adapter.getRuntimeMetadata()).resolves.toEqual({
      apiOrigin: "http://127.0.0.1:9123",
      backendVersion: "0.5.2",
    });
    await expect(adapter.getBackendStatus()).resolves.toEqual({
      state: "failed",
      code: "backend_start_failed",
      message: "后端进程无法启动",
    });
  });

  it("turns host invocation failures into stable public failures", async () => {
    const adapter = createPlatformAdapter({
      bridge: bridge(true, {
        runtime_metadata: new Error("C:\\private\\config.json"),
        backend_status: new Error("private process error"),
      }),
    });

    await expect(adapter.getRuntimeMetadata()).rejects.toEqual(
      new RuntimeContractError("runtime_metadata_unavailable"),
    );
    await expect(adapter.getBackendStatus()).resolves.toEqual({
      state: "failed",
      code: "platform_unavailable",
      message: "桌面宿主暂时不可用",
    });
  });

  it("leaves scheduling to the shared polling service and requires a browser origin", async () => {
    const adapter = createPlatformAdapter({
      bridge: bridge(false, {}),
      location: { origin: "http://127.0.0.1:8787" },
    });
    expect(Object.keys(adapter)).toEqual([
      "mode",
      "capabilities",
      "getRuntimeMetadata",
      "getBackendStatus",
      "selectDirectory",
      "selectBrowserExecutable",
      "revealInFileManager",
    ]);
    await expect(adapter.getBackendStatus()).resolves.toMatchObject({ state: "ready" });

    const missing = createPlatformAdapter({ bridge: bridge(false, {}), location: undefined });
    await expect(missing.getRuntimeMetadata()).rejects.toThrow("runtime_metadata_unavailable");
  });

  it("keeps directory selection and reveal desktop-only with explicit capability reporting", async () => {
    const adapter = createPlatformAdapter({
      bridge: bridge(false, {}),
      location: { origin: "http://127.0.0.1:8787" },
    });

    expect(adapter.capabilities).toEqual({ selectDirectory: false, selectBrowserExecutable: false, revealInFileManager: false });
    await expect(adapter.selectDirectory("gallery_import")).rejects.toEqual(
      new PlatformCapabilityError("capability_unavailable"),
    );
    await expect(adapter.selectBrowserExecutable()).rejects.toEqual(
      new PlatformCapabilityError("capability_unavailable"),
    );
    await expect(adapter.revealInFileManager("/tmp/x")).rejects.toEqual(
      new PlatformCapabilityError("capability_unavailable"),
    );
  });

  it("returns a sanitized picked directory path or null when the user cancels", async () => {
    const cancelled = createPlatformAdapter({ bridge: bridge(true, { select_directory: null }) });
    await expect(cancelled.selectDirectory("export_target")).resolves.toBeNull();

    const picked = createPlatformAdapter({
      bridge: bridge(true, { select_directory: "/home/user/图库" }),
    });
    expect(picked.capabilities).toEqual({ selectDirectory: true, selectBrowserExecutable: true, revealInFileManager: true });
    await expect(picked.selectDirectory("gallery_import")).resolves.toBe("/home/user/图库");

    for (const bad of ["", "  ", "/tmp/a\u0000b", 42, {}]) {
      const failing = createPlatformAdapter({ bridge: bridge(true, { select_directory: bad }) });
      await expect(failing.selectDirectory("gallery_import")).rejects.toEqual(
        new PlatformCapabilityError("capability_unavailable"),
      );
    }

    const failed = createPlatformAdapter({
      bridge: bridge(true, { select_directory: new Error("dialog crashed") }),
    });
    await expect(failed.selectDirectory("gallery_import")).rejects.toEqual(
      new PlatformCapabilityError("capability_unavailable"),
    );
  });

  it("returns a validated browser executable selection", async () => {
    const testBridge = bridge(true, { select_browser_executable: "/usr/bin/chromium" });
    const adapter = createPlatformAdapter({ bridge: testBridge });
    await expect(adapter.selectBrowserExecutable()).resolves.toBe("/usr/bin/chromium");
    expect(testBridge.invoke).toHaveBeenCalledWith("select_browser_executable");

    const cancelled = createPlatformAdapter({ bridge: bridge(true, { select_browser_executable: null }) });
    await expect(cancelled.selectBrowserExecutable()).resolves.toBeNull();
    const invalid = createPlatformAdapter({ bridge: bridge(true, { select_browser_executable: "bad\u0000path" }) });
    await expect(invalid.selectBrowserExecutable()).rejects.toEqual(
      new PlatformCapabilityError("capability_unavailable"),
    );
    const failed = createPlatformAdapter({
      bridge: bridge(true, { select_browser_executable: new Error("dialog crashed") }),
    });
    await expect(failed.selectBrowserExecutable()).rejects.toEqual(
      new PlatformCapabilityError("capability_unavailable"),
    );
  });

  it("reveals a validated path through the host without arbitrary read access", async () => {
    const testBridge = bridge(true, { reveal_in_file_manager: null });
    const adapter = createPlatformAdapter({ bridge: testBridge });

    await expect(adapter.revealInFileManager("/exports/manifest.jsonl")).resolves.toBeUndefined();
    expect(testBridge.invoke).toHaveBeenCalledWith("reveal_in_file_manager", {
      path: "/exports/manifest.jsonl",
    });

    for (const bad of ["", "  ", "/tmp/a\u0000b"]) {
      await expect(adapter.revealInFileManager(bad)).rejects.toEqual(
        new PlatformCapabilityError("capability_unavailable"),
      );
    }
    expect(testBridge.invoke).toHaveBeenCalledTimes(1);

    const failing = createPlatformAdapter({
      bridge: bridge(true, { reveal_in_file_manager: new Error("opener failed") }),
    });
    await expect(failing.revealInFileManager("/tmp/x")).rejects.toEqual(
      new PlatformCapabilityError("capability_unavailable"),
    );
  });
});
