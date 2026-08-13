const GALLERY_PHASES = new Set(["unavailable", "loading", "empty", "content", "error"]);
const GALLERY_COLLECTIONS = new Set(["library", "favorites", "sources"]);
const GALLERY_SORTS = new Set(["recent", "oldest", "label"]);
const GALLERY_MODES = new Set(["grid", "list"]);
const MEDIA_VARIANTS = new Set(["mist", "ember", "forest", "plum", "ocean", "sand"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_KEY = /(?:url|uri|path|file|filename|token|cookie|password|secret|auth|session|detail|blob|asset|image|src)/i;
const SAFE_SEMANTIC_KEYS = new Set(["mediaToken"]);
const SAFE_CODE = /^[A-Za-z0-9._:-]{1,64}$/;

function assertPlainRecord(value, label = "图片库状态") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是普通对象`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label}必须是普通对象`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
      throw new TypeError(`${label}包含危险键`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      throw new TypeError(`${label}不得包含访问器`);
    }
  }
  return value;
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) || (FORBIDDEN_KEY.test(key) && !SAFE_SEMANTIC_KEYS.has(key))) {
      throw new TypeError(`${label}字段无效`);
    }
  }
}

function safeText(value, label, maximum = 80) {
  if (typeof value !== "string") throw new TypeError(`${label}必须是文本`);
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(`${label}无效`);
  }
  return text;
}

function safeOptionalText(value, label, maximum = 120) {
  if (value === undefined || value === null || value === "") return "";
  return safeText(value, label, maximum);
}

