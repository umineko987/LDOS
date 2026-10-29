// 设置 › 网络的纯逻辑：代理池、站点账号、站点策略。
//
// 这三组接口都按 `view` 参数返回精确视图（desktop / vault / policy），旧后端或参数被忽略时
// 返回 Legacy* 宽松结构。这里把两种都收窄成同一个视图模型：精确视图按 response_profile 识别，
// 旧结构逐字段检查类型，缺的字段给安全的默认值，并标记 `legacy: true`（界面据此只读）。

import type { components } from "#lib/api/schema.d.ts";

type Schemas = components["schemas"];

export type DesktopProxyStatus = Schemas["DesktopProxyStatus"];
export type LegacyProxyStatus = Schemas["LegacyProxyStatus"];
export type DesktopProxySources = Schemas["DesktopProxySources"];
export type LegacyProxySources = Schemas["LegacyProxySources"];
export type VaultStatuses = Schemas["VaultStatuses"];
export type LegacyAuthStatuses = Schemas["LegacyAuthStatuses"];
export type VaultSiteStatus = Schemas["VaultSiteStatus"];
export type VaultSession = Schemas["VaultSession"];
export type PolicyViewSnapshot = Schemas["PolicyViewSnapshot"];
export type LegacySitePolicies = Schemas["LegacySitePolicies"];
export type PolicyFields = Schemas["PolicyFields"];
export type ProxyMode = PolicyFields["proxy_mode"];

type Loose = Record<string, unknown>;

const record = (value: unknown): Loose | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Loose) : null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const integer = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const flag = (value: unknown): boolean => value === true;
const records = (value: unknown): Loose[] => (Array.isArray(value) ? value.map(record).filter((item): item is Loose => item !== null) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

// ---- 代理池状态 ----

export interface ProxyNodeView {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly healthy: boolean;
  readonly latencyMs: number | null;
  readonly leases: number | null;
  readonly lastError: string;
}

export interface ProxyStatusView {
  readonly legacy: boolean;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly autoStart: boolean;
  readonly engine: string | null;
  readonly total: number | null;
  readonly healthy: number | null;
  readonly leases: number;
  readonly reloadRequired: boolean;
  readonly lastError: string | null;
  readonly transportCore: { readonly enabled: boolean; readonly running: boolean; readonly listeners: number | null; readonly lastError: string | null };
  readonly warnings: readonly string[];
  readonly nodes: readonly ProxyNodeView[];
  /** 节点表被截断时的总数；没截断为 null。 */
  readonly nodesTruncatedFrom: number | null;
}

export function isDesktopProxyStatus(value: DesktopProxyStatus | LegacyProxyStatus): value is DesktopProxyStatus {
  return "response_profile" in value && value.response_profile === "desktop-proxy-v1";
}

export function proxyStatusView(value: DesktopProxyStatus | LegacyProxyStatus): ProxyStatusView {
  if (isDesktopProxyStatus(value)) {
    return {
      legacy: false,
      enabled: value.enabled === true,
      running: value.running === true,
      autoStart: value.auto_start === true,
      engine: value.engine,
      total: value.total,
      healthy: value.healthy,
      leases: value.leases ?? 0,
      reloadRequired: value.reload_required === true,
      lastError: value.last_error || null,
      transportCore: {
        enabled: value.transport_core.enabled === true,
        running: value.transport_core.running === true,
        listeners: value.transport_core.listeners ?? null,
        lastError: value.transport_core.last_error || null,
      },
      warnings: value.sources.warnings,
      nodes: value.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        protocol: node.protocol,
        endpoint: node.endpoint,
        healthy: node.healthy,
        latencyMs: node.last_latency_ms,
        leases: node.ref_count,
        lastError: node.last_error,
      })),
      nodesTruncatedFrom: value.node_rows_truncated ? value.node_rows_total : null,
    };
  }
  const core = record(value.transport_core);
  return {
    legacy: true,
    enabled: value.enabled === true,
    running: value.running === true,
    autoStart: value.auto_start === true,
    engine: value.engine ?? null,
    total: value.total ?? null,
    healthy: value.healthy ?? null,
    leases: value.leases ?? 0,
    reloadRequired: value.reload_required === true,
    lastError: value.last_error || null,
    transportCore: {
      enabled: flag(core?.enabled),
      running: flag(core?.running),
      listeners: integer(core?.listeners),
      lastError: text(core?.last_error) || null,
    },
    warnings: strings(record(value.sources)?.warnings),
    nodes: records(value.nodes).map((node, index) => {
      const endpoint = text(node.endpoint) ?? "";
      const id = text(node.id) ?? `legacy-${index}`;
      return {
        id,
        name: text(node.name) ?? (endpoint || id),
        protocol: text(node.protocol) ?? text(node.scheme) ?? "",
        endpoint,
        healthy: flag(node.healthy),
        latencyMs: integer(node.last_latency_ms),
        leases: integer(node.ref_count),
        lastError: text(node.last_error) ?? "",
      };
    }),
    nodesTruncatedFrom: null,
  };
}

