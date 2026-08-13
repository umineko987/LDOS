const COMPONENT_STATUSES = new Set(["ok", "error", "disabled", "optional_missing", "optional_warning"]);
const COMPONENT_STATUS_LABELS = Object.freeze({
  ok: "正常",
  error: "异常",
  disabled: "已禁用",
  optional_missing: "可选组件缺失",
  optional_warning: "提示",
});
const COMPONENTS = Object.freeze([
  Object.freeze({ id: "process", domain: "service", label: "服务进程", next: "刷新诊断；若持续离线，请重新启动本地服务。" }),
  Object.freeze({ id: "database", domain: "service", label: "SQLite", next: "请检查数据库目录和权限。" }),
  Object.freeze({ id: "gallery_source", domain: "service", label: "gallery-dl", next: "请检查 gallery-dl 子模块。" }),
  Object.freeze({ id: "project_proxy", domain: "network", label: "代理池", next: "打开代理管理检查节点来源和运行状态。", app: "proxy" }),
  Object.freeze({ id: "mihomo", domain: "network", label: "Mihomo", next: "打开代理管理检查传输核心的安装和状态。", app: "proxy" }),
  Object.freeze({ id: "scheduler", domain: "tasks", label: "任务调度器", next: "打开批次管理查看活动批次。", app: "tasks" }),
  Object.freeze({ id: "ordered_crawls", domain: "tasks", label: "批次调度", next: "打开批次管理查看活动批次。", app: "tasks" }),
  Object.freeze({ id: "dedup", domain: "dedup", label: "去重环境", next: "请检查去重运行环境和模型缓存。" }),
  Object.freeze({ id: "dedup_python", domain: "dedup", label: "去重运行环境", next: "请检查虚拟环境。" }),
  Object.freeze({ id: "torch", domain: "dedup", label: "计算环境", next: "请核对 CPU/CUDA 环境。" }),
  Object.freeze({ id: "sscd_model", domain: "dedup", label: "SSCD 模型", next: "请检查模型缓存。" }),
  Object.freeze({ id: "dino_model", domain: "dedup", label: "DINOv2 模型", next: "请检查模型缓存。" }),
]);
const SECTION_NAMES = Object.freeze(["health", "readiness", "config", "scheduler"]);
const SAFE_ERROR_CODE = /^[A-Za-z0-9._:-]{1,128}$/;
const DOMAIN_LABELS = Object.freeze({
  service: "服务基础",
  network: "连接与代理",
  tasks: "任务执行",
  dedup: "去重环境",
});

export const DIAGNOSTICS_POLL_INTERVAL_MS = 20_000;
export const DIAGNOSTIC_COMPONENTS = COMPONENTS;
export const DIAGNOSTIC_DOMAIN_LABELS = DOMAIN_LABELS;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedCount(value, maximum = 1_000_000_000) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum
    ? value
    : 0;
}

function safeVersion(value, fallback = "未知版本") {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return /^[A-Za-z0-9.+_-]{1,40}$/.test(text) ? text : fallback;
}

function safeStatus(value, fallback = "error") {
  return typeof value === "string" && COMPONENT_STATUSES.has(value) ? value : fallback;
}

function uiStatus(status) {
  if (status === "ok") return "ready";
  if (status === "disabled") return "disabled";
  if (status === "optional_missing" || status === "optional_warning") return "warning";
  return "error";
}

