import { describe, expect, it, vi } from "vitest";

import { RuntimeContractError } from "../runtime/sanitize";
import { createPlatformAdapter } from "./adapter";

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

  it("watches desktop status without overlapping calls and stops its timer", async () => {
    let release: (() => void) | undefined;
    const invoke = vi.fn(() => new Promise<unknown>((resolve) => { release = () => resolve({ state: "ready" }); }));
    const intervalCallbacks: Array<() => void> = [];
    const clearIntervalFn = vi.fn();
    const adapter = createPlatformAdapter({
      bridge: { isTauri: () => true, invoke },
      pollIntervalMs: 1,
      setIntervalFn: (callback) => {
        intervalCallbacks.push(callback);
        return 7 as unknown as ReturnType<typeof globalThis.setInterval>;
      },
      clearIntervalFn,
    });
    const listener = vi.fn();
    const stop = adapter.watchBackendStatus(listener);

    expect(invoke).toHaveBeenCalledOnce();
    intervalCallbacks[0]();
    expect(invoke).toHaveBeenCalledOnce();
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ state: "ready" }));

    stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(7);
    intervalCallbacks[0]();
    expect(invoke).toHaveBeenCalledOnce();

    const stoppedListener = vi.fn();
    const stopBeforeRelease = adapter.watchBackendStatus(stoppedListener);
    expect(invoke).toHaveBeenCalledTimes(2);
    stopBeforeRelease();
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(stoppedListener).not.toHaveBeenCalled();
  });

  it("watches browser readiness once and requires a location origin", async () => {
    const listener = vi.fn();
    const adapter = createPlatformAdapter({
      bridge: bridge(false, {}),
      location: { origin: "http://127.0.0.1:8787" },
    });
    const stop = adapter.watchBackendStatus(listener);
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
    stop();

    const missing = createPlatformAdapter({ bridge: bridge(false, {}), location: undefined });
    await expect(missing.getRuntimeMetadata()).rejects.toThrow("runtime_metadata_unavailable");
  });
});
