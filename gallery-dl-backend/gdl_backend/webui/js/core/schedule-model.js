const SCHEDULE_PHASES = new Set(["unavailable", "loading", "empty", "content", "error"]);
const PLAN_STATES = new Set(["enabled", "disabled", "running"]);
const SCHEDULE_KINDS = new Set(["daily", "weekly", "interval"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_KEY = /(?:url|uri|path|file|token|cookie|password|secret|auth|session|error|detail)/i;
const SAFE_SEMANTIC_KEYS = new Set(["error"]);
const SAFE_CODE = /^[A-Za-z0-9._:-]{1,64}$/;

function plainRecord(value, label = "定时任务状态") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label}必须是普通对象`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label}必须是普通对象`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) throw new TypeError(`${label}包含危险键`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${label}不得包含访问器`);
  }
  return value;
}

function allowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) || (FORBIDDEN_KEY.test(key) && !SAFE_SEMANTIC_KEYS.has(key))) throw new TypeError(`${label}字段无效`);
  }
}

function text(value, label, maximum = 80, { empty = false } = {}) {
  if (typeof value !== "string") throw new TypeError(`${label}必须是文本`);
  const result = value.trim();
  if ((!result && !empty) || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new TypeError(`${label}无效`);
  return result;
}

function optionalText(value, label, maximum = 120) {
  if (value === undefined || value === null || value === "") return "";
  return text(value, label, maximum);
}

function count(value, label, maximum = 10_000) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > maximum) throw new TypeError(`${label}必须是有限非负整数`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function enumValue(value, choices, label) {
  if (typeof value !== "string" || !choices.has(value)) throw new TypeError(`${label}枚举无效`);
  return value;
}

function id(value, label) {
  const result = text(value, label, 48);
  if (!SAFE_CODE.test(result)) throw new TypeError(`${label}格式无效`);
  return result;
}

function projectPlan(raw) {
  const plan = plainRecord(raw, "计划");
  allowedKeys(plan, new Set([
    "id", "name", "state", "scheduleKind", "scheduleLabel", "concurrency",
    "sourceCount", "nextRunLabel", "lastRunLabel",
  ]), "计划");
  return Object.freeze({
    id: id(plan.id, "计划 ID"),
    name: text(plan.name, "计划名称", 72),
    state: enumValue(plan.state, PLAN_STATES, "计划状态"),
    scheduleKind: enumValue(plan.scheduleKind, SCHEDULE_KINDS, "计划类型"),
    scheduleLabel: text(plan.scheduleLabel, "计划表达", 80),
    concurrency: count(plan.concurrency, "并发数", 128),
    sourceCount: count(plan.sourceCount, "来源数", 500),
    nextRunLabel: optionalText(plan.nextRunLabel, "下次运行摘要", 80),
    lastRunLabel: optionalText(plan.lastRunLabel, "上次运行摘要", 80),
  });
}

function safeFailure(value) {
  const error = plainRecord(value, "定时任务错误");
  allowedKeys(error, new Set(["code", "status", "requestId", "category"]), "定时任务错误");
  return Object.freeze({
    code: id(error.code, "错误代码"),
    status: count(error.status, "错误状态", 599),
    requestId: optionalText(error.requestId, "请求标识", 64),
    category: enumValue(error.category, new Set(["transport", "validation", "capability", "unknown"]), "错误分类"),
  });
}

export function projectScheduleState(raw) {
  const value = plainRecord(raw);
  allowedKeys(value, new Set(["phase", "plans", "error"]), "定时任务状态");
  const phase = enumValue(value.phase, SCHEDULE_PHASES, "定时任务状态");
  if (phase === "content") {
    if (!Array.isArray(value.plans) || value.plans.length === 0 || value.plans.length > 100) throw new TypeError("计划列表无效");
    const plans = value.plans.map(projectPlan);
    if (new Set(plans.map((plan) => plan.id)).size !== plans.length) throw new TypeError("计划 ID 重复");
    return Object.freeze({ phase, plans: Object.freeze(plans), error: null });
  }
  if (phase === "error") {
    if (value.plans !== undefined && (!Array.isArray(value.plans) || value.plans.length !== 0)) throw new TypeError("错误状态不得包含计划");
    return Object.freeze({ phase, plans: Object.freeze([]), error: safeFailure(value.error) });
  }
  if (
    (value.plans !== undefined && (!Array.isArray(value.plans) || value.plans.length !== 0))
    || (value.error !== undefined && value.error !== null)
  ) throw new TypeError("定时任务状态字段与状态不匹配");
  return Object.freeze({ phase, plans: Object.freeze([]), error: null });
}

export function createScheduleUnavailableAdapter() {
  return Object.freeze({
    read() {
      return projectScheduleState({ phase: "unavailable" });
    },
  });
}

export function createScheduleUiState() {
  return Object.freeze({ selectedId: "", draft: null, dirty: false, validation: Object.freeze({ valid: true, field: "", reason: "" }) });
}

function projectDraft(raw) {
  const draft = plainRecord(raw, "计划草稿");
  allowedKeys(draft, new Set(["name", "scheduleKind", "scheduleLabel", "concurrency"]), "计划草稿");
  return Object.freeze({
    name: typeof draft.name === "string" ? draft.name.trim().slice(0, 73) : "",
    scheduleKind: typeof draft.scheduleKind === "string" ? draft.scheduleKind : "",
    scheduleLabel: typeof draft.scheduleLabel === "string" ? draft.scheduleLabel.trim().slice(0, 81) : "",
    concurrency: draft.concurrency,
  });
}

export function validateScheduleDraft(raw) {
  let draft;
  try {
    draft = projectDraft(raw);
  } catch {
    return Object.freeze({ valid: false, field: "draft", reason: "计划草稿格式无效。" });
  }
  if (!draft.name || draft.name.length > 72 || /[\u0000-\u001f\u007f]/.test(draft.name)) {
    return Object.freeze({ valid: false, field: "name", reason: "名称需为 1–72 个可读字符。" });
  }
  if (!SCHEDULE_KINDS.has(draft.scheduleKind)) {
    return Object.freeze({ valid: false, field: "schedule-kind", reason: "请选择有效的计划类型。" });
  }
  if (!draft.scheduleLabel || draft.scheduleLabel.length > 80 || /[\u0000-\u001f\u007f]/.test(draft.scheduleLabel)) {
    return Object.freeze({ valid: false, field: "schedule-label", reason: "计划表达需为 1–80 个可读字符。" });
  }
  if (!Number.isFinite(draft.concurrency) || !Number.isInteger(draft.concurrency) || draft.concurrency < 1 || draft.concurrency > 128) {
    return Object.freeze({ valid: false, field: "concurrency", reason: "并发数需为 1–128 的整数。" });
  }
  return Object.freeze({ valid: true, field: "", reason: "" });
}

function draftFromPlan(plan) {
  return Object.freeze({
    name: plan.name,
    scheduleKind: plan.scheduleKind,
    scheduleLabel: plan.scheduleLabel,
    concurrency: plan.concurrency,
  });
}

export function selectSchedulePlan(state, planId) {
  const projected = projectScheduleState(state);
  if (projected.phase !== "content") return createScheduleUiState();
  const plan = projected.plans.find((item) => item.id === planId);
  if (!plan) throw new TypeError("计划不存在");
  return Object.freeze({
    selectedId: plan.id,
    draft: draftFromPlan(plan),
    dirty: false,
    validation: validateScheduleDraft(draftFromPlan(plan)),
  });
}

export function updateScheduleDraft(state, uiState, patch) {
  const projected = projectScheduleState(state);
  if (projected.phase !== "content") throw new TypeError("当前没有可编辑计划");
  const plan = projected.plans.find((item) => item.id === uiState?.selectedId);
  if (!plan) throw new TypeError("计划不存在");
  const delta = plainRecord(patch, "计划草稿更新");
  allowedKeys(delta, new Set(["name", "scheduleKind", "scheduleLabel", "concurrency"]), "计划草稿更新");
  const draft = projectDraft({ ...draftFromPlan(plan), ...(uiState.draft || {}), ...delta });
  const baseline = draftFromPlan(plan);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  return Object.freeze({ selectedId: plan.id, draft, dirty, validation: validateScheduleDraft(draft) });
}

export function resetScheduleDraft(state, uiState) {
  return selectSchedulePlan(state, uiState.selectedId);
}

export function schedulePresentation(state) {
  const projected = projectScheduleState(state);
  const table = {
    unavailable: ["disabled", "后端能力尚未接入", "定时任务后端能力尚未接入；当前不会读取调度器状态或发送业务请求。"],
    loading: ["running", "正在加载计划", "正在等待受控适配器返回计划事实。"],
    empty: ["disabled", "暂无计划", "当前没有可显示的自动采集计划。"],
    content: ["ready", "计划内容可用", "可检查计划状态、编辑草稿与验证字段。"],
    error: ["error", "计划读取失败", "安全错误分类已记录；原始错误正文不会显示。"],
  };
  const [kind, label, message] = table[projected.phase];
  return Object.freeze({ state: projected.phase, kind, label, message });
}