export type ProxyAction = "start" | "stop" | "reload" | "probe";

/** 每个运行控制当前能不能点。有租约时不允许启停和重载，避免打断正在用代理的任务。 */
export function proxyControls(view: ProxyStatusView | null, busy: boolean): Record<ProxyAction, boolean> {
  if (!view || busy) return { start: false, stop: false, reload: false, probe: false };
  const leased = view.leases > 0;
  return {
    start: view.enabled && !view.running && !leased,
    stop: view.running && !leased,
    reload: view.enabled && view.reloadRequired && !leased,
    probe: view.enabled && view.running,
  };
}

// ---- 代理来源 ----

export interface SubscriptionView {
  readonly id: string;
  /** scheme://host:port（凭据和敏感部分已由后端去掉）。 */
  readonly label: string;
  readonly redacted: boolean;
}

export interface InlineNodeView {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly requiresCore: boolean;
}

export interface ProxySourcesView {
  readonly legacy: boolean;
  /** 只有运行时覆盖有效时后端才接受来源编辑（否则配置来自 config 文件）。 */
  readonly editable: boolean;
  readonly source: string;
  readonly hasOverride: boolean;
  readonly reloadRequired: boolean;
  readonly subscriptions: readonly SubscriptionView[];
  readonly nodeFile: { readonly configured: boolean; readonly path: string | null };
  readonly inlineNodes: readonly InlineNodeView[];
  readonly truncated: boolean;
}

export function isDesktopProxySources(value: DesktopProxySources | LegacyProxySources): value is DesktopProxySources {
  return "response_profile" in value && value.response_profile === "desktop-proxy-sources-v1";
}

function endpointLabel(scheme: string, host: string, port: number | null): string {
  return `${scheme}://${host}${port === null ? "" : `:${port}`}`;
}

