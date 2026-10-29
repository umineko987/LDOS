import { describe, expect, it } from "vitest";

import {
  accountsView,
  authorizingSite,
  parseInlineNodes,
  parsePolicyDraft,
  policiesView,
  policyDraft,
  proxyControls,
  proxySourcesView,
  proxyStatusView,
  samePolicy,
  validateInlineNode,
  validateLocalPath,
  validateSubscriptionUrl,
  type DesktopProxySources,
  type DesktopProxyStatus,
  type PolicyFields,
  type ProxyStatusView,
  type VaultStatuses,
} from "./network.ts";

const STATUS: DesktopProxyStatus = {
  response_profile: "desktop-proxy-v1",
  enabled: true,
  engine: "mihomo",
  managed_by_backend: true,
  auto_start: false,
  running: true,
  total: 2,
  healthy: 1,
  retry_eligible: 1,
  leases: 0,
  configured_revision: "r2",
  active_revision: "r1",
  reload_required: true,
  last_error: "",
  transport_core: { enabled: true, running: true, listeners: 2, last_error: null },
  sources: { warnings: ["1 个节点被跳过"] },
  nodes: [
    {
      id: "n1",
      name: "东京",
      protocol: "vless",
      endpoint: "jp.example:443",
      tags: [],
      healthy: true,
      retry_eligible: true,
      ref_count: 0,
      success_count: 3,
      fail_count: 0,
      last_latency_ms: 120,
      cooldown_until: null,
      last_error: "",
    },
  ],
  node_rows_total: 40,
  node_rows_truncated: true,
};

const SOURCES: DesktopProxySources = {
  response_profile: "desktop-proxy-sources-v1",
  source: "runtime",
  has_runtime_override: true,
  runtime_override_valid: true,
  configured_revision: "r2",
  active_revision: "r1",
  reload_required: true,
  subscriptions: [
    { id: `sub_${"a".repeat(64)}`, source: "runtime", scheme: "https", host: "sub.example", port: null, credentials_redacted: true, sensitive_parts_redacted: false },
  ],
  node_file: { configured: true, source: "runtime", display_path: "~/nodes.yaml" },
  inline_nodes: [
    { id: `node_${"b".repeat(64)}`, source: "runtime", scheme: "socks5", name: "本地", host: "127.0.0.1", port: 1080, requires_transport_core: false },
  ],
  counts: { total: 3 },
  subscription_rows_truncated: false,
  inline_node_rows_truncated: false,
};

const VAULT: VaultStatuses = {
  response_profile: "vault",
  managed: true,
  secrets_exposed: false,
  browser_profile: { shared: true, present: true, running: false, resetting: false, sites: [] },
  authorization_proxy: { source: "none", credentials_redacted: false, browser_running: false, restart_pending: false, updated_at: null },
  items: [
    { site: "danbooru", label: "Danbooru", method: "anonymous", state: "ready", authorized: false, summary: "匿名访问", updated_at: null, invalidated_at: null, actions: [] },
    {
      site: "twitter",
      label: "X / Twitter",
      method: "managed_browser",
      state: "authorizing",
      authorized: false,
      summary: "等待登录",
      updated_at: null,
      invalidated_at: null,
      actions: ["managed_browser_login", "clear"],
      cookies: { present: true, valid: false, cookie_count: 4, updated_at: 1_700_000_000 },
      login: { session_id: "c".repeat(32), state: "awaiting_login", created_at: 1, expires_at: 2 },
    },
    {
      site: "pixiv",
      label: "Pixiv",
      method: "oauth",
      state: "authorized",
      authorized: true,
      summary: "已授权",
      updated_at: 1_700_000_100,
      invalidated_at: null,
      actions: ["oauth", "clear"],
      oauth: { session_id: "d".repeat(32), state: "authorized", created_at: 1, expires_at: 2 },
    },
  ],
};

const POLICY: PolicyFields = { max_concurrency: 4, retry_limit: 2, backoff_base_seconds: 2.5, proxy_mode: "prefer" };