function componentDetail(id, raw) {
  if (!isRecord(raw)) return "";
  if (id === "project_proxy") {
    return `节点来源 ${boundedCount(raw.source_count)} · 健康 ${boundedCount(raw.healthy)} · ${raw.running === true ? "运行中" : "未运行"}`;
  }
  if (id === "torch") {
    const actual = ["cpu", "cuda", "unknown"].includes(raw.actual_device) ? raw.actual_device : "unknown";
    const configured = ["auto", "cpu", "cuda"].includes(raw.configured_device) ? raw.configured_device : "unknown";
    return `Torch ${safeVersion(raw.version)} · 配置 ${configured} · 实际 ${actual} · CUDA ${raw.cuda_available === true ? "可用" : "不可用"}`;
  }
  if (id === "dedup") {
    const resources = isRecord(raw.configured_resources) ? raw.configured_resources : {};
    return `工作线程 ${boundedCount(resources.workers, 64)} · 批大小 ${boundedCount(resources.deep_batch_size, 128)} · 分块 ${boundedCount(resources.neighbor_block_size, 8192)}`;
  }
  if (id === "scheduler") {
    const details = isRecord(raw.details) ? raw.details : {};
    return `活动任务 ${boundedCount(details.active)} / ${boundedCount(details.max_concurrent, 100_000)}`;
  }
  if (id === "ordered_crawls") {
    const details = isRecord(raw.details) ? raw.details : {};
    return `活动批次 ${boundedCount(details.active_batches)}`;
  }
  if (id === "mihomo") return raw.required === false ? "当前设置不需要传输核心" : "按当前代理设置检查";
  return "";
}

export function sanitizeHealthDiagnostics(value) {
  if (!isRecord(value) || typeof value.ok !== "boolean") throw new TypeError("健康响应格式无效");
  const components = isRecord(value.components) ? value.components : {};
  return Object.freeze({
    ok: value.ok,
    process: safeStatus(components.process?.status),
    database: safeStatus(components.database?.status),
  });
}

export function sanitizeReadinessDiagnostics(value) {
  if (!isRecord(value) || typeof value.ready !== "boolean") throw new TypeError("就绪响应格式无效");
  const rawComponents = isRecord(value.components) ? value.components : {};
  const components = [];
  const seen = new Set();
  for (const definition of COMPONENTS) {
    if (seen.has(definition.id)) continue;
    const raw = rawComponents[definition.id];
    if (!isRecord(raw)) continue;
    seen.add(definition.id);
    const status = safeStatus(raw.status);
    components.push(Object.freeze({
      id: definition.id,
      domain: definition.domain,
      label: definition.label,
      status,
      statusLabel: COMPONENT_STATUS_LABELS[status],
      uiStatus: uiStatus(status),
      required: raw.required !== false,
      detail: componentDetail(definition.id, raw),
      nextStep: definition.next,
      targetApp: definition.app || "",
    }));
  }
  return Object.freeze({ ready: value.ready, components: Object.freeze(components) });
}

export function sanitizeDiagnosticsConfig(value) {
  if (!isRecord(value) || value.response_profile !== "diagnostics" || value.secrets_exposed !== false) {
    throw new TypeError("安全配置数据无效");
  }
  const configuredDevice = ["auto", "cpu", "cuda"].includes(value.dedup?.configured_device)
    ? value.dedup.configured_device
    : "unknown";
  return Object.freeze({
    loopbackOnly: value.server?.loopback_only === true,
    corsEnabled: value.server?.cors_enabled === true,
    privateTargetsEnabled: value.server?.private_targets_enabled === true,
    managedAuthCache: value.gallery?.managed_auth_cache === true,
    proxyEnabled: value.proxy?.enabled === true,
    proxyAutoStart: value.proxy?.auto_start === true,
    transportCoreEnabled: value.proxy?.transport_core_enabled === true,
    schedulerCapacity: boundedCount(value.scheduler?.max_concurrent_tasks, 100_000),
    dedupEnabled: value.dedup?.enabled === true,
    configuredDevice,
    sscdEnabled: value.dedup?.sscd_enabled === true,
    dinoEnabled: value.dedup?.dino_enabled === true,
  });
}

export function sanitizeDiagnosticsScheduler(value) {
  if (!isRecord(value) || value.response_profile !== "diagnostics" || value.secrets_exposed !== false) {
    throw new TypeError("任务调度数据无效");
  }
  return Object.freeze({
    tasksRunning: value.tasks?.running === true,
    activeTasks: boundedCount(value.tasks?.active),
    maxConcurrent: boundedCount(value.tasks?.max_concurrent, 100_000),
    activeSiteCount: boundedCount(value.tasks?.active_site_count, 10_000),
    crawlsRunning: value.ordered_crawls?.running === true,
    activeBatches: boundedCount(value.ordered_crawls?.active_batches),
    executionOrder: value.ordered_crawls?.execution_order === "source_then_address"
      ? "按来源和地址顺序"
      : "未知",
    addressParallelism: value.ordered_crawls?.address_parallelism === "media_tasks"
      ? "图片任务并发"
      : "未知",
  });
}

