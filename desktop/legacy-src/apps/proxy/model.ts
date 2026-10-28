const SOURCE_ID_PATTERNS = Object.freeze({
  subscription: /^sub_[0-9a-f]{64}$/,
  inlineNode: /^node_[0-9a-f]{64}$/,
});
const REVISION_PATTERN = /^[0-9a-f]{64}$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const INLINE_SCHEMES = new Set([
  "http", "https", "socks4", "socks5", "socks5h", "ss", "ssr", "vless", "vmess",
  "trojan", "hysteria", "hysteria2", "hy2", "tuic", "anytls", "mieru",
]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export const PROXY_STATUS_POLL_INTERVAL_MS = 10_000;
export const PROXY_STATUS_NODE_LIMIT = 500;
export const PROXY_NODE_RENDER_LIMIT = 160;
export const PROXY_SUBSCRIPTION_LIMIT = 128;
export const PROXY_INLINE_NODE_LIMIT = 512;

export type ProxyWorkspacePhase = "loading" | "idle" | "partial" | "error" | "writing";
export type ProxyOperation = "refresh" | "start" | "stop" | "reload" | "probe" | "source-write";
export type ProxySourceKind = "config" | "runtime" | "none";

export interface ProxyNode {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly tags: readonly string[];
  readonly healthy: boolean;
  readonly retryEligible: boolean;
  readonly refCount: number;
  readonly successCount: number;
  readonly failCount: number;
  readonly lastLatencyMs: number | null;
  readonly cooldownUntil: number;
  readonly lastError: string;
}

export interface ProxyStatus {
  readonly enabled: boolean;
  readonly engine: string;
  readonly managedByBackend: boolean;
  readonly autoStart: boolean;
  readonly running: boolean;
  readonly total: number;
  readonly healthy: number;
  readonly retryEligible: number;
  readonly leases: number;
  readonly lastError: string;
  readonly configuredRevision: string | null;
  readonly activeRevision: string | null;
  readonly reloadRequired: boolean;
  readonly transportCore: Readonly<{ enabled: boolean; running: boolean; listeners: number; lastError: string }>;
  readonly sourceSummary: Readonly<{
    subscriptions: number;
    sourceNodes: number;
    poolNodes: number;
    coreCandidates: number;
    coreNodes: number;
    skippedNodes: number;
    warnings: readonly string[];
  }>;
  readonly nodes: Readonly<Record<string, ProxyNode>>;
  readonly nodeOrder: readonly string[];
  readonly nodeRowsReceived: number;
  readonly nodesTruncated: boolean;
}

export interface ProxySubscription {
  readonly id: string;
  readonly source: ProxySourceKind;
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number | null;
  readonly displayUrl: string;
  readonly redacted: boolean;
}

export interface ProxyInlineNode {
  readonly id: string;
  readonly source: ProxySourceKind;
  readonly scheme: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly requiresTransportCore: boolean;
  readonly displayEndpoint: string;
}

export interface ProxySources {
  readonly source: ProxySourceKind;
  readonly hasRuntimeOverride: boolean;
  readonly runtimeOverrideValid: boolean;
  readonly configuredRevision: string | null;
  readonly activeRevision: string | null;
  readonly reloadRequired: boolean;
  readonly subscriptions: Readonly<Record<string, ProxySubscription>>;
  readonly subscriptionOrder: readonly string[];
  readonly nodeFile: Readonly<{ configured: boolean; source: ProxySourceKind; displayPath: string | null }>;
  readonly inlineNodes: Readonly<Record<string, ProxyInlineNode>>;
  readonly inlineNodeOrder: readonly string[];
  readonly counts: Readonly<{ subscriptions: number; nodeFile: number; inlineNodes: number; total: number }>;
}

export interface ProxyInputValidation<T = string> {
  readonly valid: boolean;
  readonly field: "subscription" | "node_file" | "inline_node";
  readonly reason: string;
  readonly index: number | null;
  readonly value?: T;
}

export interface ProxyErrorPresentation {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  readonly title: string;
  readonly message: string;
  readonly nextStep: string;
  readonly detail: string;
}

interface SafeRecord { readonly descriptors: PropertyDescriptorMap }

function record(value: unknown): SafeRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    return { descriptors: Object.getOwnPropertyDescriptors(value) };
  } catch {
    return null;
  }
}

function requireRecord(value: unknown, code: string): SafeRecord {
  const projected = record(value);
  if (!projected) throw new TypeError(code);
  return projected;
}

