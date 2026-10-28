const SITE_ORDER = Object.freeze(["danbooru", "twitter", "pixiv", "exhentai", "pawchive"] as const);

export const POLICY_SITE_IDS = SITE_ORDER;
export const POLICY_REQUEST_MAX_BYTES = 16 * 1024;

export type PolicySiteId = typeof SITE_ORDER[number];
export type PolicyAuthorization = "anonymous" | "managed_browser" | "oauth" | "managed_browser_for_private_content";
export type PolicyProxyMode = "direct" | "prefer" | "required";
export type PolicyPhase = "loading" | "idle" | "saving" | "saved" | "partial" | "error";

export interface PolicySiteDefinition {
  readonly id: PolicySiteId;
  readonly label: string;
  readonly mark: string;
  readonly authorization: PolicyAuthorization;
}

export interface PolicyConfig {
  readonly max_concurrency: number;
  readonly retry_limit: number;
  readonly backoff_base_seconds: number;
  readonly proxy_mode: PolicyProxyMode;
}

export interface PolicyDraft {
  max_concurrency: string;
  retry_limit: string;
  backoff_base_seconds: string;
  proxy_mode: PolicyProxyMode;
}

export interface PolicyItem {
  readonly site: PolicySiteId;
  readonly label: string;
  readonly mark: string;
  readonly supported: boolean;
  readonly authorization: PolicyAuthorization;
  readonly selectionMode: "per_request";
  readonly availability: "not_probed";
  readonly inherited: boolean;
  readonly hasOverride: boolean;
  readonly editable: boolean;
  readonly reason: string;
  readonly updatedAt: number | null;
  readonly policy: PolicyConfig | null;
}

export interface PolicySnapshot {
  readonly sites: Readonly<Record<PolicySiteId, PolicyItem>>;
  readonly siteOrder: readonly PolicySiteId[];
  readonly defaultPolicy: PolicyConfig | null;
  readonly defaultEditable: boolean;
  readonly defaultReason: string;
  readonly effectScope: "new_requests_and_tasks";
  readonly concurrencyProtection: "none";
  readonly defaultSource: "startup_snapshot";
  readonly persistence: "sqlite_atomic";
  readonly unknownOverrideCount: number;
}

export interface PolicyValidation {
  readonly valid: boolean;
  readonly payload: Readonly<PolicyConfig> | null;
  readonly field: "policy" | keyof PolicyDraft | "";
  readonly reason: string;
}

export interface PolicyErrorPresentation {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly message: string;
  readonly nextStep: string;
  readonly detail: string;
  readonly requestId: string;
  readonly conflict: boolean;
}

export interface PolicyControl {
  readonly disabled: boolean;
  readonly reason: string;
  readonly label: string;
}

export interface PolicyControls {
  readonly save: PolicyControl;
  readonly reset: PolicyControl;
  readonly siteSelect: PolicyControl;
}

export interface PolicyWorkspacePresentation {
  readonly state: "loading" | "ready" | "saved" | "dirty" | "invalid" | "saving" | "readonly" | "partial" | "error";
  readonly kind: "ready" | "running" | "warning" | "error" | "disabled";
  readonly label: string;
  readonly message: string;
}
export interface PolicySourcePresentation {
  readonly badge: Readonly<{ status: "ready" | "running" | "error" | "disabled"; label: string }>;
  readonly policyState: string;
}

const DEFINITIONS: Readonly<Record<PolicySiteId, PolicySiteDefinition>> = Object.freeze({
  danbooru: Object.freeze({ id: "danbooru", label: "Danbooru", mark: "D", authorization: "anonymous" }),
  twitter: Object.freeze({ id: "twitter", label: "X / Twitter", mark: "X", authorization: "managed_browser" }),
  pixiv: Object.freeze({ id: "pixiv", label: "Pixiv", mark: "P", authorization: "oauth" }),
  exhentai: Object.freeze({ id: "exhentai", label: "EH", mark: "EH", authorization: "managed_browser_for_private_content" }),
  pawchive: Object.freeze({ id: "pawchive", label: "Pawchive", mark: "PA", authorization: "anonymous" }),
});

