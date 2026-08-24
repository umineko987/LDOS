import { describe, expect, it, vi } from "vitest";
import type { PollingService } from "../../core/polling/service";

import { createProxyController } from "./controller";
import { sanitizeProxySources, sanitizeProxyStatus } from "./model";
import type { ProxyService } from "./service";
import { createProxyStore } from "./state";

function rawStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    engine: "native",
    managed_by_backend: true,
    auto_start: false,
    running: false,
    total: 1,
    healthy: 0,
    retry_eligible: 1,
    leases: 0,
    configured_revision: "a".repeat(64),
    active_revision: "b".repeat(64),
    reload_required: true,
    transport_core: {},
    sources: {},
    nodes: [{ id: "node-one", name: "One", protocol: "http", endpoint: "http://***@proxy.invalid:8080" }],
    ...overrides,
  };
}

function rawSources(overrides: Record<string, unknown> = {}) {
  return {
    source: "runtime",
    has_runtime_override: true,
    runtime_override_valid: true,
    configured_revision: "a".repeat(64),
    active_revision: "b".repeat(64),
    reload_required: true,
    subscriptions: [],
    node_file: { configured: false, source: "none", display_path: null },
    inline_nodes: [],
    counts: { subscriptions: 0, node_file: 0, inline_nodes: 0, total: 0 },
    ...overrides,
  };
}

function source(overrides: Record<string, unknown> = {}) {
  return sanitizeProxySources(rawSources(overrides));
}

function status(overrides: Record<string, unknown> = {}) {
  return sanitizeProxyStatus(rawStatus(overrides));
}

function polling() {
  const registrations = new Map<string, { task: (signal: AbortSignal) => Promise<unknown>; stop: ReturnType<typeof vi.fn> }>();
  return {
    start: vi.fn((registration: { key: string; task: (signal: AbortSignal) => Promise<unknown> }) => {
      const handle = { task: registration.task, stop: vi.fn(() => registrations.delete(registration.key)) };
      registrations.set(registration.key, handle);
      return handle;
    }),
    stop: vi.fn((key: string) => registrations.delete(key)),
    stopScope: vi.fn(),
    getSummary: vi.fn(() => []),
    destroy: vi.fn(),
    registrations,
  };
}

function harness(overrides: Partial<ProxyService> = {}) {
  const authority = Object.freeze({ status: status(), sources: source() });
  const service = {
    readStatus: vi.fn(async () => authority.status),
    readSources: vi.fn(async () => authority.sources),
    readAuthority: vi.fn(async () => authority),
    runtime: vi.fn(async () => {}),
    addSubscription: vi.fn(async () => {}),
    replaceSubscription: vi.fn(async () => {}),
    setNodeFile: vi.fn(async () => {}),
    addInlineNodes: vi.fn(async () => {}),
    replaceInlineNode: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    ...overrides,
  } as ProxyService;
  const store = createProxyStore();
  const poll = polling();
  const controller = createProxyController({ store, service, polling: poll as unknown as PollingService });
  return { service, store, poll, controller, authority };
}

describe("Proxy controller", () => {
  it("loads sources once, starts immediate status polling, and polls only status", async () => {
    const runtime = harness();
    runtime.controller.activate();
    await Promise.resolve();
    expect(runtime.service.readSources).toHaveBeenCalledOnce();
    expect(runtime.poll.start).toHaveBeenCalledWith(expect.objectContaining({
      key: "proxy.status",
      scope: "app:proxy",
      intervalMs: 10_000,
      immediate: true,
      critical: false,
    }));
    const task = runtime.poll.registrations.get("proxy.status")?.task;
    expect(task).toBeTypeOf("function");
    await task?.(new AbortController().signal);
    expect(runtime.service.readStatus).toHaveBeenCalledOnce();
    runtime.controller.destroy();
    expect(runtime.poll.stop).toHaveBeenCalledWith("proxy.status");
  });

  it("performs one exact runtime write and one combined authority reread", async () => {
    const runtime = harness();
    runtime.controller.activate();
    await Promise.resolve();
    vi.mocked(runtime.service.readAuthority).mockClear();
    await expect(runtime.controller.runtime("reload")).resolves.toBe(true);
    expect(runtime.service.runtime).toHaveBeenCalledWith("reload", expect.any(AbortSignal));
    expect(runtime.service.readAuthority).toHaveBeenCalledOnce();
    expect(runtime.store.getState()).toMatchObject({ phase: "idle", busy: "" });
    runtime.controller.destroy();
  });

  it("does not commit a stale source read after destroy", async () => {
    let resolve!: (value: ReturnType<typeof source>) => void;
    let signal: AbortSignal | null = null;
    const pending = new Promise<ReturnType<typeof source>>((yes) => { resolve = yes; });
    const runtime = harness({
      readSources: vi.fn((currentSignal: AbortSignal) => { signal = currentSignal; return pending; }),
    });
    runtime.controller.activate();
    await Promise.resolve();
    runtime.controller.destroy();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    resolve(source());
    await Promise.resolve();
    expect(runtime.store.getState().sources).toBeNull();
  });

  it("writes each source through validation, clears stale failure with authority, and confirms destructive actions", async () => {
    const runtime = harness({
      addSubscription: vi.fn(async () => { throw Object.assign(new Error("private"), { status: 422, code: "invalid_proxy_subscription" }); }),
    });
    runtime.controller.activate();
    await Promise.resolve();
    expect(await runtime.controller.addSubscription("ftp://bad.invalid")).toBe(false);
    expect(runtime.service.addSubscription).not.toHaveBeenCalled();
    expect(runtime.store.getState().message).toContain("未发送请求");
    expect(runtime.controller.requestRemove("override-reset")).toBe(true);
    expect(await runtime.controller.confirmRemove(false)).toBe(false);
    expect(runtime.service.remove).not.toHaveBeenCalled();
    expect(runtime.controller.requestRemove("override-reset")).toBe(true);
    expect(await runtime.controller.confirmRemove(true)).toBe(true);
    expect(runtime.service.remove).toHaveBeenCalledWith("override", "", expect.any(AbortSignal));
    runtime.controller.destroy();
  });
});
