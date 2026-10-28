import { describe, expect, it, vi } from "vitest";

import { sanitizeProxySources, sanitizeProxyStatus } from "./model";
import { createProxyStore, proxyInlineNodes, proxyNodes, proxySubscriptions } from "./state";

function rawProxyStatus() {
  return {
    enabled: true, running: false, total: 1, healthy: 0, retry_eligible: 1, leases: 0,
    engine: "native", managed_by_backend: true, auto_start: false,
    configured_revision: "a".repeat(64), active_revision: "b".repeat(64), reload_required: true,
    transport_core: {}, sources: {},
    nodes: [{ id: "proxy-stage4-node", name: "One", protocol: "http", endpoint: "http://***@proxy.invalid:8080" }],
  };
}

function rawProxySources() {
  return {
    source: "runtime", has_runtime_override: true, runtime_override_valid: true,
    configured_revision: "a".repeat(64), active_revision: "b".repeat(64), reload_required: true,
    subscriptions: [{
      id: `sub_${"c".repeat(64)}`, source: "runtime", scheme: "https", host: "provider.invalid", port: 443,
    }],
    node_file: { configured: false, source: "none", display_path: null },
    inline_nodes: [{
      id: `node_${"d".repeat(64)}`, source: "runtime", scheme: "vless", name: "One", host: "proxy.invalid", port: 443,
    }],
    counts: { subscriptions: 1, node_file: 0, inline_nodes: 1, total: 2 },
  };
}

const SUBSCRIPTION_ID = `sub_${"c".repeat(64)}`;

describe("the one Proxy domain state owner", () => {
  it("commits status+sources once and keeps normalized list order independent", () => {
    const store = createProxyStore();
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    const status = sanitizeProxyStatus(rawProxyStatus());
    const sources = sanitizeProxySources(rawProxySources());
    expect(store.commitAuthority(status, sources)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(proxyNodes(store.getState()).map(({ id }) => id)).toEqual(["proxy-stage4-node"]);
    expect(proxySubscriptions(store.getState()).map(({ id }) => id)).toEqual([SUBSCRIPTION_ID]);
    expect(proxyInlineNodes(store.getState())).toHaveLength(1);
  });

  it("commits one poll without replacing source entities and preserves authority on failure", () => {
    const store = createProxyStore();
    const status = sanitizeProxyStatus(rawProxyStatus());
    const sources = sanitizeProxySources(rawProxySources());
    store.commitAuthority(status, sources);
    const before = store.getState();
    const next = sanitizeProxyStatus({ ...rawProxyStatus(), running: true });
    store.commitStatus(next);
    expect(store.getState().sources).toBe(before.sources);
    expect(store.getState().status).toBe(next);
    store.fail({
      code: "network_error", status: 0, requestId: "", title: "失败", message: "失败", nextStep: "刷新", detail: "",
    });
    expect(store.getState()).toMatchObject({ phase: "partial", sources: before.sources, status: next });
  });

  it("owns one confirmation and clears subscribers on destroy", () => {
    const store = createProxyStore();
    expect(store.requestConfirmation({
      action: "subscription-delete",
      sourceId: SUBSCRIPTION_ID,
      title: "删除订阅？",
      message: "删除",
      confirmLabel: "删除订阅",
      warning: "应用后生效",
    })).toBe(true);
    expect(store.requestConfirmation(store.getState().confirmation!)).toBe(false);
    expect(store.clearConfirmation()).toBe(true);
    expect(store.beginWrite("source-write")).toBe(true);
    const listener = vi.fn();
    store.subscribe(listener);
    store.destroy();
    store.destroy();
    expect(store.setMessage("after destroy")).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });
});