describe("proxy status", () => {
  it("reads the desktop view", () => {
    const view = proxyStatusView(STATUS);
    expect(view).toMatchObject({ legacy: false, running: true, reloadRequired: true, leases: 0, lastError: null, nodesTruncatedFrom: 40 });
    expect(view.transportCore).toEqual({ enabled: true, running: true, listeners: 2, lastError: null });
    expect(view.nodes[0]).toEqual({ id: "n1", name: "东京", protocol: "vless", endpoint: "jp.example:443", healthy: true, latencyMs: 120, leases: 0, lastError: "" });
    expect(view.warnings).toEqual(["1 个节点被跳过"]);
  });

  it("fills safe defaults for nullable desktop fields", () => {
    const view = proxyStatusView({ ...STATUS, enabled: null, leases: null, running: null, last_error: "boom", transport_core: {}, node_rows_truncated: false });
    expect(view).toMatchObject({ enabled: false, running: false, leases: 0, lastError: "boom", nodesTruncatedFrom: null });
    expect(view.transportCore).toEqual({ enabled: false, running: false, listeners: null, lastError: null });
  });

  it("narrows the legacy shape field by field", () => {
    const view = proxyStatusView({
      enabled: true,
      running: false,
      leases: 1,
      transport_core: { enabled: true, listeners: "x", last_error: "core down" },
      sources: { warnings: ["w", 3] },
      nodes: [{ id: "a", name: "A", protocol: "http", endpoint: "a:1", healthy: true, last_latency_ms: 9, ref_count: 1, last_error: "" }, { endpoint: "b:2", scheme: "ss" }, "junk" as never],
    });
    expect(view).toMatchObject({ legacy: true, enabled: true, running: false, leases: 1, engine: null, total: null, lastError: null });
    expect(view.transportCore).toEqual({ enabled: true, running: false, listeners: null, lastError: "core down" });
    expect(view.warnings).toEqual(["w"]);
    expect(view.nodes.map((node) => [node.id, node.name, node.protocol])).toEqual([
      ["a", "A", "http"],
      ["legacy-1", "b:2", "ss"],
    ]);
    expect(proxyStatusView({}).nodes).toEqual([]);
    expect(proxyStatusView({ nodes: [{}] }).nodes[0]).toMatchObject({ id: "legacy-0", name: "legacy-0", protocol: "" });
  });

  it("only enables controls that make sense now", () => {
    const view = (overrides: Partial<ProxyStatusView>): ProxyStatusView => ({ ...proxyStatusView(STATUS), ...overrides });
    expect(proxyControls(null, false)).toEqual({ start: false, stop: false, reload: false, probe: false });
    expect(proxyControls(view({}), true)).toEqual({ start: false, stop: false, reload: false, probe: false });
    expect(proxyControls(view({}), false)).toEqual({ start: false, stop: true, reload: true, probe: true });
    expect(proxyControls(view({ running: false, reloadRequired: false }), false)).toEqual({ start: true, stop: false, reload: false, probe: false });
    expect(proxyControls(view({ leases: 2 }), false)).toEqual({ start: false, stop: false, reload: false, probe: true });
    expect(proxyControls(view({ enabled: false, running: false }), false)).toEqual({ start: false, stop: false, reload: false, probe: false });
  });
});