function own(value: SafeRecord, key: string): unknown {
  const descriptor = value.descriptors[key];
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function safeInteger(value: unknown, maximum = 1_000_000): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : 0;
}

function safeNumber(value: unknown, maximum = 86_400_000): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, maximum)
    : null;
}

function safeToken(value: unknown): string {
  return typeof value === "string" && RESOURCE_PATTERN.test(value.trim()) ? value.trim() : "";
}

function safeSource(value: unknown): ProxySourceKind {
  return value === "config" || value === "runtime" ? value : "none";
}

function text(value: unknown, maximum: number, fallback = ""): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const normalized = String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

function sensitiveText(value: unknown, maximum = 300): string {
  return text(value, maximum * 2)
    .replace(/\bhttps?:\/\/[^\s]+/gi, "[地址已隐藏]")
    .replace(/\b(token|cookie|password|secret|authorization|uuid)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "***")
    .replace(/(^|[\s(])(?:[A-Za-z]:[\\/]|\/)[^\s,;，；)]+/g, "$1[路径已隐藏]")
    .replace(/(^|[^A-Za-z0-9])[A-Za-z0-9_~+/=-]{32,}(?=$|[^A-Za-z0-9])/g, "$1***")
    .slice(0, maximum);
}

function safeHost(value: unknown): string {
  const host = text(value, 253);
  if (!host || /[\s/@?#\\]/.test(host)) return "";
  if (host.includes(":")) return /^[0-9a-f:.]+$/i.test(host) && host.includes(":") ? host : "";
  return /^[A-Za-z0-9._-]+$/.test(host) ? host : "";
}

function displayHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function safePort(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : 0;
}

function revision(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  return typeof value === "string" && REVISION_PATTERN.test(value) ? value : null;
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function runtimeNode(value: unknown): ProxyNode | null {
  const item = record(value);
  if (!item) return null;
  const id = safeToken(own(item, "id"));
  if (!id) return null;
  const protocol = text(own(item, "protocol"), 24, "unknown").toLowerCase();
  const rawEndpoint = text(own(item, "endpoint"), 240);
  const endpoint = rawEndpoint === "[REDACTED_PROXY]" || (
    /^[a-z][a-z0-9+.-]{0,23}:\/\/(?:\*\*\*@)?(?:\[[0-9a-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]{1,5})?$/i.test(rawEndpoint)
    && !/[?#]/.test(rawEndpoint)
  ) ? rawEndpoint : "地址已隐藏";
  const rawTags = own(item, "tags");
  const tags = Array.isArray(rawTags)
    ? [...new Set(rawTags.slice(0, 32).map((tag) => text(tag, 32).toLowerCase()).filter((tag) => tag && !/[\s/@?#\\]/.test(tag)))]
    : [];
  return Object.freeze({
    id,
    name: sensitiveText(own(item, "name"), 80) || "未命名节点",
    protocol,
    endpoint,
    tags: Object.freeze(tags),
    healthy: own(item, "healthy") === true,
    retryEligible: own(item, "retry_eligible") === true,
    refCount: safeInteger(own(item, "ref_count"), 100_000),
    successCount: safeInteger(own(item, "success_count"), 1_000_000_000),
    failCount: safeInteger(own(item, "fail_count"), 1_000_000_000),
    lastLatencyMs: safeNumber(own(item, "last_latency_ms")),
    cooldownUntil: safeNumber(own(item, "cooldown_until"), 10_000_000_000) ?? 0,
    lastError: sensitiveText(own(item, "last_error"), 300),
  });
}

export function sanitizeProxyStatus(value: unknown): ProxyStatus {
  const root = requireRecord(value, "invalid_proxy_status");
  const rawNodes = own(root, "nodes");
  const nodes = emptyRecord<ProxyNode>();
  const nodeOrder: string[] = [];
  if (Array.isArray(rawNodes)) {
    for (const raw of rawNodes.slice(0, PROXY_STATUS_NODE_LIMIT)) {
      const node = runtimeNode(raw);
      if (!node || Object.hasOwn(nodes, node.id)) continue;
      nodes[node.id] = node;
      nodeOrder.push(node.id);
    }
  }
  const total = safeInteger(own(root, "total"));
  const core = record(own(root, "transport_core"));
  const summary = record(own(root, "sources"));
  const rawWarnings = summary ? own(summary, "warnings") : null;
  return Object.freeze({
    enabled: own(root, "enabled") === true,
    engine: text(own(root, "engine"), 32, "unknown"),
    managedByBackend: own(root, "managed_by_backend") === true,
    autoStart: own(root, "auto_start") === true,
    running: own(root, "running") === true,
    total,
    healthy: Math.min(total, safeInteger(own(root, "healthy"))),
    retryEligible: Math.min(total, safeInteger(own(root, "retry_eligible"))),
    leases: safeInteger(own(root, "leases"), 1_000_000),
    lastError: sensitiveText(own(root, "last_error"), 500),
    configuredRevision: revision(own(root, "configured_revision")),
    activeRevision: revision(own(root, "active_revision"), true),
    reloadRequired: own(root, "reload_required") === true,
    transportCore: Object.freeze({
      enabled: core ? own(core, "enabled") === true : false,
      running: core ? own(core, "running") === true : false,
      listeners: core ? safeInteger(own(core, "listeners"), 100_000) : 0,
      lastError: core ? sensitiveText(own(core, "last_error")) : "",
    }),
    sourceSummary: Object.freeze({
      subscriptions: summary ? safeInteger(own(summary, "subscriptions"), PROXY_SUBSCRIPTION_LIMIT) : 0,
      sourceNodes: summary ? safeInteger(own(summary, "source_nodes")) : 0,
      poolNodes: summary ? safeInteger(own(summary, "pool_nodes")) : 0,
      coreCandidates: summary ? safeInteger(own(summary, "core_candidates")) : 0,
      coreNodes: summary ? safeInteger(own(summary, "core_nodes")) : 0,
      skippedNodes: summary ? safeInteger(own(summary, "skipped_nodes")) : 0,
      warnings: Object.freeze(Array.isArray(rawWarnings)
        ? rawWarnings.slice(0, 20).map((warning) => sensitiveText(warning)).filter(Boolean)
        : []),
    }),
    nodes: Object.freeze(nodes),
    nodeOrder: Object.freeze(nodeOrder),
    nodeRowsReceived: Array.isArray(rawNodes) ? rawNodes.length : 0,
    nodesTruncated: own(root, "node_rows_truncated") === true
      || (Array.isArray(rawNodes) && rawNodes.length > PROXY_STATUS_NODE_LIMIT),
  });
}

function subscription(value: unknown): ProxySubscription | null {
  const item = record(value);
  const rawId = item ? own(item, "id") : null;
  if (!item || typeof rawId !== "string" || !SOURCE_ID_PATTERNS.subscription.test(rawId)) return null;
  const scheme = own(item, "scheme") === "http" ? "http" : "https";
  const host = safeHost(own(item, "host"));
  const port = own(item, "port") === null ? null : safePort(own(item, "port")) || null;
  const authority = displayHost(host) ? `${displayHost(host)}${port ? `:${port}` : ""}` : "…";
  return Object.freeze({
    id: rawId,
    source: safeSource(own(item, "source")),
    scheme,
    host,
    port,
    displayUrl: `${scheme}://${authority}/…`,
    redacted: own(item, "credentials_redacted") === true || own(item, "sensitive_parts_redacted") === true,
  });
}

function inlineNode(value: unknown): ProxyInlineNode | null {
  const item = record(value);
  const rawId = item ? own(item, "id") : null;
  if (!item || typeof rawId !== "string" || !SOURCE_ID_PATTERNS.inlineNode.test(rawId)) return null;
  const scheme = text(own(item, "scheme"), 24, "unknown").toLowerCase();
  const name = sensitiveText(own(item, "name"), 80);
  const host = safeHost(own(item, "host"));
  const port = safePort(own(item, "port"));
  const authority = displayHost(host);
  return Object.freeze({
    id: rawId,
    source: safeSource(own(item, "source")),
    scheme,
    name,
    host,
    port,
    requiresTransportCore: own(item, "requires_transport_core") === true,
    displayEndpoint: `${scheme}://***${authority ? `@${authority}${port ? `:${port}` : ""}` : ""}${name ? `#${name}` : ""}`,
  });
}

function safeDisplayPath(value: unknown): string | null {
  const path = text(value, 240);
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").includes("..")
    ? "路径已隐藏"
    : normalized;
}

export function sanitizeProxySources(value: unknown): ProxySources {
  const root = requireRecord(value, "invalid_proxy_sources");
  const subscriptions = emptyRecord<ProxySubscription>();
  const subscriptionOrder: string[] = [];
  const rawSubscriptions = own(root, "subscriptions");
  if (Array.isArray(rawSubscriptions)) {
    for (const raw of rawSubscriptions.slice(0, PROXY_SUBSCRIPTION_LIMIT)) {
      const item = subscription(raw);
      if (!item || Object.hasOwn(subscriptions, item.id)) continue;
      subscriptions[item.id] = item;
      subscriptionOrder.push(item.id);
    }
  }
  const inlineNodes = emptyRecord<ProxyInlineNode>();
  const inlineNodeOrder: string[] = [];
  const rawInline = own(root, "inline_nodes");
  if (Array.isArray(rawInline)) {
    for (const raw of rawInline.slice(0, PROXY_INLINE_NODE_LIMIT)) {
      const item = inlineNode(raw);
      if (!item || Object.hasOwn(inlineNodes, item.id)) continue;
      inlineNodes[item.id] = item;
      inlineNodeOrder.push(item.id);
    }
  }
  const nodeFile = record(own(root, "node_file"));
  const counts = record(own(root, "counts"));
  return Object.freeze({
    source: safeSource(own(root, "source")),
    hasRuntimeOverride: own(root, "has_runtime_override") === true,
    runtimeOverrideValid: own(root, "runtime_override_valid") === true,
    configuredRevision: revision(own(root, "configured_revision")),
    activeRevision: revision(own(root, "active_revision"), true),
    reloadRequired: own(root, "reload_required") === true,
    subscriptions: Object.freeze(subscriptions),
    subscriptionOrder: Object.freeze(subscriptionOrder),
    nodeFile: Object.freeze({
      configured: nodeFile ? own(nodeFile, "configured") === true : false,
      source: nodeFile ? safeSource(own(nodeFile, "source")) : "none",
      displayPath: nodeFile ? safeDisplayPath(own(nodeFile, "display_path")) : null,
    }),
    inlineNodes: Object.freeze(inlineNodes),
    inlineNodeOrder: Object.freeze(inlineNodeOrder),
    counts: Object.freeze({
      subscriptions: counts ? safeInteger(own(counts, "subscriptions"), PROXY_SUBSCRIPTION_LIMIT) : 0,
      nodeFile: counts ? safeInteger(own(counts, "node_file"), 1) : 0,
      inlineNodes: counts ? safeInteger(own(counts, "inline_nodes"), PROXY_INLINE_NODE_LIMIT) : 0,
      total: counts ? safeInteger(own(counts, "total"), PROXY_SUBSCRIPTION_LIMIT + PROXY_INLINE_NODE_LIMIT + 1) : 0,
    }),
  });
}

function invalid(field: ProxyInputValidation["field"], reason: string, index: number | null = null): ProxyInputValidation {
  return Object.freeze({ valid: false, field, reason, index });
}

function valid<T extends string | readonly string[]>(field: ProxyInputValidation["field"], value: T): ProxyInputValidation<T> {
  return Object.freeze({ valid: true, field, reason: "", index: null, value });
}

function singleLine(value: unknown, field: "subscription" | "node_file", maximum = 4096): ProxyInputValidation {
  if (typeof value !== "string") return invalid(field, "invalid_type");
  const normalized = value.trim();
  if (!normalized) return invalid(field, "empty");
  if (normalized.length > maximum) return invalid(field, "too_long");
  if (CONTROL_CHARACTERS.test(normalized)) return invalid(field, "control_character");
  return valid(field, normalized);
}

export function validateSubscriptionInput(value: unknown): ProxyInputValidation {
  const base = singleLine(value, "subscription");
  if (!base.valid) return base;
  try {
    const parsed = new URL(base.value as string);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return invalid("subscription", "unsupported_scheme");
    if (!parsed.hostname) return invalid("subscription", "missing_host");
  } catch {
    return invalid("subscription", "malformed");
  }
  return base;
}

export function validateNodeFileInput(value: unknown): ProxyInputValidation {
  return singleLine(value, "node_file");
}

export function validateInlineNodeInput(value: unknown, multiple = false): ProxyInputValidation<string | readonly string[]> {
  if (typeof value !== "string") return invalid("inline_node", "invalid_type");
  if (!value.trim()) return invalid("inline_node", "empty", multiple ? 0 : null);
  if (value.length > 2 * 1024 * 1024) return invalid("inline_node", "total_too_large");
  const nodes: string[] = [];
  for (const [index, raw] of (multiple ? value.split(/\r?\n/) : [value]).entries()) {
    const node = raw.trim();
    if (!node) continue;
    if (node.length > 16 * 1024) return invalid("inline_node", "too_long", index);
    if (CONTROL_CHARACTERS.test(node)) return invalid("inline_node", "control_character", index);
    const separator = node.indexOf(":");
    if (!INLINE_SCHEMES.has(separator > 0 ? node.slice(0, separator).toLowerCase() : "")) {
      return invalid("inline_node", "unsupported_scheme", index);
    }
    nodes.push(node);
  }
  if (!nodes.length) return invalid("inline_node", "empty", 0);
  if (nodes.length > PROXY_INLINE_NODE_LIMIT) return invalid("inline_node", "too_many");
  return valid("inline_node", multiple ? Object.freeze(nodes) : nodes[0]);
}

export function proxyControls(status: ProxyStatus | null, busy: ProxyOperation | "") {
  const blocked = Boolean(busy);
  const leases = status?.leases ?? 0;
  return Object.freeze({
    refresh: blocked,
    start: blocked || !status || !status.enabled || status.running || leases > 0,
    stop: blocked || !status?.running || leases > 0,
    reload: blocked || !status?.enabled || leases > 0 || !status.reloadRequired,
    probe: blocked || !status?.enabled || !status.running,
  });
}

export function proxyWorkspace(status: ProxyStatus | null, sources: ProxySources | null, phase: ProxyWorkspacePhase) {
  if (phase === "writing") return Object.freeze({ kind: "running", label: "正在写入", message: "完成后将权威重读运行状态和节点来源。" });
  if (phase === "error" && !status && !sources) return Object.freeze({ kind: "error", label: "代理工作区读取失败", message: "未获得可显示的运行状态或节点来源。" });
  if (!status && !sources) return Object.freeze({ kind: "running", label: "正在加载", message: "正在读取代理运行状态和节点来源。" });
  if (!status || !sources || phase === "partial") return Object.freeze({ kind: "warning", label: "部分信息不可用", message: "保留已取得的安全事实；请刷新补齐。" });
  if (!status.enabled) return Object.freeze({ kind: "disabled", label: "代理池已停用", message: "节点来源仍可查看和保存。" });
  if (status.reloadRequired || sources.reloadRequired) return Object.freeze({ kind: "warning", label: "有配置待应用", message: "节点来源已保存，但当前运行池尚未应用。" });
  return status.running
    ? Object.freeze({ kind: "running", label: "代理池运行中", message: "状态来自服务端权威读取。" })
    : Object.freeze({ kind: "warning", label: "代理池已停止", message: "可在运行池控制栏启动代理池。" });
}

export function proxyErrorPresentation(error: unknown): ProxyErrorPresentation {
  const source = error instanceof Error ? { descriptors: Object.getOwnPropertyDescriptors(error) } : record(error);
  const code = safeToken(source ? own(source, "code") : null) || "request_failed";
  const rawStatus = source ? own(source, "status") : 0;
  const status = Number.isInteger(rawStatus) ? Number(rawStatus) : 0;
  const requestId = safeToken(source ? own(source, "requestId") : null);
  const details = source ? record(own(source, "details")) : null;
  const reason = details && typeof own(details, "reason") === "string" && /^[a-z0-9_.:-]{1,64}$/i.test(String(own(details, "reason")))
    ? String(own(details, "reason"))
    : "";
  const rawIndex = details ? own(details, "index") : null;
  const index = Number.isInteger(rawIndex) && Number(rawIndex) >= 0 && Number(rawIndex) < PROXY_INLINE_NODE_LIMIT
    ? Number(rawIndex)
    : null;
  const nextSteps: Readonly<Record<string, string>> = Object.freeze({
    proxy_conflict: "请等待正在使用代理的任务结束，再刷新后重试。",
    invalid_proxy_subscription: "请输入包含主机名的完整 http:// 或 https:// 订阅地址。",
    invalid_proxy_inline_node: "请按提示修正节点格式后重试。",
    invalid_proxy_node_file: "请选择允许目录中的普通节点文件。",
    invalid_proxy_source_id: "该列表项已失效，请刷新代理源后重试。",
    proxy_source_path_forbidden: "请把节点文件放入服务配置的允许目录。",
    proxy_source_not_found: "该代理源可能已被删除，请刷新列表。",
    proxy_sources_store_error: "请刷新，必要时恢复配置文件默认值。",
    network_error: "请确认服务仍在运行，连接恢复后刷新。",
  });
  return Object.freeze({
    code,
    status,
    requestId,
    title: status === 409 ? "代理状态冲突" : status === 422 ? "代理输入无效" : "代理操作失败",
    message: status === 0 ? "无法连接到 LDOS 服务。" : "服务未接受本次代理操作。",
    nextStep: nextSteps[code] ?? (status === 413 ? "请减少本次节点数量后分批提交。" : "请刷新状态后重试。"),
    detail: index !== null ? `第 ${index + 1} 行${reason ? `：${reason}` : ""}` : reason ? `原因：${reason}` : "",
  });
}