export function proxySourcesView(value: DesktopProxySources | LegacyProxySources): ProxySourcesView {
  if (isDesktopProxySources(value)) {
    return {
      legacy: false,
      editable: value.runtime_override_valid,
      source: value.source,
      hasOverride: value.has_runtime_override,
      reloadRequired: value.reload_required,
      subscriptions: value.subscriptions.map((item) => ({
        id: item.id,
        label: endpointLabel(item.scheme, item.host, item.port),
        redacted: item.credentials_redacted || item.sensitive_parts_redacted,
      })),
      nodeFile: { configured: value.node_file.configured, path: value.node_file.display_path },
      inlineNodes: value.inline_nodes.map((node) => ({
        id: node.id,
        name: node.name,
        label: endpointLabel(node.scheme, node.host, node.port),
        requiresCore: node.requires_transport_core,
      })),
      truncated: value.subscription_rows_truncated || value.inline_node_rows_truncated,
    };
  }
  const file = record(value.node_file);
  const loose = (item: Loose) => endpointLabel(text(item.scheme) ?? "?", text(item.host) ?? "?", integer(item.port));
  return {
    legacy: true,
    editable: false,
    source: value.source ?? "",
    hasOverride: value.has_runtime_override === true,
    reloadRequired: value.reload_required === true,
    subscriptions: records(value.subscriptions).map((item, index) => ({
      id: text(item.id) ?? `legacy-${index}`,
      label: loose(item),
      redacted: flag(item.credentials_redacted) || flag(item.sensitive_parts_redacted),
    })),
    nodeFile: { configured: flag(file?.configured), path: text(file?.display_path) },
    inlineNodes: records(value.inline_nodes).map((item, index) => ({
      id: text(item.id) ?? `legacy-${index}`,
      name: text(item.name) ?? "",
      label: loose(item),
      requiresCore: flag(item.requires_transport_core),
    })),
    truncated: false,
  };
}

// ---- 来源输入校验（和后端的限制一致，后端仍会再查一遍） ----

export const SUBSCRIPTION_ID = /^sub_[0-9a-f]{64}$/;
export const INLINE_NODE_ID = /^node_[0-9a-f]{64}$/;
export const INLINE_SCHEMES: ReadonlySet<string> = new Set([
  "http", "https", "socks4", "socks5", "socks5h", "ss", "ssr", "vless", "vmess",
  "trojan", "hysteria", "hysteria2", "hy2", "tuic", "anytls", "mieru",
]);
const MAX_INLINE_NODE_BYTES = 16 * 1024;
const MAX_INLINE_NODES = 512;
const MAX_INLINE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_URL_LENGTH = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type SourceInputError = "empty" | "too_long" | "control" | "not_http" | "scheme" | "too_many";

export function validateSubscriptionUrl(value: string): SourceInputError | null {
  const url = value.trim();
  if (!url) return "empty";
  if (url.length > MAX_URL_LENGTH) return "too_long";
  if (CONTROL.test(url)) return "control";
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname ? null : "not_http";
  } catch {
    return "not_http";
  }
}

export function validateLocalPath(value: string): SourceInputError | null {
  const path = value.trim();
  if (!path) return "empty";
  if (path.length > MAX_URL_LENGTH) return "too_long";
  return CONTROL.test(path) ? "control" : null;
}

const bytes = (value: string) => new TextEncoder().encode(value).length;

export function validateInlineNode(node: string): SourceInputError | null {
  if (!node) return "empty";
  if (bytes(node) > MAX_INLINE_NODE_BYTES) return "too_long";
  if (CONTROL.test(node)) return "control";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(node)?.[1]?.toLowerCase();
  return scheme && INLINE_SCHEMES.has(scheme) ? null : "scheme";
}

/** 一行一个节点；空行跳过。返回第一个出错的行号（从 1 开始）。 */
export function parseInlineNodes(value: string): { nodes: string[]; error: SourceInputError | null; line: number | null } {
  const lines = value.split(/\r?\n/);
  const nodes: string[] = [];
  for (const [index, raw] of lines.entries()) {
    const node = raw.trim();
    if (!node) continue;
    const error = validateInlineNode(node);
    if (error) return { nodes: [], error, line: index + 1 };
    nodes.push(node);
  }
  if (!nodes.length) return { nodes, error: "empty", line: null };
  if (nodes.length > MAX_INLINE_NODES) return { nodes: [], error: "too_many", line: null };
  if (bytes(nodes.join("\n")) > MAX_INLINE_TOTAL_BYTES) return { nodes: [], error: "too_long", line: null };
  return { nodes, error: null, line: null };
}

// ---- 站点账号 ----

export type SiteMethod = VaultSiteStatus["method"];
export type SiteState = VaultSiteStatus["state"];
export type AuthorizeKind = "managed_browser" | "oauth";