function safeCount(value, label, maximum = 1_000_000) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label}必须是有限非负整数`);
  }
  return value;
}

function safeBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function safeEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) throw new TypeError(`${label}枚举无效`);
  return value;
}

function safeId(value, label) {
  const text = safeText(value, label, 48);
  if (!SAFE_CODE.test(text)) throw new TypeError(`${label}格式无效`);
  return text;
}

function freezeItem(raw) {
  const item = assertPlainRecord(raw, "媒体条目");
  assertAllowedKeys(item, new Set([
    "id", "label", "collection", "sourceLabel", "kind", "width", "height",
    "favorite", "tags", "mediaToken", "mediaVariant",
  ]), "媒体条目");
  const tags = item.tags === undefined ? [] : item.tags;
  if (!Array.isArray(tags) || tags.length > 8) throw new TypeError("媒体标签无效");
  const projectedTags = tags.map((tag) => safeText(tag, "媒体标签", 24));
  if (new Set(projectedTags).size !== projectedTags.length) throw new TypeError("媒体标签重复");
  const token = safeId(item.mediaToken, "合成媒体令牌");
  if (!token.startsWith("synthetic-")) throw new TypeError("媒体令牌必须为合成令牌");
  return Object.freeze({
    id: safeId(item.id, "媒体 ID"),
    label: safeText(item.label, "媒体标签", 72),
    collection: safeEnum(item.collection, GALLERY_COLLECTIONS, "媒体分区"),
    sourceLabel: safeText(item.sourceLabel, "来源标签", 48),
    kind: safeText(item.kind, "媒体类型", 24),
    width: safeCount(item.width, "媒体宽度", 100_000),
    height: safeCount(item.height, "媒体高度", 100_000),
    favorite: safeBoolean(item.favorite, "收藏状态"),
    tags: Object.freeze(projectedTags),
    mediaToken: token,
    mediaVariant: safeEnum(item.mediaVariant, MEDIA_VARIANTS, "媒体变体"),
  });
}

function safeFailure(value) {
  const error = assertPlainRecord(value, "图片库错误");
  assertAllowedKeys(error, new Set(["code", "status", "requestId", "category"]), "图片库错误");
  const category = safeEnum(error.category, new Set(["transport", "validation", "capability", "unknown"]), "错误分类");
  return Object.freeze({
    code: safeId(error.code, "错误代码"),
    status: safeCount(error.status, "错误状态", 599),
    requestId: safeOptionalText(error.requestId, "请求标识", 64),
    category,
  });
}

export function projectGalleryState(raw) {
  const value = assertPlainRecord(raw);
  assertAllowedKeys(value, new Set(["phase", "items", "error"]), "图片库状态");
  const phase = safeEnum(value.phase, GALLERY_PHASES, "图片库状态");
  if (phase === "content") {
    if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > 200) {
      throw new TypeError("图片库内容无效");
    }
    const items = value.items.map(freezeItem);
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new TypeError("媒体 ID 重复");
    return Object.freeze({ phase, items: Object.freeze(items), error: null });
  }
  if (phase === "error") {
    if (value.items !== undefined && (!Array.isArray(value.items) || value.items.length !== 0)) {
      throw new TypeError("图片库错误状态不得包含媒体");
    }
    return Object.freeze({ phase, items: Object.freeze([]), error: safeFailure(value.error) });
  }
  if (
    (value.items !== undefined && (!Array.isArray(value.items) || value.items.length !== 0))
    || (value.error !== undefined && value.error !== null)
  ) throw new TypeError("图片库状态字段与状态不匹配");
  return Object.freeze({ phase, items: Object.freeze([]), error: null });
}

export function createGalleryUnavailableAdapter() {
  return Object.freeze({
    read() {
      return projectGalleryState({ phase: "unavailable" });
    },
  });
}

export function createGalleryUiState() {
  return Object.freeze({
    collection: "library",
    query: "",
    sort: "recent",
    mode: "grid",
    selectedIds: Object.freeze([]),
    inspectorOpen: true,
    quickLookId: "",
  });
}

function projectUiState(raw, items) {
  const value = assertPlainRecord(raw, "图片库视图状态");
  assertAllowedKeys(value, new Set([
    "collection", "query", "sort", "mode", "selectedIds", "inspectorOpen", "quickLookId",
  ]), "图片库视图状态");
  const ids = new Set(items.map((item) => item.id));
  if (!Array.isArray(value.selectedIds) || value.selectedIds.length > items.length) {
    throw new TypeError("图片选择无效");
  }
  const selectedIds = value.selectedIds.map((id) => safeId(id, "图片选择"));
  if (new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => !ids.has(id))) {
    throw new TypeError("图片选择无效");
  }
  const quickLookId = safeOptionalText(value.quickLookId, "Quick Look 项", 48);
  if (quickLookId && !ids.has(quickLookId)) throw new TypeError("Quick Look 项无效");
  const query = typeof value.query === "string" ? value.query.trim() : null;
  if (query === null || query.length > 80 || /[\u0000-\u001f\u007f]/.test(query)) throw new TypeError("搜索文本无效");
  return Object.freeze({
    collection: safeEnum(value.collection, GALLERY_COLLECTIONS, "图片库分区"),
    query,
    sort: safeEnum(value.sort, GALLERY_SORTS, "图片排序"),
    mode: safeEnum(value.mode, GALLERY_MODES, "图片布局"),
    selectedIds: Object.freeze(selectedIds),
    inspectorOpen: safeBoolean(value.inspectorOpen, "检查器状态"),
    quickLookId,
  });
}

export function updateGalleryUiState(current, patch, items = []) {
  const base = projectUiState(current, items);
  const delta = assertPlainRecord(patch, "图片库视图更新");
  assertAllowedKeys(delta, new Set([
    "collection", "query", "sort", "mode", "selectedIds", "inspectorOpen", "quickLookId",
  ]), "图片库视图更新");
  return projectUiState({ ...base, ...delta }, items);
}

export function toggleGallerySelection(current, itemId, items, { additive = false } = {}) {
  const id = safeId(itemId, "媒体 ID");
  const state = projectUiState(current, items);
  if (!items.some((item) => item.id === id)) throw new TypeError("媒体 ID 不存在");
  const selection = new Set(additive ? state.selectedIds : []);
  if (additive && selection.has(id)) selection.delete(id);
  else selection.add(id);
  return updateGalleryUiState(state, { selectedIds: [...selection] }, items);
}

export function visibleGalleryItems(state, uiState) {
  const projected = projectGalleryState(state);
  if (projected.phase !== "content") return Object.freeze([]);
  const ui = projectUiState(uiState, projected.items);
  const query = ui.query.toLocaleLowerCase("zh-CN");
  const filtered = projected.items.filter((item) => {
    if (ui.collection === "favorites" && !item.favorite) return false;
    if (ui.collection === "sources" && !item.sourceLabel) return false;
    if (!query) return true;
    return [item.label, item.sourceLabel, item.kind, ...item.tags]
      .some((text) => text.toLocaleLowerCase("zh-CN").includes(query));
  });
  filtered.sort((left, right) => {
    if (ui.sort === "label") return left.label.localeCompare(right.label, "zh-CN");
    const difference = left.id.localeCompare(right.id, "zh-CN");
    return ui.sort === "oldest" ? difference : -difference;
  });
  return Object.freeze(filtered);
}

export function galleryPresentation(state) {
  const projected = projectGalleryState(state);
  const table = {
    unavailable: ["disabled", "后端能力尚未接入", "图片库后端能力尚未接入；当前不会读取下载目录或发送业务请求。"],
    loading: ["running", "正在加载图片库", "正在等待受控适配器返回安全媒体事实。"],
    empty: ["disabled", "图片库为空", "当前筛选没有可显示的合成媒体事实。"],
    content: ["ready", "图片库内容可用", "可搜索、排序、选择并使用 Quick Look 检查安全预览。"],
    error: ["error", "图片库读取失败", "安全错误分类已记录；原始错误正文不会显示。"],
  };
  const [kind, label, message] = table[projected.phase];
  return Object.freeze({ state: projected.phase, kind, label, message });
}
