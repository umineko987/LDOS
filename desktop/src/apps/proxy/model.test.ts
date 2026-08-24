import { describe, expect, it } from "vitest";

import {
  PROXY_NODE_RENDER_LIMIT,
  PROXY_STATUS_POLL_INTERVAL_MS,
  proxyControls,
  proxyErrorPresentation,
  proxyWorkspace,
  sanitizeProxySources,
  sanitizeProxyStatus,
  validateInlineNodeInput,
  validateNodeFileInput,
  validateSubscriptionInput,
} from "./model";

const SECRET = "proxy-cookie-token-password-secret-271828182845";
const CONFIGURED = "a".repeat(64);
const ACTIVE = "b".repeat(64);
const SUBSCRIPTION_ID = `sub_${"c".repeat(64)}`;
const INLINE_ID = `node_${"d".repeat(64)}`;

export function rawProxyStatus(overrides: Record<string, unknown> = {}) {
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
    last_error: `token=${SECRET} https://private.invalid/secret`,
    configured_revision: CONFIGURED,
    active_revision: ACTIVE,
    reload_required: true,
    transport_core: { enabled: true, running: false, listeners: 0, last_error: `secret=${SECRET}` },
    sources: {
      subscriptions: 1,
      source_nodes: 1,
      pool_nodes: 1,
      core_candidates: 0,
      core_nodes: 0,
      skipped_nodes: 0,
      warnings: [`https://private.invalid/${SECRET}`],
    },
    nodes: [{
      id: "proxy-stage4-node",
      name: "JP node",
      protocol: "http",
      endpoint: "http://***@proxy.fixture.invalid:8080",
      tags: ["jp"],
      healthy: false,
      retry_eligible: true,
      ref_count: 0,
      success_count: 2,
      fail_count: 1,
      last_latency_ms: 50,
      cooldown_until: 0,
      last_error: `cookie=${SECRET}`,
      raw: SECRET,
    }],
    raw: SECRET,
    ...overrides,
  };
}

export function rawProxySources(overrides: Record<string, unknown> = {}) {
  return {
    source: "runtime",
    has_runtime_override: true,
    runtime_override_valid: true,
    configured_revision: CONFIGURED,
    active_revision: ACTIVE,
    reload_required: true,
    subscriptions: [{
      id: SUBSCRIPTION_ID,
      source: "runtime",
      scheme: "https",
      host: "provider.fixture.invalid",
      port: 443,
      display_url: `https://provider.fixture.invalid/private/${SECRET}`,
      credentials_redacted: true,
      sensitive_parts_redacted: true,
      url: `https://user:${SECRET}@provider.fixture.invalid/private`,
    }],
    node_file: {
      configured: true,
      source: "runtime",
      display_path: `/private/${SECRET}/nodes.yaml`,
      path: `/private/${SECRET}/nodes.yaml`,
    },
    inline_nodes: [{
      id: INLINE_ID,
      source: "runtime",
      scheme: "vless",
      name: "JP-01",
      host: "proxy.fixture.invalid",
      port: 443,
      requires_transport_core: true,
      display_endpoint: `vless://${SECRET}@proxy.fixture.invalid:443`,
      node: `vless://${SECRET}@proxy.fixture.invalid:443`,
    }],
    counts: { subscriptions: 1, node_file: 1, inline_nodes: 1, total: 3 },
    raw: SECRET,
    ...overrides,
  };
}

describe("Proxy runtime sanitizer", () => {
  it("projects status/source facts into stable keyed entities without secrets or paths", () => {
    const status = sanitizeProxyStatus(rawProxyStatus());
    const sources = sanitizeProxySources(rawProxySources());
    expect(status.nodeOrder).toEqual(["proxy-stage4-node"]);
    expect(status.nodes["proxy-stage4-node"]).toMatchObject({
      endpoint: "http://***@proxy.fixture.invalid:8080",
      retryEligible: true,
    });
    expect(sources.subscriptionOrder).toEqual([SUBSCRIPTION_ID]);
    expect(sources.subscriptions[SUBSCRIPTION_ID].displayUrl).toBe("https://provider.fixture.invalid:443/…");
    expect(sources.nodeFile.displayPath).toBe("路径已隐藏");
    expect(sources.inlineNodes[INLINE_ID].displayEndpoint).toBe("vless://***@proxy.fixture.invalid:443#JP-01");
    const serialized = JSON.stringify({ status, sources });
    for (const forbidden of [SECRET, "private.invalid", "/private/", "password", " raw\""]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("bounds duplicate lists and rejects malformed roots", () => {
    const status = sanitizeProxyStatus(rawProxyStatus({
      nodes: Array.from({ length: 510 }, (_, index) => ({
        ...rawProxyStatus().nodes[0],
        id: index === 1 ? "proxy-stage4-node" : `node-${index}`,
      })),
      total: 510,
    }));
    expect(status.nodeOrder).toHaveLength(500);
    expect(status.nodesTruncated).toBe(true);
    expect(PROXY_NODE_RENDER_LIMIT).toBe(160);
    expect(() => sanitizeProxyStatus(null)).toThrow("invalid_proxy_status");
    expect(() => sanitizeProxySources([])).toThrow("invalid_proxy_sources");
  });

  it("validates all transient source inputs without retaining them", () => {
    expect(validateSubscriptionInput(`https://user:${SECRET}@provider.invalid/private?token=x`)).toMatchObject({ valid: true });
    expect(validateSubscriptionInput("ftp://provider.invalid/private")).toMatchObject({ valid: false, reason: "unsupported_scheme" });
    expect(validateSubscriptionInput("https://")).toMatchObject({ valid: false, reason: "malformed" });
    expect(validateNodeFileInput("../subscriptions/nodes.yaml")).toMatchObject({ valid: true });
    expect(validateNodeFileInput("bad\u0000path")).toMatchObject({ valid: false, reason: "control_character" });
    expect(validateInlineNodeInput("vless://uuid@proxy.invalid:443#one\nhttp://user:pass@proxy.invalid:8080", true).value)
      .toEqual(["vless://uuid@proxy.invalid:443#one", "http://user:pass@proxy.invalid:8080"]);
    expect(validateInlineNodeInput("ftp://proxy.invalid:21", false)).toMatchObject({ valid: false, reason: "unsupported_scheme" });
  });

  it("derives explicit workspace/control/error facts", () => {
    const status = sanitizeProxyStatus(rawProxyStatus());
    const sources = sanitizeProxySources(rawProxySources());
    expect(PROXY_STATUS_POLL_INTERVAL_MS).toBe(10_000);
    expect(proxyWorkspace(null, null, "loading").label).toBe("正在加载");
    expect(proxyWorkspace(status, sources, "idle").label).toBe("有配置待应用");
    expect(proxyControls(status, "")).toEqual({ refresh: false, start: false, stop: true, reload: false, probe: true });
    expect(proxyControls(sanitizeProxyStatus(rawProxyStatus({ running: true })), "")).toEqual({
      refresh: false, start: true, stop: false, reload: false, probe: false,
    });
    const error = proxyErrorPresentation(Object.assign(new Error(SECRET), {
      status: 422,
      code: "invalid_proxy_inline_node",
      requestId: "request-safe",
      details: { index: 2, reason: "unsupported_scheme", token: SECRET },
    }));
    expect(error).toMatchObject({ code: "invalid_proxy_inline_node", detail: "第 3 行：unsupported_scheme" });
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });
});
