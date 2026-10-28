const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ok: "正常",
  error: "异常",
  disabled: "已禁用",
  optional_missing: "可选组件缺失",
  optional_warning: "提示",
});

export const DIAGNOSTICS_POLL_INTERVAL_MS = 20_000;
export const COMPONENTS: readonly { readonly id: string; readonly domain: string; readonly label: string; readonly nextStep: string; readonly app?: "proxy" | "tasks" }[] = Object.freeze([
  Object.freeze({ id: "process", domain: "service", label: "服务进程", nextStep: "刷新诊断；若持续离线，请重新启动本地服务。" }),
  Object.freeze({ id: "database", domain: "service", label: "SQLite", nextStep: "请检查数据库目录和权限。" }),
  Object.freeze({ id: "gallery_source", domain: "service", label: "gallery-dl", nextStep: "请检查 gallery-dl 子模块。" }),
  Object.freeze({ id: "project_proxy", domain: "network", label: "代理池", nextStep: "打开代理管理检查节点来源和运行状态。", app: "proxy" }),
  Object.freeze({ id: "mihomo", domain: "network", label: "Mihomo", nextStep: "打开代理管理检查传输核心的安装和状态。", app: "proxy" }),
  Object.freeze({ id: "scheduler", domain: "tasks", label: "任务调度器", nextStep: "打开批次管理查看活动批次。", app: "tasks" }),
  Object.freeze({ id: "ordered_crawls", domain: "tasks", label: "批次调度", nextStep: "打开批次管理查看活动批次。", app: "tasks" }),
  Object.freeze({ id: "dedup", domain: "dedup", label: "去重环境", nextStep: "请检查去重运行环境和模型缓存。" }),
  Object.freeze({ id: "dedup_python", domain: "dedup", label: "去重运行环境", nextStep: "请检查虚拟环境。" }),
  Object.freeze({ id: "torch", domain: "dedup", label: "计算环境", nextStep: "请核对 CPU/CUDA 环境。" }),
  Object.freeze({ id: "sscd_model", domain: "dedup", label: "SSCD 模型", nextStep: "请检查模型缓存。" }),
  Object.freeze({ id: "dino_model", domain: "dedup", label: "DINOv2 模型", nextStep: "请检查模型缓存。" }),
 ]);
export const DIAGNOSTIC_COMPONENTS = COMPONENTS;
export const DIAGNOSTIC_DOMAIN_LABELS = Object.freeze({ service: "服务基础", network: "连接与代理", tasks: "任务执行", dedup: "去重环境" });
const SECTION_NAMES = Object.freeze(["health", "readiness", "config", "scheduler"] as const);
const SAFE_ERROR_CODE = /^[A-Za-z0-9._:-]{1,128}$/;
const STATUS_KIND = ["ready", "running", "warning", "error", "disabled"] as const;

type SectionName = typeof SECTION_NAMES[number];
export const COMPONENT_STATUSES = new Set(["ok", "error", "disabled", "optional_missing", "optional_warning"]);
export type DiagnosticsStatus = "ok" | "error" | "disabled" | "optional_missing" | "optional_warning";

export interface DiagnosticsError {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
}

export interface DiagnosticsOutcome {
  readonly connected: boolean;
  readonly data: unknown;
  readonly response?: unknown;
  readonly error?: unknown;
}

export interface HealthDiagnostics {
  readonly ok: boolean;
  readonly process: DiagnosticsStatus;
  readonly database: DiagnosticsStatus;
}

export interface DiagnosticComponent {
  readonly id: string;
  readonly domain: string;
  readonly label: string;
  readonly status: DiagnosticsStatus;
  readonly statusLabel: string;
  readonly uiStatus: "ready" | "running" | "warning" | "error" | "disabled";
  readonly required: boolean;
  readonly detail: string;
  readonly nextStep: string;
  readonly targetApp: "proxy" | "tasks" | "";
}

export interface ReadinessDiagnostics {
  readonly ready: boolean;
  readonly components: readonly DiagnosticComponent[];
}

export interface DiagnosticsConfig {
  readonly loopbackOnly: boolean;
  readonly corsEnabled: boolean;
  readonly privateTargetsEnabled: boolean;
  readonly managedAuthCache: boolean;
  readonly proxyEnabled: boolean;
  readonly proxyAutoStart: boolean;
  readonly transportCoreEnabled: boolean;
  readonly schedulerCapacity: number;
  readonly dedupEnabled: boolean;
  readonly configuredDevice: "auto" | "cpu" | "cuda" | "unknown";
  readonly sscdEnabled: boolean;
  readonly dinoEnabled: boolean;
}