const CONFIG_KEYS = Object.freeze(["max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode"] as const);
const CONFIG_KEY_SET = new Set<string>(CONFIG_KEYS);
const PROXY_MODES = new Set<PolicyProxyMode>(["direct", "prefer", "required"]);
const ITEM_REASONS = new Set(["", "unsafe_default_policy", "unsafe_stored_policy", "missing_source", "invalid_response"]);
const EFFECT_SCOPES = new Set(["new_requests_and_tasks"]);
const CONCURRENCY_PROTECTIONS = new Set(["none"]);
const DEFAULT_SOURCES = new Set(["startup_snapshot"]);
const PERSISTENCE_KINDS = new Set(["sqlite_atomic"]);
export const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const SAFE_DETAIL_FIELDS = new Set<string>([...CONFIG_KEYS, "policy"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TIMESTAMP = 4_102_444_800;

const NUMERIC_RULES = Object.freeze({
  max_concurrency: Object.freeze({ minimum: 1, maximum: 128, integer: true }),
  retry_limit: Object.freeze({ minimum: 0, maximum: 20, integer: true }),
  backoff_base_seconds: Object.freeze({ minimum: 0, maximum: 3600, integer: false }),
});

const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  policy: "站点设置",
  max_concurrency: "最大并发数",
  retry_limit: "重试次数",
  backoff_base_seconds: "首次重试等待",
  proxy_mode: "连接方式",
});

export class PolicyValidationError extends TypeError {
  readonly code = "invalid_policy_draft";
  readonly status = 0;
  readonly field: PolicyValidation["field"];
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`${FIELD_LABELS[field] ?? "站点设置"}无效`);
    this.name = "PolicyValidationError";
    this.field = CONFIG_KEY_SET.has(field) ? field as PolicyValidation["field"] : "policy";
    this.reason = /^[A-Za-z0-9._:-]{1,64}$/.test(reason) ? reason : "invalid_value";
  }
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Object.hasOwn(descriptor, "value")) result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  const record = safeRecord(value);
  if (!record) throw new TypeError(code);
  return record;
}

function own(record: Record<string, unknown> | null, key: string): unknown {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function hasDangerousKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => DANGEROUS_KEYS.has(key));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP ? value : null;
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value.trim()) ? value.trim() : "request_failed";
}

function safeRequestId(value: unknown): string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value.trim()) ? value.trim() : "";
}

function normalizeNumber(value: unknown, field: keyof typeof NUMERIC_RULES, allowString: boolean): number {
  const rule = NUMERIC_RULES[field];
  const number = allowString && typeof value === "string" ? (value.trim() ? Number(value) : Number.NaN) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) throw new PolicyValidationError(field, "not_number");
  if (rule.integer && !Number.isInteger(number)) throw new PolicyValidationError(field, "not_integer");
  if (number < rule.minimum || number > rule.maximum) throw new PolicyValidationError(field, "out_of_range");
  return number;
}

function normalizePolicy(value: unknown, allowString = false): PolicyConfig {
  const policy = requireRecord(value, "invalid_policy");
  if (hasDangerousKey(policy) || !hasOnlyKeys(policy, CONFIG_KEY_SET)) throw new PolicyValidationError("policy", "unknown_field");
  for (const key of CONFIG_KEYS) if (!Object.hasOwn(policy, key)) throw new PolicyValidationError(key, "missing_field");
  const proxyMode = own(policy, "proxy_mode");
  if (typeof proxyMode !== "string" || !PROXY_MODES.has(proxyMode as PolicyProxyMode)) throw new PolicyValidationError("proxy_mode", "invalid_enum");
  return Object.freeze({
    max_concurrency: normalizeNumber(own(policy, "max_concurrency"), "max_concurrency", allowString),
    retry_limit: normalizeNumber(own(policy, "retry_limit"), "retry_limit", allowString),
    backoff_base_seconds: normalizeNumber(own(policy, "backoff_base_seconds"), "backoff_base_seconds", allowString),
    proxy_mode: proxyMode as PolicyProxyMode,
  });
}

