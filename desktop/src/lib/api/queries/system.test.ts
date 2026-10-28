import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import {
  diagnosticsConfigQuery,
  healthQuery,
  readinessQuery,
  sanitizeDiagnosticsConfig,
  sanitizeHealth,
  sanitizeReadiness,
  systemKeys,
} from "./system.ts";

function apiReturning(status: number, payload: unknown) {
  const requests: Request[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      requests.push(request);
      return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  return { api, requests };
}

function fetchWith<T>(options: { queryKey: readonly unknown[]; queryFn?: unknown }): Promise<T> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return client.fetchQuery(options as never) as Promise<T>;
}

const READY = {
  ready: true,
  time: 1_700_000_000,
  components: {
    database: { status: "ok", required: true, summary: "数据库\n可用" },
    proxy: { status: "optional_missing", required: false, summary: "未配置" },
    dedup: { status: "disabled", required: false },
    crawler: { status: 1 },
    "Bad-Id": { status: "ok" },
    broken: "not a record",
  },
};

describe("system sanitizers", () => {
  it("sanitizeHealth 只保留 ok、数据库状态和时间", () => {
    expect(sanitizeHealth({ ok: true, components: { database: { status: "ok" } }, time: 1 })).toEqual({
      ok: true,
      database: "ok",
      time: 1,
    });
    expect(sanitizeHealth({ ok: false, time: -1 })).toEqual({ ok: false, database: "error", time: null });
    expect(() => sanitizeHealth({ ok: "yes" })).toThrow("invalid_health");
    expect(() => sanitizeHealth(null)).toThrow("invalid_health");
  });

  it("sanitizeReadiness 规范化组件状态，丢掉不合法的组件", () => {
    const readiness = sanitizeReadiness(READY);
    expect(readiness.ready).toBe(true);
    expect(readiness.time).toBe(1_700_000_000);
    expect(readiness.components).toEqual([
      { id: "database", status: "ok", required: true, summary: "数据库 可用" },
      { id: "proxy", status: "warning", required: false, summary: "未配置" },
      { id: "dedup", status: "disabled", required: false, summary: "" },
      { id: "crawler", status: "error", required: true, summary: "" },
    ]);
    expect(Object.isFrozen(readiness.components)).toBe(true);
    expect(sanitizeReadiness({ ready: false }).components).toEqual([]);
    expect(() => sanitizeReadiness({ components: {} })).toThrow("invalid_readiness");
  });

  it("sanitizeDiagnosticsConfig 要求 diagnostics 视图并只取布尔开关", () => {
    expect(
      sanitizeDiagnosticsConfig({
        response_profile: "diagnostics",
        server: { loopback_only: true, cors_enabled: false, private_targets_enabled: "yes" },
        proxy: { enabled: true, auto_start: true, transport_core_enabled: false },
        scheduler: { max_concurrent_tasks: 4 },
        dedup: { enabled: true, configured_device: "cuda", sscd_enabled: true, dino_enabled: false },
      }),
    ).toEqual({
      loopbackOnly: true,
      corsEnabled: false,
      privateTargetsEnabled: false,
      proxyEnabled: true,
      proxyAutoStart: true,
      transportCoreEnabled: false,
      schedulerCapacity: 4,
      dedupEnabled: true,
      dedupDevice: "cuda",
      sscdEnabled: true,
      dinoEnabled: false,
    });
    expect(sanitizeDiagnosticsConfig({ response_profile: "diagnostics", dedup: { configured_device: "tpu" } })).toMatchObject(
      { dedupDevice: "unknown", schedulerCapacity: 0, loopbackOnly: false },
    );
    expect(() => sanitizeDiagnosticsConfig({ response_profile: "public" })).toThrow("invalid_diagnostics_config");
  });
});

describe("system queries", () => {
  it("查询键按 system 分组", () => {
    expect(systemKeys.health()).toEqual(["system", "health"]);
    expect(systemKeys.readiness()).toEqual(["system", "readiness"]);
    expect(systemKeys.config()).toEqual(["system", "config", "diagnostics"]);
  });

  it("healthQuery 请求 /healthz", async () => {
    const { api, requests } = apiReturning(200, { ok: true, components: { database: { status: "ok" } } });
    await expect(fetchWith(healthQuery(api))).resolves.toMatchObject({ ok: true, database: "ok" });
    expect(new URL(requests[0]!.url).pathname).toBe("/healthz");
  });

  it("readinessQuery 把 503 的正文当作未就绪数据", async () => {
    const { api } = apiReturning(503, { ...READY, ready: false });
    await expect(fetchWith(readinessQuery(api))).resolves.toMatchObject({ ready: false });
  });

  it("readinessQuery 对其他失败照常报错", async () => {
    const { api } = apiReturning(500, { error: { code: "internal", message: "boom" } });
    await expect(fetchWith(readinessQuery(api))).rejects.toMatchObject({ status: 500, code: "internal" });
    const ok = apiReturning(200, READY);
    await expect(fetchWith(readinessQuery(ok.api))).resolves.toMatchObject({ ready: true });
  });

  it("diagnosticsConfigQuery 带 view=diagnostics 参数", async () => {
    const { api, requests } = apiReturning(200, { response_profile: "diagnostics" });
    await expect(fetchWith(diagnosticsConfigQuery(api))).resolves.toMatchObject({ dedupDevice: "unknown" });
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/config");
    expect(url.searchParams.get("view")).toBe("diagnostics");
  });
});