function safeOutcomeError(outcome) {
  const error = outcome?.error;
  if (!isRecord(error)) return null;
  const code = typeof error.code === "string" && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : "request_failed";
  const requestId = typeof error.requestId === "string" && SAFE_ERROR_CODE.test(error.requestId)
    ? error.requestId
    : "";
  return Object.freeze({
    status: Number.isInteger(error.status) && error.status >= 0 && error.status <= 599 ? error.status : 0,
    code,
    requestId,
  });
}

function outcomeData(outcome) {
  if (!isRecord(outcome)) return null;
  if (outcome.data !== null && outcome.data !== undefined) return outcome.data;
  return outcome.connected === true && isRecord(outcome.response) ? outcome.response : null;
}

function sanitizeSection(section, outcome) {
  const data = outcomeData(outcome);
  if (section === "health") return sanitizeHealthDiagnostics(data);
  if (section === "readiness") return sanitizeReadinessDiagnostics(data);
  if (section === "config") return sanitizeDiagnosticsConfig(data);
  return sanitizeDiagnosticsScheduler(data);
}

export function buildDiagnosticsSnapshot({ health, readiness, config, scheduler, checkedAt = Date.now(), previous = null }) {
  const outcomes = { health, readiness, config, scheduler };
  const previousSnapshot = isRecord(previous) ? previous : null;
  const sections = {};
  const errors = {};
  const freshSections = [];
  const staleSections = [];

  for (const section of SECTION_NAMES) {
    errors[section] = safeOutcomeError(outcomes[section]);
    let fresh = null;
    try {
      fresh = sanitizeSection(section, outcomes[section]);
    } catch {
      // 无效响应与请求失败一样按分区处理；绝不把原始 payload 放入快照。
    }
    if (fresh) {
      sections[section] = fresh;
      freshSections.push(section);
    } else {
      sections[section] = previousSnapshot?.[section] || null;
      if (sections[section]) staleSections.push(section);
      if (!errors[section]) {
        errors[section] = Object.freeze({ status: 0, code: "invalid_response", requestId: "" });
      }
    }
  }

  const connected = SECTION_NAMES.some((section) => outcomes[section]?.connected === true);
  const complete = freshSections.length === SECTION_NAMES.length;
  return Object.freeze({
    ...sections,
    connected,
    offline: !connected,
    stale: !complete,
    complete,
    freshSections: Object.freeze(freshSections),
    staleSections: Object.freeze(staleSections),
    errors: Object.freeze(errors),
    lastCheckedAt: Math.max(0, Number(checkedAt) || 0),
  });
}

function validateComponent(component, index) {
  if (!isRecord(component) || typeof component.id !== "string") throw new TypeError("组件状态数据无效");
  const definitionIndex = COMPONENTS.findIndex(({ id }) => id === component.id);
  if (definitionIndex < 0 || definitionIndex < index) throw new TypeError("组件状态顺序无效");
  return definitionIndex;
}

export function validateDiagnosticsSnapshot(value) {
  if (!isRecord(value) || typeof value.connected !== "boolean" || typeof value.offline !== "boolean" ||
      typeof value.stale !== "boolean" || typeof value.complete !== "boolean" ||
      !Array.isArray(value.freshSections) || !Array.isArray(value.staleSections) ||
      !isRecord(value.errors) || !Number.isFinite(value.lastCheckedAt)) {
    throw new TypeError("诊断数据无效");
  }
  const validateSectionNames = (sections) => {
    const seen = new Set();
    let previousIndex = -1;
    for (const section of sections) {
      const index = SECTION_NAMES.indexOf(section);
      if (index < 0 || index <= previousIndex || seen.has(section)) throw new TypeError("诊断分区状态无效");
      seen.add(section);
      previousIndex = index;
    }
  };
  validateSectionNames(value.freshSections);
  validateSectionNames(value.staleSections);
  for (const section of SECTION_NAMES) {
    const error = value.errors[section];
    if (error !== null && (!isRecord(error) || !Number.isInteger(error.status) ||
        !SAFE_ERROR_CODE.test(error.code || "") ||
        (error.requestId !== "" && !SAFE_ERROR_CODE.test(error.requestId || "")))) {
      throw new TypeError("诊断错误状态无效");
    }
  }
  if (value.readiness) {
    if (!Array.isArray(value.readiness.components)) throw new TypeError("组件状态数据无效");
    let previousIndex = -1;
    const seen = new Set();
    for (const component of value.readiness.components) {
      const index = validateComponent(component, previousIndex);
      if (seen.has(component.id)) throw new TypeError("组件状态重复");
      seen.add(component.id);
      previousIndex = index;
    }
  }
  return value;
}

