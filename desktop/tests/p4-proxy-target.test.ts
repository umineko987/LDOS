import { describe, expect, it, vi } from "vitest";

import { sanitizeProxySources, sanitizeProxyStatus } from "../src/apps/proxy/model";
import proxySource from "../src/apps/proxy/Proxy.svelte?raw";
import { createProxyStore } from "../src/apps/proxy/state";

function status() {
  return sanitizeProxyStatus({
    enabled: true,
    engine: "native",
    managed_by_backend: true,
    running: false,
    total: 2,
    healthy: 1,
    retry_eligible: 1,
    leases: 0,
    configured_revision: "a".repeat(64),
    active_revision: "b".repeat(64),
    reload_required: true,
    transport_core: {},
    sources: {},
    nodes: [
      { id: "node-one", name: "One", protocol: "http", endpoint: "http://proxy.invalid:8080" },
      { id: "node-two", name: "Two", protocol: "https", endpoint: "https://proxy.invalid:8443" },
    ],
  });
}

type SourceKey = "one" | "two";

function sources(order: readonly SourceKey[]) {
  const values = {
    one: { id: `sub_${"a".repeat(64)}`, source: "runtime", scheme: "https", host: "one.invalid", port: 443 },
    two: { id: `sub_${"b".repeat(64)}`, source: "runtime", scheme: "https", host: "two.invalid", port: 443 },
  } as const;
  return sanitizeProxySources({
    source: "runtime",
    has_runtime_override: true,
    runtime_override_valid: true,
    configured_revision: "a".repeat(64),
    active_revision: "b".repeat(64),
    reload_required: true,
    subscriptions: order.map((key) => values[key]),
    node_file: { configured: false, source: "none", display_path: null },
    inline_nodes: [],
    counts: { subscriptions: 2, node_file: 0, inline_nodes: 0, total: 2 },
  });
}

describe("P4 Proxy target ownership", () => {
  it("updates one domain projection while preserving the unrelated keyed status", () => {
    const store = createProxyStore();
    store.commitAuthority(status(), sources(["one", "two"]));
    const before = store.getState();
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();

    store.commitSources(sources(["two", "one"]), "来源顺序已更新。");

    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState().status).toBe(before.status);
    expect(store.getState().sources?.subscriptionOrder).toEqual([
      `sub_${"b".repeat(64)}`,
      `sub_${"a".repeat(64)}`,
    ]);
    expect(store.getState().sources?.subscriptions[`sub_${"a".repeat(64)}`]).toMatchObject({ host: "one.invalid" });
  });

  it("keeps keyed Svelte projections and the no-bypass boundary", () => {
    expect(proxySource).toContain("{#each nodes as node (node.id)}");
    expect(proxySource).toContain("{#each subscriptions as item (item.id)}");
    expect(proxySource).toContain("{#each inlineNodes as item (item.id)}");
    expect(proxySource).not.toContain("replaceChildren(");
    expect(proxySource).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\bsetInterval\s*\(|innerHTML|console\./);
    expect(proxySource).toContain('data-domain-owner="proxy"');
  });
});