function safePolicyState(value: unknown, fallback: string): { editable: boolean; reason: string; policy: PolicyConfig | null } {
  const state = safeRecord(value);
  if (!state || hasDangerousKey(state)) return { editable: false, reason: fallback, policy: null };
  const requestedEditable = own(state, "editable") === true;
  let policy: PolicyConfig | null = null;
  if (requestedEditable) {
    try { policy = normalizePolicy(own(state, "policy")); } catch { policy = null; }
  }
  const reasonValue = own(state, "reason");
  const reason = typeof reasonValue === "string" && ITEM_REASONS.has(reasonValue) && reasonValue ? reasonValue : fallback;
  return { editable: Boolean(requestedEditable && policy), reason: requestedEditable && policy ? "" : reason, policy };
}

function unavailableItem(site: PolicySiteId): PolicyItem {
  const definition = DEFINITIONS[site];
  return Object.freeze({
    site,
    label: definition.label,
    mark: definition.mark,
    supported: true,
    authorization: definition.authorization,
    selectionMode: "per_request",
    availability: "not_probed",
    inherited: true,
    hasOverride: false,
    editable: false,
    reason: "missing_source",
    updatedAt: null,
    policy: null,
  });
}

function sanitizeItem(value: unknown): PolicyItem | null {
  const item = safeRecord(value);
  if (!item || hasDangerousKey(item)) return null;
  const site = own(item, "site");
  if (typeof site !== "string" || !Object.hasOwn(DEFINITIONS, site)) return null;
  const definition = DEFINITIONS[site as PolicySiteId];
  if (own(item, "label") !== definition.label || own(item, "authorization") !== definition.authorization) return null;
  const supported = own(item, "supported") === true;
  const selectionMode = own(item, "selection_mode");
  const availability = own(item, "availability");
  const inherited = own(item, "inherited");
  const hasOverride = own(item, "has_override");
  const state = safePolicyState({ editable: own(item, "editable"), reason: own(item, "reason"), policy: own(item, "policy") }, "invalid_response");
  const shapeValid = supported && selectionMode === "per_request" && availability === "not_probed" && typeof inherited === "boolean" && typeof hasOverride === "boolean" && inherited !== hasOverride;
  return Object.freeze({
    site: definition.id,
    label: definition.label,
    mark: definition.mark,
    supported,
    authorization: definition.authorization,
    selectionMode: "per_request",
    availability: "not_probed",
    inherited: inherited === true,
    hasOverride: hasOverride === true,
    editable: Boolean(shapeValid && state.editable),
    reason: shapeValid && state.editable ? "" : state.reason,
    updatedAt: inherited === true ? null : safeTimestamp(own(item, "updated_at")),
    policy: shapeValid ? state.policy : null,
  });
}

export function sanitizePolicyResponse(value: unknown): PolicySnapshot {
  const response = requireRecord(value, "invalid_policy_response");
  if (
    hasDangerousKey(response)
    || own(response, "response_profile") !== "policy"
    || own(response, "secrets_exposed") !== false
    || !EFFECT_SCOPES.has(own(response, "effect_scope") as string)
    || !CONCURRENCY_PROTECTIONS.has(own(response, "concurrency_protection") as string)
    || !DEFAULT_SOURCES.has(own(response, "default_source") as string)
    || !PERSISTENCE_KINDS.has(own(response, "persistence") as string)
    || !Array.isArray(own(response, "items"))
  ) throw new TypeError("invalid_policy_response");
  const defaultState = safePolicyState(own(response, "default"), "unsafe_default_policy");
  const sites = Object.create(null) as Record<PolicySiteId, PolicyItem>;
  const items = own(response, "items");
  let ignored = 0;
  if (Array.isArray(items)) {
    for (const raw of items.slice(0, SITE_ORDER.length * 3)) {
      const item = sanitizeItem(raw);
      if (!item || Object.hasOwn(sites, item.site)) { ignored += 1; continue; }
      sites[item.site] = item;
    }
  }
  for (const site of SITE_ORDER) if (!Object.hasOwn(sites, site)) sites[site] = unavailableItem(site);
  const unknown = own(response, "unknown_override_count");
  const unknownCount = typeof unknown === "number" && Number.isInteger(unknown) && unknown >= 0 ? Math.min(unknown, 1_000_000) : 0;
  return Object.freeze({
    sites: Object.freeze(sites),
    siteOrder: Object.freeze([...SITE_ORDER]),
    defaultPolicy: defaultState.policy,
    defaultEditable: defaultState.editable,
    defaultReason: defaultState.reason,
    effectScope: "new_requests_and_tasks",
    concurrencyProtection: "none",
    defaultSource: "startup_snapshot",
    persistence: "sqlite_atomic",
    unknownOverrideCount: Math.min(1_000_000, unknownCount + ignored),
  });
}