describe("proxy sources", () => {
  it("reads the desktop view", () => {
    const view = proxySourcesView(SOURCES);
    expect(view).toMatchObject({ legacy: false, editable: true, hasOverride: true, reloadRequired: true, truncated: false });
    expect(view.subscriptions).toEqual([{ id: SOURCES.subscriptions[0]!.id, label: "https://sub.example", redacted: true }]);
    expect(view.nodeFile).toEqual({ configured: true, path: "~/nodes.yaml" });
    expect(view.inlineNodes).toEqual([{ id: SOURCES.inline_nodes[0]!.id, name: "本地", label: "socks5://127.0.0.1:1080", requiresCore: false }]);
    expect(proxySourcesView({ ...SOURCES, runtime_override_valid: false, inline_node_rows_truncated: true })).toMatchObject({ editable: false, truncated: true });
  });

  it("shows legacy sources read-only", () => {
    const view = proxySourcesView({
      source: "config",
      reload_required: true,
      runtime_override_valid: true,
      subscriptions: [{ id: "s", scheme: "http", host: "h", port: 8080, sensitive_parts_redacted: true }, {}],
      node_file: { configured: true, display_path: "/etc/nodes" },
      inline_nodes: [{ name: "n", scheme: "ss", host: "x", port: 1, requires_transport_core: true }],
    });
    expect(view).toMatchObject({ legacy: true, editable: false, source: "config", reloadRequired: true, hasOverride: false });
    expect(view.subscriptions).toEqual([
      { id: "s", label: "http://h:8080", redacted: true },
      { id: "legacy-1", label: "?://?", redacted: false },
    ]);
    expect(view.nodeFile).toEqual({ configured: true, path: "/etc/nodes" });
    expect(view.inlineNodes).toEqual([{ id: "legacy-0", name: "n", label: "ss://x:1", requiresCore: true }]);
    expect(proxySourcesView({})).toMatchObject({ source: "", subscriptions: [], nodeFile: { configured: false, path: null } });
  });

  it("validates subscription urls and paths", () => {
    expect(validateSubscriptionUrl(" https://sub.example/x?token=1 ")).toBeNull();
    expect(validateSubscriptionUrl("")).toBe("empty");
    expect(validateSubscriptionUrl(`https://a.example/${"x".repeat(4096)}`)).toBe("too_long");
    expect(validateSubscriptionUrl("https://a.example/\u0007")).toBe("control");
    expect(validateSubscriptionUrl("ftp://a.example")).toBe("not_http");
    expect(validateSubscriptionUrl("nonsense")).toBe("not_http");
    expect(validateLocalPath("~/nodes.yaml")).toBeNull();
    expect(validateLocalPath("  ")).toBe("empty");
    expect(validateLocalPath("x".repeat(4097))).toBe("too_long");
    expect(validateLocalPath("a\nb")).toBe("control");
  });

  it("parses inline nodes one per line", () => {
    expect(parseInlineNodes("socks5://127.0.0.1:1080\n\n  vless://id@h:443#jp  ")).toEqual({
      nodes: ["socks5://127.0.0.1:1080", "vless://id@h:443#jp"],
      error: null,
      line: null,
    });
    expect(parseInlineNodes("socks5://a:1\nfoo://b:2")).toEqual({ nodes: [], error: "scheme", line: 2 });
    expect(parseInlineNodes(" \n ")).toEqual({ nodes: [], error: "empty", line: null });
    expect(parseInlineNodes(Array.from({ length: 513 }, (_, index) => `http://h:${index + 1}`).join("\n")).error).toBe("too_many");
    const big = `ss://${"x".repeat(16 * 1024 - 10)}`;
    expect(parseInlineNodes(Array.from({ length: 140 }, () => big).join("\n")).error).toBe("too_long");
    expect(validateInlineNode("")).toBe("empty");
    expect(validateInlineNode(`ss://${"x".repeat(16 * 1024)}`)).toBe("too_long");
    expect(validateInlineNode("ss://a\u0085b")).toBe("control");
    expect(validateInlineNode("HY2://h:1")).toBeNull();
  });
});

