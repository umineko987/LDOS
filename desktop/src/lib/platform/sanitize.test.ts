import { describe, expect, it } from "vitest";

import { hostPath, loopbackOrigin, sanitizeBackendStatus, sanitizeRuntimeMetadata } from "./sanitize.ts";

describe("runtime sanitizers", () => {
  it("只接受本机回环 http origin", () => {
    expect(loopbackOrigin("http://127.0.0.1:9123")).toBe("http://127.0.0.1:9123");
    expect(loopbackOrigin("http://LOCALHOST:8787/")).toBe("http://localhost:8787");
    expect(loopbackOrigin("http://[::1]:8787")).toBe("http://[::1]:8787");
    for (const bad of [
      "https://127.0.0.1:8787",
      "http://192.168.1.2:8787",
      "http://user:pw@127.0.0.1:8787",
      "http://127.0.0.1:8787/api",
      "http://127.0.0.1:8787/?x=1",
      "http://127.0.0.1:8787/#x",
      "not a url",
      `http://127.0.0.1/${"x".repeat(300)}`,
      42,
    ]) {
      expect(() => loopbackOrigin(bad)).toThrow("invalid_api_origin");
    }
  });

  it("运行时元数据只保留 origin 和版本号", () => {
    expect(
      sanitizeRuntimeMetadata({ apiOrigin: "http://127.0.0.1:9123", backendVersion: "0.5.2", configPath: "/private" }),
    ).toEqual({ apiOrigin: "http://127.0.0.1:9123", backendVersion: "0.5.2" });
    expect(sanitizeRuntimeMetadata({ apiOrigin: "http://127.0.0.1:9123" }).backendVersion).toBeNull();
    expect(() => sanitizeRuntimeMetadata({ apiOrigin: "http://127.0.0.1:1", backendVersion: "bad version" })).toThrow(
      "invalid_backend_version",
    );
    expect(() => sanitizeRuntimeMetadata({})).toThrow("invalid_apiOrigin");
    expect(() => sanitizeRuntimeMetadata([])).toThrow("invalid_runtime_metadata");
    const accessor = { apiOrigin: "http://127.0.0.1:1" };
    Object.defineProperty(accessor, "backendVersion", { enumerable: true, get: () => "1.0" });
    expect(() => sanitizeRuntimeMetadata(accessor)).toThrow("invalid_backendVersion");
  });

  it("后端状态只保留已知状态和代码，丢掉宿主给的文案", () => {
    expect(sanitizeBackendStatus({ state: "failed", code: "backend_start_failed", message: "/private" })).toEqual({
      state: "failed",
      code: "backend_start_failed",
    });
    expect(sanitizeBackendStatus({ state: "starting", code: "toString" })).toEqual({ state: "starting", code: null });
    expect(() => sanitizeBackendStatus({ state: "booting" })).toThrow("invalid_backend_state");
    expect(() => sanitizeBackendStatus(null)).toThrow("invalid_backend_status");
  });

  it("宿主路径非空且不含控制字符", () => {
    expect(hostPath("/home/user/图库")).toBe("/home/user/图库");
    for (const bad of ["", "  ", "/tmp/a\u0000b", 42, {}]) expect(hostPath(bad)).toBeNull();
  });
});