export function deriveDiagnosticsWorkspacePresentation({ snapshot = null, refreshing = false } = {}) {
  if (refreshing) {
    return Object.freeze({ state: "refreshing", kind: "running", label: "正在刷新", message: "四项只读检查正在并发执行；当前安全快照继续可见。" });
  }
  if (!snapshot) {
    return Object.freeze({ state: "loading", kind: "running", label: "正在加载", message: "正在读取连接、就绪、安全配置和任务调度状态。" });
  }
  const hasFacts = SECTION_NAMES.some((section) => Boolean(snapshot[section]));
  if (snapshot.offline && !hasFacts) {
    return Object.freeze({ state: "error", kind: "error", label: "首次检查失败", message: "服务当前不可连接，尚无可安全显示的诊断快照。" });
  }
  if (snapshot.offline) {
    return Object.freeze({ state: "offline", kind: "error", label: "服务离线", message: "当前显示上次成功读取的分区；这些事实均已标记为陈旧。" });
  }
  if (snapshot.staleSections?.length) {
    return Object.freeze({ state: "stale", kind: "warning", label: "部分快照陈旧", message: "失败分区保留上次安全快照；其余分区已更新。" });
  }
  if (snapshot.stale) {
    return Object.freeze({ state: "partial", kind: "warning", label: "部分信息不可用", message: "首次检查未获得全部分区，不会补造缺失事实。" });
  }
  return Object.freeze({
    state: "content",
    kind: snapshot.readiness?.ready ? "ready" : "warning",
    label: snapshot.readiness?.ready ? "系统已就绪" : "系统未完全就绪",
    message: "连接、健康、就绪、安全配置和任务调度事实均已更新。",
  });
}

export function createDiagnosticsRequestGate() {
  let lifecycle = 0;
  let sequence = 0;
  let applied = 0;
  return Object.freeze({
    beginCycle() {
      return Object.freeze({ lifecycle, sequence: ++sequence });
    },
    isCycleCurrent(ticket) {
      const current = ticket?.lifecycle === lifecycle && ticket?.sequence === sequence && ticket.sequence >= applied;
      if (current) applied = ticket.sequence;
      return current;
    },
    advanceLifecycle() {
      lifecycle += 1;
      sequence += 1;
    },
  });
}

export function diagnosticsCopyText(snapshot) {
  validateDiagnosticsSnapshot(snapshot);
  const lines = [
    "ImageWeave 诊断摘要（敏感信息已隐藏）",
    `连接：${snapshot.offline ? "离线" : snapshot.stale ? "部分状态未更新" : "在线"}`,
    `服务状态：${snapshot.health?.ok ? "正常" : "异常或未知"}`,
    `功能状态：${snapshot.readiness?.ready ? "已就绪" : "未完全就绪"}`,
    `任务调度：${snapshot.scheduler ? `${snapshot.scheduler.activeTasks}/${snapshot.scheduler.maxConcurrent} 个活动任务，${snapshot.scheduler.activeBatches} 个活动批次` : "未知"}`,
  ];
  for (const component of snapshot.readiness?.components || []) {
    lines.push(`${component.label}：${component.statusLabel}${component.detail ? `（${component.detail}）` : ""}`);
  }
  lines.push(`检查时间：${new Date(snapshot.lastCheckedAt).toISOString()}`);
  return lines.join("\n");
}