export interface AccountSession {
  readonly id: string;
  readonly kind: AuthorizeKind;
  readonly state: VaultSession["state"];
}

export interface AccountView {
  readonly site: string;
  readonly label: string;
  readonly method: SiteMethod | "unknown";
  readonly state: SiteState | "unknown";
  readonly authorized: boolean;
  readonly summary: string;
  readonly updatedAt: number | null;
  readonly cookieCount: number | null;
  /** 可以发起授权：managed_browser 走项目浏览器登录，oauth 走 Pixiv OAuth。 */
  readonly authorize: AuthorizeKind | null;
  readonly clear: boolean;
  /** 正在进行的授权会话（等待用户在浏览器里登录）。 */
  readonly session: AccountSession | null;
}

export interface AccountsView {
  readonly legacy: boolean;
  readonly accounts: readonly AccountView[];
  readonly profileResetting: boolean;
}

const MANAGED_ACTIVE: ReadonlySet<string> = new Set(["starting", "awaiting_login"]);
const OAUTH_ACTIVE: ReadonlySet<string> = new Set(["starting", "starting_browser", "awaiting_login", "awaiting_code", "exchanging"]);
const METHODS: ReadonlySet<string> = new Set(["anonymous", "managed_browser", "oauth"]);
const STATES: ReadonlySet<string> = new Set(["ready", "authorized", "authorizing", "required"]);

export function isVaultStatuses(value: VaultStatuses | LegacyAuthStatuses): value is VaultStatuses {
  return "response_profile" in value && value.response_profile === "vault";
}

function activeSession(method: string, login: Loose | null, oauth: Loose | null): AccountSession | null {
  const session = method === "oauth" ? oauth : method === "managed_browser" ? login : null;
  const id = text(session?.session_id);
  const state = text(session?.state);
  const active = method === "oauth" ? OAUTH_ACTIVE : MANAGED_ACTIVE;
  if (!id || !state || !active.has(state)) return null;
  return { id, kind: method === "oauth" ? "oauth" : "managed_browser", state: state as VaultSession["state"] };
}

function account(item: Loose, legacy: boolean): AccountView | null {
  const site = text(item.site);
  if (!site) return null;
  const method = text(item.method) ?? "";
  const actions = strings(item.actions);
  const knownMethod = METHODS.has(method) ? (method as SiteMethod) : "unknown";
  const state = text(item.state) ?? "";
  const authorize: AuthorizeKind | null =
    knownMethod === "managed_browser" && actions.includes("managed_browser_login")
      ? "managed_browser"
      : knownMethod === "oauth" && actions.includes("oauth")
        ? "oauth"
        : null;
  return {
    site,
    label: text(item.label) ?? site,
    method: knownMethod,
    state: STATES.has(state) ? (state as SiteState) : "unknown",
    authorized: flag(item.authorized),
    summary: text(item.summary) ?? "",
    updatedAt: integer(item.updated_at) ?? integer(record(item.cookies)?.updated_at),
    cookieCount: integer(record(item.cookies)?.cookie_count),
    // 旧结构只展示，不发起会改状态的操作。
    authorize: legacy ? null : authorize,
    clear: !legacy && actions.includes("clear"),
    session: activeSession(knownMethod, record(item.login), record(item.oauth)),
  };
}

export function accountsView(value: VaultStatuses | LegacyAuthStatuses): AccountsView {
  if (isVaultStatuses(value)) {
    return {
      legacy: false,
      accounts: value.items.flatMap((item) => account(item, false) ?? []),
      profileResetting: value.browser_profile.resetting,
    };
  }
  return {
    legacy: true,
    accounts: records(value.items).flatMap((item) => account(item, true) ?? []),
    profileResetting: flag(record(value.browser_profile)?.resetting),
  };
}