const SNAPSHOT_KEYS = new Set(["sites", "siteOrder", "defaultPolicy", "defaultEditable", "defaultReason", "effectScope", "concurrencyProtection", "defaultSource", "persistence", "unknownOverrideCount"]);
const ITEM_KEYS = new Set(["site", "label", "mark", "supported", "authorization", "selectionMode", "availability", "inherited", "hasOverride", "editable", "reason", "updatedAt", "policy"]);

export function validatePolicySnapshot(value: unknown): PolicySnapshot {
  const snapshot = requireRecord(value, "invalid_policy_snapshot");
  if (!hasOnlyKeys(snapshot, SNAPSHOT_KEYS)) throw new TypeError("invalid_policy_snapshot");
  const order = own(snapshot, "siteOrder");
  const sites = requireRecord(own(snapshot, "sites"), "invalid_policy_snapshot");
  if (!Array.isArray(order) || order.length !== SITE_ORDER.length || order.some((site, index) => site !== SITE_ORDER[index]) || Object.keys(sites).length !== SITE_ORDER.length) throw new TypeError("invalid_policy_snapshot");
  for (const site of SITE_ORDER) {
    if (!Object.hasOwn(sites, site)) throw new TypeError("invalid_policy_snapshot");
    const item = requireRecord(sites[site], "invalid_policy_item");
    if (!hasOnlyKeys(item, ITEM_KEYS) || item.site !== site || item.label !== DEFINITIONS[site].label || item.mark !== DEFINITIONS[site].mark || item.authorization !== DEFINITIONS[site].authorization) throw new TypeError("invalid_policy_item");
    if (typeof item.supported !== "boolean" || typeof item.inherited !== "boolean" || typeof item.hasOverride !== "boolean" || typeof item.editable !== "boolean" || item.inherited === item.hasOverride || item.selectionMode !== "per_request" || item.availability !== "not_probed" || typeof item.reason !== "string" || !ITEM_REASONS.has(item.reason) || (item.updatedAt !== null && safeTimestamp(item.updatedAt) === null)) throw new TypeError("invalid_policy_item");
    if (item.policy !== null) normalizePolicy(item.policy);
    if (item.editable !== Boolean(item.policy)) throw new TypeError("invalid_policy_item");
  }
  if (own(snapshot, "defaultPolicy") !== null) normalizePolicy(own(snapshot, "defaultPolicy"));
  if (typeof own(snapshot, "defaultEditable") !== "boolean" || own(snapshot, "defaultEditable") !== Boolean(own(snapshot, "defaultPolicy")) || typeof own(snapshot, "defaultReason") !== "string" || !ITEM_REASONS.has(own(snapshot, "defaultReason") as string) || !EFFECT_SCOPES.has(own(snapshot, "effectScope") as string) || !CONCURRENCY_PROTECTIONS.has(own(snapshot, "concurrencyProtection") as string) || !DEFAULT_SOURCES.has(own(snapshot, "defaultSource") as string) || !PERSISTENCE_KINDS.has(own(snapshot, "persistence") as string) || typeof own(snapshot, "unknownOverrideCount") !== "number" || !Number.isInteger(own(snapshot, "unknownOverrideCount")) || (own(snapshot, "unknownOverrideCount") as number) < 0 || (own(snapshot, "unknownOverrideCount") as number) > 1_000_000) throw new TypeError("invalid_policy_snapshot");
  return value as PolicySnapshot;
}

export function getPolicySiteDefinition(site: PolicySiteId | string): PolicySiteDefinition | null {
  return Object.hasOwn(DEFINITIONS, site) ? DEFINITIONS[site as PolicySiteId] : null;
}

