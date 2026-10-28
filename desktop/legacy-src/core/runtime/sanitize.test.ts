import { describe, expect, it } from "vitest";

import {
  RuntimeContractError,
  isPlainRecord,
  sanitizeBackendStatus,
  sanitizeErrorDetails,
  sanitizeHealthSnapshot,
  sanitizeRuntimeMetadata,
} from "./sanitize";

describe("runtime sanitizer", () => {
  it("accepts only HTTP loopback API origins and bounded backend versions", () => {
    expect(sanitizeRuntimeMetadata({
      apiOrigin: "http://127.0.0.1:8787/",
      backendVersion: "0.5.2",
      secret: "discarded",
    })).toEqual({ apiOrigin: "http://127.0.0.1:8787", backendVersion: "0.5.2" });
    expect(sanitizeRuntimeMetadata({ apiOrigin: "http://localhost:8787", backendVersion: null })).toEqual({
      apiOrigin: "http://localhost:8787",
      backendVersion: null,
    });
    expect(sanitizeRuntimeMetadata({ apiOrigin: "http://[::1]:8787" }).backendVersion).toBeNull();

    for (const apiOrigin of [
      "https://127.0.0.1:8787",
      "http://example.com:8787",
      "http://user:password@127.0.0.1:8787",
      "http://127.0.0.1:8787/api",
      "not-an-origin",
      42,
    ]) {
      expect(() => sanitizeRuntimeMetadata({ apiOrigin })).toThrowError(RuntimeContractError);
    }
    expect(() => sanitizeRuntimeMetadata({ apiOrigin: "http://127.0.0.1:8787", backendVersion: "bad version" }))
      .toThrowError("invalid_backend_version");
    expect(() => sanitizeRuntimeMetadata(null)).toThrowError("invalid_runtime_metadata");
  });

  it("rejects accessors and non-plain runtime objects", () => {
    const accessor = Object.defineProperty({}, "apiOrigin", { get: () => "http://127.0.0.1:8787" });
    expect(() => sanitizeRuntimeMetadata(accessor)).toThrowError("invalid_apiOrigin");
    const versionAccessor = Object.defineProperties({}, {
      apiOrigin: { enumerable: true, value: "http://127.0.0.1:8787" },
      backendVersion: { enumerable: true, get: () => "0.5.2" },
    });
    expect(() => sanitizeRuntimeMetadata(versionAccessor)).toThrowError("invalid_backendVersion");
    expect(isPlainRecord(Object.create(null))).toBe(true);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(new Date())).toBe(false);
  });

  it("projects lifecycle status onto stable public messages", () => {
    expect(sanitizeBackendStatus({ state: "starting", privatePath: "/secret" })).toEqual({
      state: "starting",
      code: null,
      message: "正在启动本地服务",
    });
    expect(sanitizeBackendStatus({ state: "ready" }).message).toBe("本地服务已就绪");
    expect(sanitizeBackendStatus({ state: "stopped" }).message).toBe("后端服务已停止");
    expect(sanitizeBackendStatus({
      state: "failed",
      code: "backend_exited",
      message: "do not expose C:\\private\\config.json",
    })).toEqual({ state: "failed", code: "backend_exited", message: "后端进程意外退出" });
    expect(sanitizeBackendStatus({ state: "failed", code: "unknown", message: "/private" }).message)
      .toBe("桌面宿主发生错误");
    expect(() => sanitizeBackendStatus({ state: "unknown" })).toThrowError("invalid_backend_state");
    expect(() => sanitizeBackendStatus([])).toThrowError("invalid_backend_status");
  });

  it("whitelists the health payload used by the bootstrap gate", () => {
    expect(sanitizeHealthSnapshot({
      ok: true,
      components: {
        process: { status: "ok", detail: "discarded" },
        database: { status: "ok", path: "/private/db" },
      },
      time: 123.5,
      token: "discarded",
    })).toEqual({
      ok: true,
      components: { process: { status: "ok" }, database: { status: "ok" } },
      time: 123.5,
    });
    expect(() => sanitizeHealthSnapshot(null)).toThrowError("invalid_health");
    expect(() => sanitizeHealthSnapshot({ ok: true, components: {}, time: 1 })).toThrowError();
    expect(() => sanitizeHealthSnapshot({
      ok: true,
      components: { process: [], database: { status: "ok" } },
      time: 1,
    })).toThrowError("invalid_health_process");
    expect(() => sanitizeHealthSnapshot({
      ok: true,
      components: { process: { status: "starting" }, database: { status: "ok" } },
      time: 1,
    })).toThrowError("invalid_health_process");
    expect(() => sanitizeHealthSnapshot({
      ok: true,
      components: { process: { status: "ok" }, database: { status: "ok" } },
      time: Number.NaN,
    })).toThrowError("invalid_health");
  });

  it("bounds error details and removes sensitive, dangerous, accessor, and non-JSON values", () => {
    const details = Object.create(null) as Record<string, unknown>;
    details.field = "x".repeat(600);
    details.reason = "invalid";
    details.secret_token = "never";
    details.path = "/private";
    Object.defineProperty(details, "constructor", { enumerable: true, value: { polluted: true } });
    details.items = Array.from({ length: 25 }, (_, index) => index);
    details.nan = Number.NaN;
    details.date = new Date();
    details.deep = { one: { two: { three: { four: "hidden" } } } };
    Object.defineProperty(details, "computed", { enumerable: true, get: () => "never" });

    const sanitized = sanitizeErrorDetails(details) as Record<string, unknown>;
    expect((sanitized.field as string).length).toBe(500);
    expect(sanitized.reason).toBe("invalid");
    expect(sanitized.items).toHaveLength(20);
    expect(sanitized.nan).toBeNull();
    expect(sanitized.date).toBeNull();
    expect(sanitized.deep).toEqual({ one: { two: { three: null } } });
    expect(sanitized).not.toHaveProperty("secret_token");
    expect(sanitized).not.toHaveProperty("path");
    expect(sanitized).not.toHaveProperty("constructor");
    expect(sanitized).not.toHaveProperty("computed");
    expect(sanitizeErrorDetails(undefined)).toBeNull();
    expect(sanitizeErrorDetails(true)).toBe(true);
  });
});
