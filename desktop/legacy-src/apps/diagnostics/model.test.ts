import { describe, expect, it } from "vitest";
import {
  DIAGNOSTICS_POLL_INTERVAL_MS,
  DIAGNOSTIC_COMPONENTS,
  buildDiagnosticsSnapshot,
  createDiagnosticsRequestGate,
  deriveDiagnosticsWorkspacePresentation,
  diagnosticsCopyText,
  sanitizeDiagnosticsConfig,
  sanitizeDiagnosticsScheduler,
  sanitizeHealthDiagnostics,
  sanitizeReadinessDiagnostics,
} from "./model";

const secret = "diagnostics-cookie-token-password-secret";
function rawHealth(overrides: Record<string, unknown> = {}) { return { ok: true, components: { process: { status: "ok", summary: secret }, database: { status: "ok", path: `/private/${secret}` } }, ...overrides }; }
function rawReadiness(overrides: Record<string, unknown> = {}) { return { ready: false, components: { process: { status: "ok" }, torch: { status: "optional_warning", version: "2.1", configured_device: "cpu", actual_device: "cpu", cuda_available: false }, dedup: { status: "ok", configured_resources: { workers: 2, deep_batch_size: 16, neighbor_block_size: 512, secret } }, ...((overrides.components as Record<string, unknown> | undefined) ?? {}) }, ...overrides }; }
function rawConfig(overrides: Record<string, unknown> = {}) { return { response_profile: "diagnostics", secrets_exposed: false, server: { loopback_only: true, cors_enabled: false, private_targets_enabled: false }, gallery: { managed_auth_cache: true, cookie: secret }, proxy: { enabled: true, auto_start: false, transport_core_enabled: true, token: secret }, scheduler: { max_concurrent_tasks: 20 }, dedup: { enabled: true, configured_device: "cpu", sscd_enabled: true, dino_enabled: false, model_path: `/private/${secret}` }, ...overrides }; }
function rawScheduler(overrides: Record<string, unknown> = {}) { return { response_profile: "diagnostics", secrets_exposed: false, tasks: { running: true, active: 3, max_concurrent: 20, active_site_count: 2, dispatch_loop: { state: "degraded", last_error: secret } }, ordered_crawls: { running: true, active_batches: 1, execution_order: "source_then_address", address_parallelism: "media_tasks", raw: secret }, ...overrides }; }
function complete() { return buildDiagnosticsSnapshot({ health: { connected: true, data: rawHealth(), error: null }, readiness: { connected: true, data: rawReadiness(), error: null }, config: { connected: true, data: rawConfig(), error: null }, scheduler: { connected: true, data: rawScheduler(), error: null }, checkedAt: 1_700_000_000_000 }); }

describe("Diagnostics model", () => {
  it("sanitizes four whitelisted sections, orders components, and never serializes secrets", () => {
    const health = sanitizeHealthDiagnostics(rawHealth());
    const readiness = sanitizeReadinessDiagnostics(rawReadiness());
    const config = sanitizeDiagnosticsConfig(rawConfig());
    const scheduler = sanitizeDiagnosticsScheduler(rawScheduler());
    expect(readiness.components.map(({ id }) => id)).toEqual(["process", "dedup", "torch"]);
    expect(DIAGNOSTIC_COMPONENTS.map(({ id }) => id)).toContain("scheduler");
    expect(JSON.stringify({ health, readiness, config, scheduler })).not.toContain(secret);
    expect(readiness.components.find(({ id }) => id === "dedup")?.detail).toBe("工作线程 2 · 批大小 16 · 分块 512");
    expect(() => sanitizeDiagnosticsConfig({ ...rawConfig(), secrets_exposed: true })).toThrow(TypeError);
    expect(() => sanitizeDiagnosticsScheduler({ ...rawScheduler(), response_profile: "legacy" })).toThrow(TypeError);
  });

  it("merges stale sections and exposes safe presentation/copy states", () => {
    const previous = complete();
    const snapshot = buildDiagnosticsSnapshot({
      health: { connected: true, data: rawHealth({ ok: false }), error: null },
      readiness: { connected: true, data: null, error: { status: 503, code: "request_failed", requestId: "safe" } },
      config: { connected: true, data: rawConfig(), error: null },
      scheduler: { connected: true, data: null, error: { status: 0, code: "network_error", requestId: "safe" } },
      previous,
    });
    expect(snapshot.health?.ok).toBe(false);
    expect(snapshot.readiness).toBe(previous.readiness);
    expect(snapshot.staleSections).toEqual(["readiness", "scheduler"]);
    expect(deriveDiagnosticsWorkspacePresentation({ snapshot }).state).toBe("stale");
    expect(diagnosticsCopyText(snapshot)).not.toContain(secret);
    expect(diagnosticsCopyText(snapshot)).not.toContain("request_failed");
    expect(deriveDiagnosticsWorkspacePresentation().state).toBe("loading");
  });

  it("rejects stale request tickets and preserves the declared interval", () => {
    const gate = createDiagnosticsRequestGate();
    const first = gate.beginCycle();
    const second = gate.beginCycle();
    expect(gate.isCycleCurrent(first)).toBe(false);
    expect(gate.isCycleCurrent(second)).toBe(true);
    gate.advanceLifecycle();
    expect(gate.isCycleCurrent(second)).toBe(false);
    expect(DIAGNOSTICS_POLL_INTERVAL_MS).toBe(20_000);
  });
});