export function policySiteItems(snapshot: PolicySnapshot | null): readonly { definition: PolicySiteDefinition; item: PolicyItem | null }[] {
  return Object.freeze(SITE_ORDER.map((site) => Object.freeze({ definition: DEFINITIONS[site], item: snapshot?.sites[site] ?? null })));
}

export function emptyPolicyDraft(): PolicyDraft {
  return { max_concurrency: "", retry_limit: "", backoff_base_seconds: "", proxy_mode: "prefer" };
}

export function policyConfigToDraft(config: PolicyConfig): PolicyDraft {
  const normalized = normalizePolicy(config);
  return {
    max_concurrency: String(normalized.max_concurrency),
    retry_limit: String(normalized.retry_limit),
    backoff_base_seconds: String(normalized.backoff_base_seconds),
    proxy_mode: normalized.proxy_mode,
  };
}

export function buildPolicyPayload(draft: PolicyDraft): PolicyConfig {
  const payload = normalizePolicy(draft, true);
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > POLICY_REQUEST_MAX_BYTES) throw new PolicyValidationError("policy", "request_too_large");
  return payload;
}

function canonicalPolicyJson(config: PolicyConfig): string {
  const normalized = normalizePolicy(config);
  return JSON.stringify(CONFIG_KEYS.map((key) => [key, normalized[key]]));
}

export function policyConfigsEqual(left: PolicyConfig, right: PolicyConfig): boolean {
  try { return canonicalPolicyJson(left) === canonicalPolicyJson(right); } catch { return false; }
}

export function isPolicyDirty(current: PolicyConfig | null, draft: PolicyDraft): boolean {
  if (!current) return false;
  try { return !policyConfigsEqual(current, buildPolicyPayload(draft)); } catch { return true; }
}

export function validatePolicyDraft(draft: PolicyDraft): PolicyValidation {
  try {
    return Object.freeze({ valid: true, payload: Object.freeze(buildPolicyPayload(draft)), field: "", reason: "" });
  } catch (error) {
    const validation = error instanceof PolicyValidationError ? error : new PolicyValidationError("policy", "invalid_value");
    return Object.freeze({ valid: false, payload: null, field: validation.field, reason: validation.reason });
  }
}

function control(disabled: boolean, reason: string, label: string): PolicyControl {
  return Object.freeze({ disabled, reason: disabled ? reason : "", label });
}

export function derivePolicyControls(item: PolicyItem | null, { busy = "", dirty = false, valid = true }: { readonly busy?: string; readonly dirty?: boolean; readonly valid?: boolean } = {}): PolicyControls {
  const busyReason = "请等待当前操作完成";
  const saveReason = busy ? busyReason : !item ? "请先等待设置加载" : !item.editable ? "当前站点设置暂时无法编辑" : !valid ? "请先修正填写内容" : !dirty ? "当前内容没有变化" : "";
  const resetReason = busy ? busyReason : !item ? "请先等待设置加载" : !item.hasOverride && !dirty ? "当前已使用默认设置" : "";
  return Object.freeze({
    save: control(Boolean(saveReason), saveReason, busy === "save" ? "正在保存…" : "保存设置"),
    reset: control(Boolean(resetReason), resetReason, busy === "reset" ? "正在恢复…" : "恢复默认设置"),
    siteSelect: control(Boolean(busy), busyReason, "切换站点"),
  });
}

function presentation(state: PolicyWorkspacePresentation["state"], kind: PolicyWorkspacePresentation["kind"], label: string, message: string): PolicyWorkspacePresentation {
  return Object.freeze({ state, kind, label, message });
}

