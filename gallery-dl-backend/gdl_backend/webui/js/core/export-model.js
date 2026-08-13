const EXPORT_PHASES = new Set(["unavailable", "loading", "empty", "content", "error"]);
const EXPORT_FORMATS = new Set(["manifest", "coco", "webdataset"]);
const EXPORT_RESULTS = new Set(["idle", "running", "success", "error"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_KEY = /(?:url|uri|path|file|filename|token|cookie|password|secret|auth|session|detail|blob|asset)/i;
const SAFE_SEMANTIC_KEYS = new Set(["error"]);
const SAFE_CODE = /^[A-Za-z0-9._:-]{1,64}$/;

function plainRecord(value, label = "导出状态") {
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

function text(value, label, maximum = 80, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string") throw new TypeError(`${label}必须是文本`);
  const result = value.trim();
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new TypeError(`${label}无效`);
  return result;
}

function id(value, label) {
  const result = text(value, label, 48);
  if (!SAFE_CODE.test(result)) throw new TypeError(`${label}格式无效`);
  return result;
}

function count(value, label, maximum = 1_000_000) {
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

function projectSource(raw) {
  const source = plainRecord(raw, "导出来源");
  allowedKeys(source, new Set(["id", "label", "itemCount", "reviewedCount", "selected"]), "导出来源");
  const itemCount = count(source.itemCount, "来源项目数");
  const reviewedCount = count(source.reviewedCount, "来源审核数");
  if (reviewedCount > itemCount) throw new TypeError("来源审核数不能超过项目数");
  return Object.freeze({
    id: id(source.id, "来源 ID"),
    label: text(source.label, "来源标签", 72),
    itemCount,
    reviewedCount,
    selected: boolean(source.selected, "来源选择"),
  });
}

function projectConfig(raw) {
  const config = plainRecord(raw, "导出配置");
  allowedKeys(config, new Set(["format", "includeMetadata", "includeRejected", "shardSize", "destinationLabel"]), "导出配置");
  return Object.freeze({
    format: enumValue(config.format, EXPORT_FORMATS, "导出格式"),
    includeMetadata: boolean(config.includeMetadata, "元数据选项"),
    includeRejected: boolean(config.includeRejected, "拒绝项选项"),
    shardSize: count(config.shardSize, "分片大小", 100_000),
    destinationLabel: text(config.destinationLabel, "目标摘要", 80),
  });
}

function projectProgress(raw) {
  const progress = plainRecord(raw, "导出进度");
  allowedKeys(progress, new Set(["state", "completed", "total", "resultLabel", "code", "category"]), "导出进度");
  const state = enumValue(progress.state, EXPORT_RESULTS, "导出结果状态");
  const completed = count(progress.completed, "已完成数");
  const total = count(progress.total, "总数");
  if (completed > total) throw new TypeError("已完成数不能超过总数");
  if (state === "running" && total === 0) throw new TypeError("运行中进度必须有总数");
  if (state === "success" && completed !== total) throw new TypeError("成功进度必须完成");
  return Object.freeze({
    state,
    completed,
    total,
    resultLabel: text(progress.resultLabel, "结果摘要", 100, true),
    code: text(progress.code, "结果代码", 64, true),
    category: progress.category === undefined || progress.category === ""
      ? ""
      : enumValue(progress.category, new Set(["transport", "validation", "capability", "unknown"]), "结果分类"),
  });
}

function safeFailure(raw) {
  const error = plainRecord(raw, "导出错误");
  allowedKeys(error, new Set(["code", "status", "requestId", "category"]), "导出错误");
  return Object.freeze({
    code: id(error.code, "错误代码"),
    status: count(error.status, "错误状态", 599),
    requestId: text(error.requestId, "请求标识", 64, true),
    category: enumValue(error.category, new Set(["transport", "validation", "capability", "unknown"]), "错误分类"),
  });
}

export function projectExportState(raw) {
  const value = plainRecord(raw);
  allowedKeys(value, new Set(["phase", "sources", "config", "progress", "error"]), "导出状态");
  const phase = enumValue(value.phase, EXPORT_PHASES, "导出状态");
  if (phase === "content") {
    if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > 100) throw new TypeError("导出来源无效");
    const sources = value.sources.map(projectSource);
    if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new TypeError("导出来源 ID 重复");
    return Object.freeze({
      phase,
      sources: Object.freeze(sources),
      config: projectConfig(value.config),
      progress: projectProgress(value.progress),
      error: null,
    });
  }
  if (phase === "error") {
    if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.length !== 0)) throw new TypeError("错误状态不得包含来源");
    if ((value.config !== undefined && value.config !== null) || (value.progress !== undefined && value.progress !== null)) throw new TypeError("错误状态不得包含导出事实");
    return Object.freeze({ phase, sources: Object.freeze([]), config: null, progress: null, error: safeFailure(value.error) });
  }
  if (
    (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.length !== 0))
    || (value.config !== undefined && value.config !== null)
    || (value.progress !== undefined && value.progress !== null)
    || (value.error !== undefined && value.error !== null)
  ) throw new TypeError("导出状态字段与状态不匹配");
  return Object.freeze({ phase, sources: Object.freeze([]), config: null, progress: null, error: null });
}

export function createExportUnavailableAdapter() {
  return Object.freeze({ read: () => projectExportState({ phase: "unavailable" }) });
}

export function toggleExportSource(state, sourceId) {
  const projected = projectExportState(state);
  if (projected.phase !== "content") throw new TypeError("当前没有导出来源");
  const idValue = id(sourceId, "来源 ID");
  if (!projected.sources.some((source) => source.id === idValue)) throw new TypeError("来源不存在");
  return Object.freeze({
    ...projected,
    sources: Object.freeze(projected.sources.map((source) => source.id === idValue ? Object.freeze({ ...source, selected: !source.selected }) : source)),
  });
}

export function updateExportConfig(state, patch) {
  const projected = projectExportState(state);
  if (projected.phase !== "content") throw new TypeError("当前没有导出配置");
  const delta = plainRecord(patch, "导出配置更新");
  allowedKeys(delta, new Set(["format", "includeMetadata", "includeRejected", "shardSize", "destinationLabel"]), "导出配置更新");
  return Object.freeze({ ...projected, config: projectConfig({ ...projected.config, ...delta }) });
}

export function exportSelectionFacts(state) {
  const projected = projectExportState(state);
  if (projected.phase !== "content") return Object.freeze({ sourceCount: 0, itemCount: 0, reviewedCount: 0 });
  const selected = projected.sources.filter((source) => source.selected);
  return Object.freeze({
    sourceCount: selected.length,
    itemCount: selected.reduce((sum, source) => sum + source.itemCount, 0),
    reviewedCount: selected.reduce((sum, source) => sum + source.reviewedCount, 0),
  });
}

export function exportPresentation(state) {
  const projected = projectExportState(state);
  const table = {
    unavailable: ["disabled", "后端能力尚未接入", "数据集导出后端能力尚未接入；当前不会读取文件系统或发送业务请求。"],
    loading: ["running", "正在加载导出配置", "正在等待受控适配器返回安全来源事实。"],
    empty: ["disabled", "暂无导出来源", "当前没有可选择的安全来源事实。"],
    content: ["ready", "导出预览可用", "可选择来源并检查确定性配置、进度和结果布局。"],
    error: ["error", "导出读取失败", "安全错误分类已记录；原始错误正文不会显示。"],
  };
  const [kind, label, message] = table[projected.phase];
  return Object.freeze({ state: projected.phase, kind, label, message });
}