/** 同一时间只有一个站点能占用项目浏览器授权。 */
export function authorizingSite(view: AccountsView | null): string | null {
  return view?.accounts.find((item) => item.session !== null)?.site ?? null;
}

// ---- 站点策略 ----

export interface PolicyRow {
  readonly site: string;
  readonly label: string;
  readonly editable: boolean;
  /** 不能编辑时后端给的原因。 */
  readonly reason: string;
  readonly hasOverride: boolean;
  readonly inherited: boolean;
  readonly updatedAt: number | null;
  readonly policy: PolicyFields | null;
}

export interface PoliciesView {
  readonly legacy: boolean;
  readonly defaultPolicy: PolicyFields | null;
  readonly rows: readonly PolicyRow[];
  readonly unknownOverrides: number;
}

export function isPolicySnapshot(value: PolicyViewSnapshot | LegacySitePolicies): value is PolicyViewSnapshot {
  return "response_profile" in value && value.response_profile === "policy";
}

export function policiesView(value: PolicyViewSnapshot | LegacySitePolicies): PoliciesView {
  if (isPolicySnapshot(value)) {
    return {
      legacy: false,
      defaultPolicy: value.default.policy,
      rows: value.items.map((item) => ({
        site: item.site,
        label: item.label,
        editable: item.editable,
        reason: item.reason,
        hasOverride: item.has_override,
        inherited: item.inherited,
        updatedAt: item.updated_at,
        policy: item.policy,
      })),
      unknownOverrides: value.unknown_override_count,
    };
  }
  return {
    legacy: true,
    defaultPolicy: value.default ?? null,
    rows: (value.items ?? []).flatMap((item) =>
      item.site
        ? [
            {
              site: item.site,
              label: item.site,
              editable: false,
              reason: "",
              hasOverride: item.inherited === false,
              inherited: item.inherited !== false,
              updatedAt: item.updated_at ?? null,
              policy: item.policy ?? null,
            },
          ]
        : [],
    ),
    unknownOverrides: 0,
  };
}

export const POLICY_LIMITS = {
  max_concurrency: { min: 1, max: 128, integer: true },
  retry_limit: { min: 0, max: 20, integer: true },
  backoff_base_seconds: { min: 0, max: 3600, integer: false },
} as const;

export type PolicyNumberField = keyof typeof POLICY_LIMITS;

export interface PolicyDraft {
  readonly max_concurrency: string;
  readonly retry_limit: string;
  readonly backoff_base_seconds: string;
  readonly proxy_mode: ProxyMode;
}

export function policyDraft(policy: PolicyFields): PolicyDraft {
  return {
    max_concurrency: String(policy.max_concurrency),
    retry_limit: String(policy.retry_limit),
    backoff_base_seconds: String(policy.backoff_base_seconds),
    proxy_mode: policy.proxy_mode,
  };
}

/** 校验并转换草稿；有错时返回出错的字段。 */
export function parsePolicyDraft(draft: PolicyDraft): { policy: PolicyFields; invalid: [] } | { policy: null; invalid: PolicyNumberField[] } {
  const invalid: PolicyNumberField[] = [];
  const values = {} as Record<PolicyNumberField, number>;
  for (const field of Object.keys(POLICY_LIMITS) as PolicyNumberField[]) {
    const limits = POLICY_LIMITS[field];
    const raw = draft[field].trim();
    const value = raw === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(value) || value < limits.min || value > limits.max || (limits.integer && !Number.isInteger(value))) invalid.push(field);
    else values[field] = value;
  }
  if (invalid.length) return { policy: null, invalid };
  return { policy: { ...values, proxy_mode: draft.proxy_mode }, invalid: [] };
}

export function samePolicy(a: PolicyFields | null, b: PolicyFields | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.max_concurrency === b.max_concurrency &&
    a.retry_limit === b.retry_limit &&
    a.backoff_base_seconds === b.backoff_base_seconds &&
    a.proxy_mode === b.proxy_mode
  );
}