export function derivePolicyWorkspacePresentation({ snapshot = null, item = null, phase = "idle", busy = "", dirty = false, valid = true }: { readonly snapshot?: PolicySnapshot | null; readonly item?: PolicyItem | null; readonly phase?: PolicyPhase; readonly busy?: string; readonly dirty?: boolean; readonly valid?: boolean } = {}): PolicyWorkspacePresentation {
  if (busy || phase === "saving") return presentation("saving", "running", busy === "reset" ? "正在恢复默认设置" : "正在保存设置", "操作完成并重新读取权威设置前，请勿关闭窗口。");
  if (phase === "partial") return presentation("partial", "warning", "保存结果待确认", "写入已经完成，但尚未重新读取到权威设置；草稿仍保留。");
  if (phase === "error") return presentation("error", "error", "站点设置操作失败", "页面没有采用未确认的数据；草稿仍保留，可检查后重试。");
  if (!snapshot) return presentation("loading", "running", "正在加载站点设置", "正在读取五个站点的完整设置快照。");
  if (!item?.editable || !item.policy) return presentation("readonly", "error", "当前站点只读", item?.hasOverride ? "当前自定义设置无法安全读取；仍可删除覆盖并恢复默认设置。" : "当前设置无法安全读取，页面不会猜测或提交替代值。");
  if (!valid) return presentation("invalid", "error", "草稿需要修正", "标记字段不符合允许范围，保存请求尚未发送。");
  if (dirty) return presentation("dirty", "warning", "有未保存的更改", "切换站点、离开应用、最小化或关闭窗口前会要求确认。");
  if (phase === "saved") return presentation("saved", "ready", "设置已保存", "服务已返回最新权威设置，后续新建请求与任务将采用它。");
  return presentation("ready", "ready", item.hasOverride ? "自定义设置已加载" : "默认设置已加载", item.hasOverride ? "当前站点使用单独保存的四字段设置。" : "当前站点继承服务默认的四字段设置。");
}

export function derivePolicyEditorPresentation(item: PolicyItem | null): Readonly<{ source: string; message: string; scope: string }> {
  if (!item) return Object.freeze({ source: "等待设置来源", message: "站点设置尚未加载。", scope: "尚未确定影响范围。" });
  return Object.freeze({
    source: item.hasOverride ? "站点自定义覆盖" : "继承服务默认设置",
    message: !item.editable ? item.hasOverride ? "自定义设置包含无法安全采用的内容，因此编辑器保持只读。" : "服务没有提供可安全编辑的完整四字段设置，因此编辑器保持只读。" : item.hasOverride ? "四个字段均来自该站点单独保存的设置。" : "四个字段均来自当前服务默认设置；首次保存会建立站点覆盖。",
    scope: "保存或恢复只影响后续新建的搜索请求与采集任务；既有任务不变。",
  });
}

export function formatPolicySource(item: PolicyItem | null): PolicySourcePresentation {
  if (!item) return Object.freeze({ badge: Object.freeze({ status: "disabled", label: "正在加载" }), policyState: "正在加载" });
  const badge: PolicySourcePresentation["badge"] = !item.editable
    ? Object.freeze({ status: "error", label: "暂时无法设置" })
    : item.hasOverride
      ? Object.freeze({ status: "running", label: "自定义设置" })
      : Object.freeze({ status: "ready", label: "默认设置" });
  return Object.freeze({ badge, policyState: item.hasOverride ? "使用自定义设置" : "使用默认设置" });
}

function errorField(error: unknown, key: string): unknown {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
}

export function safePolicyErrorDetail(error: unknown): string {
  const rawDetails = errorField(error, "details");
  const raw = Array.isArray(rawDetails) ? rawDetails[0] : rawDetails;
  const detail = safeRecord(raw);
  if (!detail) return "";
  const field = typeof own(detail, "field") === "string" && SAFE_DETAIL_FIELDS.has(own(detail, "field") as string) ? own(detail, "field") as string : "";
  const reason = typeof own(detail, "reason") === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(own(detail, "reason") as string) ? own(detail, "reason") as string : "";
  if (!field && !reason) return "";
  return [field ? FIELD_LABELS[field] ?? "站点设置" : "", reason ? ({ less_than_equal: "超过允许范围", greater_than_equal: "小于允许范围", int_type: "需要填写整数", int_parsing: "需要填写整数", invalid_policy: "内容不正确" } as Record<string, string>)[reason] ?? "内容不正确" : ""].filter(Boolean).join("：");
}

