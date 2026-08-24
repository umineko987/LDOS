import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../core/api/client";
import { PROXY_ENDPOINTS, createProxyService } from "./service";

const SUBSCRIPTION_ID = `sub_${"c".repeat(64)}`;
const INLINE_ID = `node_${"d".repeat(64)}`;

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
    subscriptions: [{ id: SUBSCRIPTION_ID, source: "runtime", scheme: "https", host: "provider.invalid", port: 443 }],
    node_file: { configured: false, source: "none", display_path: null },
    inline_nodes: [],
    counts: { subscriptions: 1, node_file: 0, inline_nodes: 0, total: 1 },
  };
}

function api(responses: unknown[] = []) {
  return {
    get: vi.fn(async () => responses.shift()),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  } as unknown as ApiClient & Record<"get" | "post" | "put" | "delete", ReturnType<typeof vi.fn>>;
}

describe("Proxy API service", () => {
  it("reads status/sources concurrently through the exact endpoints and sanitizes before return", async () => {
    const client = api([rawProxyStatus(), rawProxySources()]);
    const service = createProxyService(client);
    const controller = new AbortController();
    const authority = await service.readAuthority(controller.signal);
    expect(client.get.mock.calls).toEqual([
      [PROXY_ENDPOINTS.status, { signal: expect.any(AbortSignal) }],
      [PROXY_ENDPOINTS.sources, { signal: expect.any(AbortSignal) }],
    ]);
    expect(authority.status.nodeOrder).toEqual(["proxy-stage4-node"]);
    expect(authority.sources.subscriptionOrder).toEqual([SUBSCRIPTION_ID]);
    expect(JSON.stringify(authority)).not.toContain("proxy-cookie-token-password");
  });

  it("uses exact runtime methods and bodies", async () => {
    const client = api();
    const service = createProxyService(client);
    const signal = new AbortController().signal;
    await service.runtime("start", signal);
    await service.runtime("stop", signal);
    await service.runtime("reload", signal);
    await service.runtime("probe", signal);
    expect(client.post.mock.calls).toEqual([
      [PROXY_ENDPOINTS.start, { force_refresh: true }, { signal }],
      [PROXY_ENDPOINTS.stop, { force: false }, { signal }],
      [PROXY_ENDPOINTS.reload, { force_refresh: true }, { signal }],
      [PROXY_ENDPOINTS.probe, {}, { signal }],
    ]);
    await expect(service.runtime("bad" as never, signal)).rejects.toThrow("invalid_proxy_runtime_action");
  });

  it("uses exact source CRUD endpoints and transient bodies", async () => {
    const client = api();
    const service = createProxyService(client);
    const signal = new AbortController().signal;
    const subscription = "https://user:secret@provider.invalid/private";
    const nodes = "vless://uuid@proxy.invalid:443#one\nhttp://user:pass@proxy.invalid:8080";
    await service.addSubscription(subscription, signal);
    await service.replaceSubscription(SUBSCRIPTION_ID, subscription, signal);
    await service.setNodeFile("../subscriptions/nodes.yaml", signal);
    await service.addInlineNodes(nodes, signal);
    await service.replaceInlineNode(INLINE_ID, "trojan://secret@replacement.invalid:443#two", signal);
    await service.remove("subscription", SUBSCRIPTION_ID, signal);
    await service.remove("inline", INLINE_ID, signal);
    await service.remove("node-file", "", signal);
    await service.remove("override", "", signal);
    expect(client.post.mock.calls).toEqual([
      [PROXY_ENDPOINTS.subscriptions, { url: subscription }, { signal }],
      [PROXY_ENDPOINTS.inlineNodes, { nodes: nodes.split("\n") }, { signal }],
    ]);
    expect(client.put.mock.calls).toEqual([
      [`${PROXY_ENDPOINTS.subscriptions}/${SUBSCRIPTION_ID}`, { url: subscription }, { signal }],
      [PROXY_ENDPOINTS.nodeFile, { path: "../subscriptions/nodes.yaml" }, { signal }],
      [`${PROXY_ENDPOINTS.inlineNodes}/${INLINE_ID}`, { node: "trojan://secret@replacement.invalid:443#two" }, { signal }],
    ]);
    expect(client.delete.mock.calls.map(([path]) => path)).toEqual([
      `${PROXY_ENDPOINTS.subscriptions}/${SUBSCRIPTION_ID}`,
      `${PROXY_ENDPOINTS.inlineNodes}/${INLINE_ID}`,
      PROXY_ENDPOINTS.nodeFile,
      PROXY_ENDPOINTS.override,
    ]);
  });

  it("aborts both authority reads on partial failure", async () => {
    const signals: AbortSignal[] = [];
    const client = api();
    client.get.mockImplementation((path: string, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return path === PROXY_ENDPOINTS.status ? Promise.reject(new Error("failed")) : new Promise(() => {});
    });
    const service = createProxyService(client);
    await expect(service.readAuthority(new AbortController().signal)).rejects.toThrow("failed");
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0].aborted).toBe(true);
  });
});