export interface DiagnosticsScheduler {
  readonly tasksRunning: boolean;
  readonly activeTasks: number;
  readonly maxConcurrent: number;
  readonly activeSiteCount: number;
  readonly crawlsRunning: boolean;
  readonly activeBatches: number;
  readonly executionOrder: "按来源和地址顺序" | "未知";
  readonly addressParallelism: "图片任务并发" | "未知";
}

export interface DiagnosticsSnapshot {
  readonly health: HealthDiagnostics | null;
  readonly readiness: ReadinessDiagnostics | null;
  readonly config: DiagnosticsConfig | null;
  readonly scheduler: DiagnosticsScheduler | null;
  readonly connected: boolean;
  readonly offline: boolean;
  readonly stale: boolean;
  readonly complete: boolean;
  readonly freshSections: readonly SectionName[];
  readonly staleSections: readonly SectionName[];
  readonly errors: Readonly<Record<SectionName, DiagnosticsError | null>>;
  readonly lastCheckedAt: number;
}

export interface DiagnosticsPresentation {
  readonly state: "loading" | "content" | "partial" | "stale" | "offline" | "error" | "refreshing";
  readonly kind: typeof STATUS_KIND[number];
  readonly label: string;
  readonly message: string;
}

function record(value: unknown): Record<string, unknown> | null {
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

function own(value: Record<string, unknown> | null, key: string): unknown {
  return value && Object.hasOwn(value, key) ? value[key] : undefined;
}

function safeInteger(value: unknown, maximum = 1_000_000_000): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function safeStatus(value: unknown): DiagnosticsStatus {
  return typeof value === "string" && COMPONENT_STATUSES.has(value) ? value as DiagnosticsStatus : "error";
}

function uiStatus(status: DiagnosticsStatus): DiagnosticComponent["uiStatus"] {
  if (status === "ok") return "ready";
  if (status === "disabled") return "disabled";
  if (status === "optional_missing" || status === "optional_warning") return "warning";
  return "error";
}

function safeVersion(value: unknown): string {
  if (typeof value !== "string") return "未知版本";
  const text = value.trim();
  return /^[A-Za-z0-9.+_-]{1,40}$/.test(text) ? text : "未知版本";
}

function componentDetail(id: string, raw: Record<string, unknown>): string {
  if (id === "project_proxy") return `节点来源 ${safeInteger(own(raw, "source_count"))} · 健康 ${safeInteger(own(raw, "healthy"))} · ${own(raw, "running") === true ? "运行中" : "未运行"}`;
  if (id === "torch") {
    const actual = ["cpu", "cuda", "unknown"].includes(String(own(raw, "actual_device"))) ? String(own(raw, "actual_device")) : "unknown";
    const configured = ["auto", "cpu", "cuda"].includes(String(own(raw, "configured_device"))) ? String(own(raw, "configured_device")) : "unknown";
    return `Torch ${safeVersion(own(raw, "version"))} · 配置 ${configured} · 实际 ${actual} · CUDA ${own(raw, "cuda_available") === true ? "可用" : "不可用"}`;
  }
  if (id === "dedup") {
    const resources = record(own(raw, "configured_resources"));
    return `工作线程 ${safeInteger(own(resources, "workers"), 64)} · 批大小 ${safeInteger(own(resources, "deep_batch_size"), 128)} · 分块 ${safeInteger(own(resources, "neighbor_block_size"), 8192)}`;
  }
  if (id === "scheduler") {
    const details = record(own(raw, "details"));
    return `活动任务 ${safeInteger(own(details, "active"))} / ${safeInteger(own(details, "max_concurrent"), 100_000)}`;
  }
  if (id === "ordered_crawls") {
    const details = record(own(raw, "details"));
    return `活动批次 ${safeInteger(own(details, "active_batches"))}`;
  }
  if (id === "mihomo") return own(raw, "required") === false ? "当前设置不需要传输核心" : "按当前代理设置检查";
  return "";
}

export function sanitizeHealthDiagnostics(value: unknown): HealthDiagnostics {
  const root = record(value);
  if (!root || typeof own(root, "ok") !== "boolean") throw new TypeError("invalid_diagnostics_health");
  const components = record(own(root, "components"));
  return Object.freeze({ ok: own(root, "ok") as boolean, process: safeStatus(own(record(own(components, "process")), "status")), database: safeStatus(own(record(own(components, "database")), "status")) });
}

export function sanitizeReadinessDiagnostics(value: unknown): ReadinessDiagnostics {
  const root = record(value);
  if (!root || typeof own(root, "ready") !== "boolean") throw new TypeError("invalid_diagnostics_readiness");
  const rawComponents = record(own(root, "components"));
  const components: DiagnosticComponent[] = [];
  const seen = new Set<string>();
  for (const definition of DIAGNOSTIC_COMPONENTS) {
    if (seen.has(definition.id)) continue;
    const raw = record(own(rawComponents, definition.id));
    if (!raw) continue;
    seen.add(definition.id);
    const status = safeStatus(own(raw, "status"));
    components.push(Object.freeze({
      id: definition.id,
      domain: definition.domain,
      label: definition.label,
      status,
      statusLabel: STATUS_LABELS[status] ?? "异常",
      uiStatus: uiStatus(status),
      required: own(raw, "required") !== false,
      detail: componentDetail(definition.id, raw),
      nextStep: definition.nextStep,
      targetApp: definition.app === "proxy" || definition.app === "tasks" ? definition.app : "",
    }));
  }
  return Object.freeze({ ready: own(root, "ready") as boolean, components: Object.freeze(components) });
}

export function sanitizeDiagnosticsConfig(value: unknown): DiagnosticsConfig {
  const root = record(value);
  if (!root || own(root, "response_profile") !== "diagnostics" || own(root, "secrets_exposed") !== false) throw new TypeError("invalid_diagnostics_config");
  const server = record(own(root, "server"));
  const gallery = record(own(root, "gallery"));
  const proxy = record(own(root, "proxy"));
  const scheduler = record(own(root, "scheduler"));
  const dedup = record(own(root, "dedup"));
  const configuredDevice = ["auto", "cpu", "cuda"].includes(String(own(dedup, "configured_device"))) ? String(own(dedup, "configured_device")) as DiagnosticsConfig["configuredDevice"] : "unknown";
  return Object.freeze({
    loopbackOnly: own(server, "loopback_only") === true,
    corsEnabled: own(server, "cors_enabled") === true,
    privateTargetsEnabled: own(server, "private_targets_enabled") === true,
    managedAuthCache: own(gallery, "managed_auth_cache") === true,
    proxyEnabled: own(proxy, "enabled") === true,
    proxyAutoStart: own(proxy, "auto_start") === true,
    transportCoreEnabled: own(proxy, "transport_core_enabled") === true,
    schedulerCapacity: safeInteger(own(scheduler, "max_concurrent_tasks"), 100_000),
    dedupEnabled: own(dedup, "enabled") === true,
    configuredDevice,
    sscdEnabled: own(dedup, "sscd_enabled") === true,
    dinoEnabled: own(dedup, "dino_enabled") === true,
  });
}

export function sanitizeDiagnosticsScheduler(value: unknown): DiagnosticsScheduler {
  const root = record(value);
  if (!root || own(root, "response_profile") !== "diagnostics" || own(root, "secrets_exposed") !== false) throw new TypeError("invalid_diagnostics_scheduler");
  const tasks = record(own(root, "tasks"));
  const crawls = record(own(root, "ordered_crawls"));
  return Object.freeze({
    tasksRunning: own(tasks, "running") === true,
    activeTasks: safeInteger(own(tasks, "active")),
    maxConcurrent: safeInteger(own(tasks, "max_concurrent"), 100_000),
    activeSiteCount: safeInteger(own(tasks, "active_site_count"), 10_000),
    crawlsRunning: own(crawls, "running") === true,
    activeBatches: safeInteger(own(crawls, "active_batches")),
    executionOrder: own(crawls, "execution_order") === "source_then_address" ? "按来源和地址顺序" : "未知",
    addressParallelism: own(crawls, "address_parallelism") === "media_tasks" ? "图片任务并发" : "未知",
  });
}

function errorField(error: unknown, key: string): unknown {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
}

function safeOutcomeError(outcome: DiagnosticsOutcome | undefined): DiagnosticsError | null {
  const error = outcome?.error;
  if (!error || typeof error !== "object") return null;
  const status = errorField(error, "status");
  const code = errorField(error, "code");
  const requestId = errorField(error, "requestId");
  return Object.freeze({
    status: typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0,
    code: typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : "request_failed",
    requestId: typeof requestId === "string" && SAFE_ERROR_CODE.test(requestId) ? requestId : "",
  });
}

function outcomeData(outcome: DiagnosticsOutcome | undefined): unknown {
  if (!outcome) return null;
  if (outcome.data !== null && outcome.data !== undefined) return outcome.data;
  return outcome.connected === true ? outcome.response ?? null : null;
}

function sanitizeSection(section: SectionName, outcome: DiagnosticsOutcome | undefined): HealthDiagnostics | ReadinessDiagnostics | DiagnosticsConfig | DiagnosticsScheduler {
  const data = outcomeData(outcome);
  if (section === "health") return sanitizeHealthDiagnostics(data);
  if (section === "readiness") return sanitizeReadinessDiagnostics(data);
  if (section === "config") return sanitizeDiagnosticsConfig(data);
  return sanitizeDiagnosticsScheduler(data);
}

export function buildDiagnosticsSnapshot({ health, readiness, config, scheduler, checkedAt = Date.now(), previous = null }: { readonly health?: DiagnosticsOutcome; readonly readiness?: DiagnosticsOutcome; readonly config?: DiagnosticsOutcome; readonly scheduler?: DiagnosticsOutcome; readonly checkedAt?: number; readonly previous?: DiagnosticsSnapshot | null }): DiagnosticsSnapshot {
  const outcomes: Readonly<Record<SectionName, DiagnosticsOutcome | undefined>> = { health, readiness, config, scheduler };
  const sections: Partial<Record<SectionName, HealthDiagnostics | ReadinessDiagnostics | DiagnosticsConfig | DiagnosticsScheduler | null>> = {};
  const errors: Record<SectionName, DiagnosticsError | null> = { health: safeOutcomeError(health), readiness: safeOutcomeError(readiness), config: safeOutcomeError(config), scheduler: safeOutcomeError(scheduler) };
  const fresh: SectionName[] = [];
  const stale: SectionName[] = [];
  for (const section of SECTION_NAMES) {
    let value: HealthDiagnostics | ReadinessDiagnostics | DiagnosticsConfig | DiagnosticsScheduler | null = null;
    try { value = sanitizeSection(section, outcomes[section]); } catch { /* invalid response remains an unavailable section */ }
    if (value) {
      sections[section] = value;
      fresh.push(section);
    } else {
      sections[section] = previous?.[section] ?? null;
      if (sections[section]) stale.push(section);
      if (!errors[section]) errors[section] = Object.freeze({ status: 0, code: "invalid_response", requestId: "" });
    }
  }
  const connected = SECTION_NAMES.some((section) => outcomes[section]?.connected === true);
  return Object.freeze({
    health: (sections.health as HealthDiagnostics | null) ?? null,
    readiness: (sections.readiness as ReadinessDiagnostics | null) ?? null,
    config: (sections.config as DiagnosticsConfig | null) ?? null,
    scheduler: (sections.scheduler as DiagnosticsScheduler | null) ?? null,
    connected,
    offline: !connected,
    stale: fresh.length !== SECTION_NAMES.length,
    complete: fresh.length === SECTION_NAMES.length,
    freshSections: Object.freeze(fresh),
    staleSections: Object.freeze(stale),
    errors: Object.freeze(errors),
    lastCheckedAt: Math.max(0, Number(checkedAt) || 0),
  });
}

export function validateDiagnosticsSnapshot(value: unknown): DiagnosticsSnapshot {
  const snapshot = record(value);
  if (!snapshot || typeof own(snapshot, "connected") !== "boolean" || typeof own(snapshot, "offline") !== "boolean" || typeof own(snapshot, "stale") !== "boolean" || typeof own(snapshot, "complete") !== "boolean" || !Array.isArray(own(snapshot, "freshSections")) || !Array.isArray(own(snapshot, "staleSections")) || !record(own(snapshot, "errors")) || typeof own(snapshot, "lastCheckedAt") !== "number" || !Number.isFinite(own(snapshot, "lastCheckedAt"))) throw new TypeError("invalid_diagnostics_snapshot");
  const validateSections = (sections: readonly unknown[]): void => {
    let previous = -1;
    const seen = new Set<string>();
    for (const section of sections) {
      const index = typeof section === "string" ? SECTION_NAMES.indexOf(section as SectionName) : -1;
      if (index < 0 || index <= previous || seen.has(section as string)) throw new TypeError("invalid_diagnostics_section");
      seen.add(section as string);
      previous = index;
    }
  };
  validateSections(own(snapshot, "freshSections") as readonly unknown[]);
  validateSections(own(snapshot, "staleSections") as readonly unknown[]);
  const errors = record(own(snapshot, "errors"));
  for (const section of SECTION_NAMES) {
    const error = own(errors, section);
    if (error !== null) {
      const item = record(error);
      const status = own(item, "status");
      const code = own(item, "code");
      const requestId = own(item, "requestId");
      if (!item || typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 599 || typeof code !== "string" || !SAFE_ERROR_CODE.test(code) || typeof requestId !== "string" || (requestId !== "" && !SAFE_ERROR_CODE.test(requestId))) throw new TypeError("invalid_diagnostics_error");
    }
  }
  const readiness = record(own(snapshot, "readiness"));
  if (readiness) {
    const components = own(readiness, "components");
    if (!Array.isArray(components)) throw new TypeError("invalid_diagnostics_components");
    const seen = new Set<string>();
    let previous = -1;
    for (const componentValue of components) {
      const component = record(componentValue);
      const id = own(component, "id");
      const index = typeof id === "string" ? DIAGNOSTIC_COMPONENTS.findIndex((definition) => definition.id === id) : -1;
      if (!component || index < 0 || index <= previous || seen.has(id as string)) throw new TypeError("invalid_diagnostics_components");
      seen.add(id as string);
      previous = index;
    }
  }
  return value as DiagnosticsSnapshot;
}

export function deriveDiagnosticsWorkspacePresentation({ snapshot = null, refreshing = false }: { readonly snapshot?: DiagnosticsSnapshot | null; readonly refreshing?: boolean } = {}): DiagnosticsPresentation {
  if (refreshing) return Object.freeze({ state: "refreshing", kind: "running", label: "正在刷新", message: "四项只读检查正在并发执行；当前安全快照继续可见。" });
  if (!snapshot) return Object.freeze({ state: "loading", kind: "running", label: "正在加载", message: "正在读取连接、就绪、安全配置和任务调度状态。" });
  const hasFacts = SECTION_NAMES.some((section) => Boolean(snapshot[section]));
  if (snapshot.offline && !hasFacts) return Object.freeze({ state: "error", kind: "error", label: "首次检查失败", message: "服务当前不可连接，尚无可安全显示的诊断快照。" });
  if (snapshot.offline) return Object.freeze({ state: "offline", kind: "error", label: "服务离线", message: "当前显示上次成功读取的分区；这些事实均已标记为陈旧。" });
  if (snapshot.staleSections.length) return Object.freeze({ state: "stale", kind: "warning", label: "部分快照陈旧", message: "失败分区保留上次安全快照；其余分区已更新。" });
  if (snapshot.stale) return Object.freeze({ state: "partial", kind: "warning", label: "部分信息不可用", message: "首次检查未获得全部分区，不会补造缺失事实。" });
  return Object.freeze({ state: "content", kind: snapshot.readiness?.ready ? "ready" : "warning", label: snapshot.readiness?.ready ? "系统已就绪" : "系统未完全就绪", message: "连接、健康、就绪、安全配置和任务调度事实均已更新。" });
}

export function createDiagnosticsRequestGate() {
  let lifecycle = 0;
  let sequence = 0;
  let applied = 0;
  return Object.freeze({
    beginCycle() { return Object.freeze({ lifecycle, sequence: ++sequence }); },
    isCycleCurrent(ticket: { lifecycle: number; sequence: number } | null) {
      const current = Boolean(ticket && ticket.lifecycle === lifecycle && ticket.sequence === sequence && ticket.sequence >= applied);
      if (current && ticket) applied = ticket.sequence;
      return current;
    },
    advanceLifecycle() { lifecycle += 1; sequence += 1; },
  });
}

export function diagnosticsCopyText(snapshot: DiagnosticsSnapshot): string {
  validateDiagnosticsSnapshot(snapshot);
  const lines = [
    "LDOS 诊断摘要（敏感信息已隐藏）",
    `连接：${snapshot.offline ? "离线" : snapshot.stale ? "部分状态未更新" : "在线"}`,
    `服务状态：${snapshot.health?.ok ? "正常" : "异常或未知"}`,
    `功能状态：${snapshot.readiness?.ready ? "已就绪" : "未完全就绪"}`,
    `任务调度：${snapshot.scheduler ? `${snapshot.scheduler.activeTasks}/${snapshot.scheduler.maxConcurrent} 个活动任务，${snapshot.scheduler.activeBatches} 个活动批次` : "未知"}`,
  ];
  for (const component of snapshot.readiness?.components ?? []) lines.push(`${component.label}：${component.statusLabel}${component.detail ? `（${component.detail}）` : ""}`);
  lines.push(`检查时间：${new Date(snapshot.lastCheckedAt).toISOString()}`);
  return lines.join("\n");
}