const ERROR_GUIDANCE: Readonly<Record<string, Readonly<{ title: string; message: string; nextStep: string }>>> = Object.freeze({
  invalid_policy: Object.freeze({ title: "设置有误", message: "服务未接受本次站点设置。", nextStep: "请检查标出的项目后再保存。" }),
  invalid_policy_draft: Object.freeze({ title: "请修正设置", message: "更改尚未发送。", nextStep: "请修正标出的项目后再保存。" }),
  unsupported_policy_site: Object.freeze({ title: "该站点不支持自定义设置", message: "当前版本不支持修改该站点。", nextStep: "请刷新页面；如果仍然出现，请更新服务和界面版本。" }),
  site_policy_not_found: Object.freeze({ title: "已使用默认设置", message: "该站点没有单独保存的设置。", nextStep: "请刷新站点设置。" }),
  policy_request_too_large: Object.freeze({ title: "提交内容太大", message: "服务拒绝了异常大的设置请求。", nextStep: "请刷新页面后重试。" }),
  policy_store_error: Object.freeze({ title: "暂时无法保存设置", message: "服务未确认本次修改已保存。", nextStep: "修改已保留，请稍后重试。" }),
  invalid_content_length: Object.freeze({ title: "请求格式不正确", message: "服务未接受请求大小信息。", nextStep: "请刷新页面后重试。" }),
  network_error: Object.freeze({ title: "无法连接服务", message: "站点设置无法连接到 LDOS 服务。", nextStep: "请确认服务正在运行，然后重试。" }),
  invalid_response: Object.freeze({ title: "设置数据无效", message: "页面未采用格式无效的服务数据。", nextStep: "请刷新页面；如果仍然出现，请更新服务和界面版本。" }),
});

export function policyErrorPresentation(error: unknown): PolicyErrorPresentation {
  let code = safeErrorCode(errorField(error, "code"));
  if (code === "request_failed" && error instanceof PolicyValidationError) code = "invalid_policy_draft";
  if (code === "request_failed" && error instanceof TypeError) code = "invalid_response";
  const status = typeof errorField(error, "status") === "number" && Number.isInteger(errorField(error, "status")) ? errorField(error, "status") as number : 0;
  const guidance = ERROR_GUIDANCE[code] ?? (status === 401 || status === 403 ? { title: "访问被拒绝", message: "本次站点设置请求未通过。", nextStep: "请从 LDOS 桌面重新打开。" } : status === 409 ? { title: "设置已更新", message: "服务未接受本次修改。", nextStep: "请刷新最新设置，核对后重新保存。" } : status === 413 ? ERROR_GUIDANCE.policy_request_too_large : status === 422 ? ERROR_GUIDANCE.invalid_policy : status >= 500 ? { title: "服务暂时不可用", message: "本次站点设置没有完成。", nextStep: "修改已保留，请稍后重试。" } : { title: "操作失败", message: "本次站点设置没有完成。", nextStep: "请稍后重试。" });
  return Object.freeze({ code, status, title: guidance.title, message: guidance.message, nextStep: guidance.nextStep, detail: safePolicyErrorDetail(error), requestId: safeRequestId(errorField(error, "requestId")), conflict: status === 409 });
}
export const policyErrorGuidance = policyErrorPresentation;

export function createPolicyRequestGate() {
  let lifecycle = 0;
  let write = 0;
  let read = 0;
  return Object.freeze({
    advanceLifecycle() { lifecycle += 1; },
    beginRead() { read += 1; return Object.freeze({ lifecycle, write, read }); },
    beginWrite() { write += 1; return Object.freeze({ lifecycle, write }); },
    isReadCurrent(ticket: { lifecycle: number; write: number; read: number } | null) { return Boolean(ticket && ticket.lifecycle === lifecycle && ticket.write === write && ticket.read === read); },
    isWriteCurrent(ticket: { lifecycle: number; write: number } | null) { return Boolean(ticket && ticket.lifecycle === lifecycle && ticket.write === write); },
  });
}

export function mergePolicySite(snapshot: PolicySnapshot, site: PolicyItem): PolicySnapshot {
  if (!snapshot.sites[site.site]) throw new TypeError("invalid_policy_site");
  return Object.freeze({ ...snapshot, sites: Object.freeze({ ...snapshot.sites, [site.site]: site }) });
}