describe("accounts", () => {
  it("derives actions and the active session from the vault view", () => {
    const view = accountsView(VAULT);
    expect(view.legacy).toBe(false);
    expect(view.accounts.map((item) => [item.site, item.authorize, item.clear])).toEqual([
      ["danbooru", null, false],
      ["twitter", "managed_browser", true],
      ["pixiv", "oauth", true],
    ]);
    expect(view.accounts[1]).toMatchObject({ cookieCount: 4, updatedAt: 1_700_000_000, session: { id: "c".repeat(32), kind: "managed_browser", state: "awaiting_login" } });
    // 已完成的 OAuth 会话不算进行中。
    expect(view.accounts[2]!.session).toBeNull();
    expect(authorizingSite(view)).toBe("twitter");
    expect(authorizingSite(null)).toBeNull();
  });

  it("treats a pixiv session waiting for the code as active", () => {
    const items = VAULT.items.map((item) =>
      item.site === "pixiv" ? { ...item, oauth: { session_id: "e".repeat(32), state: "awaiting_code" as const, created_at: 1, expires_at: 2 } } : item,
    );
    expect(accountsView({ ...VAULT, items }).accounts[2]!.session).toEqual({ id: "e".repeat(32), kind: "oauth", state: "awaiting_code" });
  });

  it("shows legacy accounts without write actions", () => {
    const view = accountsView({
      items: [
        { site: "twitter", label: "X", method: "managed_browser", state: "authorized", authorized: true, actions: ["managed_browser_login", "clear"], summary: "ok" },
        { site: "future", method: "passkey", state: "weird" },
        { label: "no site" },
      ],
      browser_profile: { resetting: true },
    });
    expect(view).toMatchObject({ legacy: true, profileResetting: true });
    expect(view.accounts).toHaveLength(2);
    expect(view.accounts[0]).toMatchObject({ site: "twitter", authorized: true, authorize: null, clear: false, summary: "ok" });
    expect(view.accounts[1]).toMatchObject({ site: "future", label: "future", method: "unknown", state: "unknown", summary: "", session: null });
    expect(accountsView({}).accounts).toEqual([]);
  });
});

describe("site policies", () => {
  it("reads the policy view", () => {
    const view = policiesView({
      response_profile: "policy",
      secrets_exposed: false,
      effect_scope: "new_tasks",
      concurrency_protection: "x",
      default_source: "config",
      persistence: "runtime",
      default: { editable: false, reason: "默认值来自配置", policy: POLICY },
      items: [
        {
          site: "pixiv",
          label: "Pixiv",
          supported: true,
          authorization: "oauth",
          selection_mode: "x",
          availability: "available",
          inherited: false,
          has_override: true,
          editable: true,
          reason: "",
          updated_at: 5,
          policy: POLICY,
        },
      ],
      unknown_override_count: 1,
    });
    expect(view).toMatchObject({ legacy: false, defaultPolicy: POLICY, unknownOverrides: 1 });
    expect(view.rows[0]).toEqual({ site: "pixiv", label: "Pixiv", editable: true, reason: "", hasOverride: true, inherited: false, updatedAt: 5, policy: POLICY });
  });

  it("shows legacy policies read-only", () => {
    const view = policiesView({ default: POLICY, items: [{ site: "danbooru", inherited: true, policy: POLICY }, { site: "pixiv", inherited: false }, { policy: POLICY }] });
    expect(view).toMatchObject({ legacy: true, defaultPolicy: POLICY, unknownOverrides: 0 });
    expect(view.rows.map((row) => [row.site, row.editable, row.hasOverride, row.policy])).toEqual([
      ["danbooru", false, false, POLICY],
      ["pixiv", false, true, null],
    ]);
    expect(policiesView({})).toMatchObject({ defaultPolicy: null, rows: [] });
  });

  it("parses and bounds the edit draft", () => {
    const draft = policyDraft(POLICY);
    expect(draft).toEqual({ max_concurrency: "4", retry_limit: "2", backoff_base_seconds: "2.5", proxy_mode: "prefer" });
    expect(parsePolicyDraft({ ...draft, proxy_mode: "required" })).toEqual({ policy: { ...POLICY, proxy_mode: "required" }, invalid: [] });
    expect(parsePolicyDraft({ ...draft, max_concurrency: "0", retry_limit: "1.5", backoff_base_seconds: "" })).toEqual({
      policy: null,
      invalid: ["max_concurrency", "retry_limit", "backoff_base_seconds"],
    });
    expect(parsePolicyDraft({ ...draft, backoff_base_seconds: "3601" }).invalid).toEqual(["backoff_base_seconds"]);
  });

  it("compares policies", () => {
    expect(samePolicy(POLICY, { ...POLICY })).toBe(true);
    expect(samePolicy(POLICY, { ...POLICY, retry_limit: 3 })).toBe(false);
    expect(samePolicy(null, null)).toBe(true);
    expect(samePolicy(POLICY, null)).toBe(false);
  });
});
