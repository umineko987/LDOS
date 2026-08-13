const REVIEW_STATUSES = new Set([
  "not_started", "waiting_for_crawl", "pending", "analyzing", "auto_applying",
  "ready", "applying", "applied", "failed", "apply_failed", "disabled",
]);
const FILTERS = new Set(["", "duplicate", "single", "unreadable"]);
const GROUP_KINDS = new Set(["duplicate", "single", "unreadable"]);
const ACTIVE_STATUSES = new Set(["pending", "analyzing", "auto_applying", "applying"]);
const LISTABLE_STATUSES = new Set(["ready", "applying", "applied", "apply_failed"]);
const STATUS_LABELS = Object.freeze({
  not_started: "去重未开始", waiting_for_crawl: "待开始分析", pending: "分析已排队",
  analyzing: "去重分析中", auto_applying: "自动去重中", ready: "待审核",
  applying: "正在应用", applied: "审核已应用", failed: "分析失败",
  apply_failed: "部分处理失败", disabled: "审核未启用",
});

export const REVIEW_GROUP_LIMIT = 10_000;
export const REVIEW_DECISION_BATCH_LIMIT = 50;
export const REVIEW_POLL_INTERVAL_MS = 1_500;
export const REVIEW_FILTERS = Object.freeze([
  Object.freeze({ id: "", label: "全部" }),
  Object.freeze({ id: "duplicate", label: "重复组" }),
  Object.freeze({ id: "single", label: "独立图片" }),
  Object.freeze({ id: "unreadable", label: "读取失败" }),
]);

export function resolveDeckCommand(key, {
  editable = false,
  readOnly = false,
  hasImages = false,
  loupeAvailable = false,
} = {}) {
  if (typeof key !== "string") return null;
  if (key === "Backspace") return "previous-group";
  if (hasImages && (key === "ArrowLeft" || key === "ArrowUp")) {
    return "focus-previous-image";
  }
  if (hasImages && (key === "ArrowRight" || key === "ArrowDown")) {
    return "focus-next-image";
  }
  if (key === " " && editable) return "toggle-active-image";
  if (key === "Enter" && editable) return "accept-advance";
  if (key === "Enter" && readOnly) return "browse-next-group";
  if ((key === "x" || key === "X") && loupeAvailable) return "toggle-loupe";
  return null;
}

export function deckImageStepTarget(direction, { activeIndex, imageCount }) {
  if (direction !== -1 && direction !== 1) throw new TypeError("审核图片方向无效");
  if (!Number.isInteger(activeIndex) || !Number.isInteger(imageCount) || imageCount < 0 ||
      (imageCount === 0 ? activeIndex !== -1 : activeIndex < 0 || activeIndex >= imageCount)) {
    throw new TypeError("审核图片位置无效");
  }
  if (!imageCount) return Object.freeze({ type: "empty" });
  return Object.freeze({
    type: "image",
    index: Math.max(0, Math.min(activeIndex + direction, imageCount - 1)),
  });
}

function requireDeckPosition({ focusedIndex, groupCount }) {
  if (!Number.isInteger(focusedIndex) || !Number.isInteger(groupCount) ||
      focusedIndex < 0 || groupCount < 0 || (groupCount && focusedIndex >= groupCount)) {
    throw new TypeError("审核分拣台位置无效");
  }
  return { focusedIndex, groupCount };
}

export function deckAdvanceTarget(position) {
  const { focusedIndex, groupCount } = requireDeckPosition(position);
  if (groupCount && focusedIndex + 1 < groupCount) {
    return Object.freeze({ type: "group", index: focusedIndex + 1 });
  }
  return Object.freeze({ type: "complete" });
}

export function deckStepTarget(direction, position) {
  if (direction !== -1 && direction !== 1) throw new TypeError("审核分拣台方向无效");
  const { focusedIndex, groupCount } = requireDeckPosition(position);
  if (!groupCount) return Object.freeze({ type: "edge" });
  const index = focusedIndex + direction;
  if (index < 0 || index >= groupCount) return Object.freeze({ type: "edge" });
  return Object.freeze({ type: "group", index });
}

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label}格式无效`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
      throw new TypeError(`${label}包含危险对象键`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      throw new TypeError(`${label}不得包含访问器`);
    }
  }
  return value;
}

function ownValue(value, key, fallback = undefined) {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) return fallback;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || typeof descriptor.get === "function" || typeof descriptor.set === "function") {
    return fallback;
  }
  return descriptor.value;
}

function safeId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text) ? text : "";
}

function strictCount(value, label, maximum = 1_000_000_000) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label}无效`);
  }
  return value;
}

function strictBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label}无效`);
  return value;
}

function projectedCount(value, maximum = 1_000_000_000) {
  return Number.isInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function safeStatus(value) {
  return typeof value === "string" && REVIEW_STATUSES.has(value) ? value : "failed";
}

function statusKind(status) {
  if (["ready", "applied"].includes(status)) return "ready";
  if (ACTIVE_STATUSES.has(status)) return "running";
  if (["not_started", "waiting_for_crawl", "apply_failed"].includes(status)) return "warning";
  if (status === "disabled") return "disabled";
  return "error";
}

function sanitizeImage(raw, imageIndex) {
  assertSafeRecord(raw, "审核图片");
  const id = safeId(raw.id);
  if (!id) throw new TypeError("审核图片 ID 无效");
  const metadata = Object.prototype.hasOwnProperty.call(raw, "metadata")
    ? assertSafeRecord(raw.metadata, "审核图片元数据")
    : {};
  const ordinal = strictCount(raw.ordinal, "审核图片序号", 100_000);
  return Object.freeze({
    id,
    ordinal: ordinal || imageIndex + 1,
    readable: strictBoolean(raw.readable, "审核图片读取状态"),
    recommended: strictBoolean(raw.recommended, "审核图片推荐状态"),
    selected: strictBoolean(raw.selected, "审核图片选择状态"),
    width: strictCount(metadata.w, "审核图片宽度", 1_000_000),
    height: strictCount(metadata.h, "审核图片高度", 1_000_000),
  });
}

function sanitizeGroup(raw, groupIndex) {
  assertSafeRecord(raw, "审核组");
  const id = safeId(raw.id);
  if (!id) throw new TypeError("审核组 ID 无效");
  const kind = typeof raw.kind === "string" && GROUP_KINDS.has(raw.kind) ? raw.kind : "single";
  if (!Array.isArray(raw.images) || raw.images.length > 1_000) {
    throw new TypeError("审核组图片列表无效");
  }
  const images = [];
  const imageIds = new Set();
  for (const item of raw.images) {
    const image = sanitizeImage(item, images.length);
    if (imageIds.has(image.id)) throw new TypeError("审核组包含重复图片 ID");
    imageIds.add(image.id);
    images.push(image);
  }
  const ordinal = strictCount(raw.ordinal, "审核组序号", 100_000);
  return Object.freeze({
    id,
    ordinal: ordinal || groupIndex + 1,
    kind,
    decided: strictBoolean(raw.decided, "审核组确认状态"),
    imageCount: images.length,
    selectedImageCount: images.filter((image) => image.selected).length,
    images: Object.freeze(images),
  });
}

export function sanitizeReviewSummary(value, batchId = undefined) {
  assertSafeRecord(value, "审核摘要");
  const resolvedBatchId = batchId ?? ownValue(value, "batch_id", ownValue(value, "batchId", ""));
  const safeBatchId = safeId(resolvedBatchId);
  if (!safeBatchId) throw new TypeError("审核批次 ID 无效");
  const status = safeStatus(value.status);
  const projected = Object.prototype.hasOwnProperty.call(value, "totalImageCount");
  const count = (legacyName, projectedName) => {
    const sourceName = projected ? projectedName : legacyName;
    const raw = Object.prototype.hasOwnProperty.call(value, sourceName) ? value[sourceName] : 0;
    return strictCount(raw, `审核摘要 ${projectedName}`);
  };
  let hasError;
  if (projected) {
    hasError = strictBoolean(value.hasError, "审核摘要错误状态");
  } else {
    const rawError = ownValue(value, "error", "");
    if (typeof rawError !== "string") throw new TypeError("审核摘要错误状态无效");
    hasError = rawError.length > 0;
  }
  return Object.freeze({
    batchId: safeBatchId,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    statusKind: statusKind(status),
    totalImageCount: count("total_image_count", "totalImageCount"),
    totalGroupCount: count("total_group_count", "totalGroupCount"),
    duplicateGroupCount: count("duplicate_group_count", "duplicateGroupCount"),
    unreadableImageCount: count("unreadable_image_count", "unreadableImageCount"),
    automaticGroupCount: count("automatic_group_count", "automaticGroupCount"),
    automaticRejectedImageCount: count("automatic_rejected_image_count", "automaticRejectedImageCount"),
    selectedImageCount: count("selected_image_count", "selectedImageCount"),
    decidedGroupCount: count("decided_group_count", "decidedGroupCount"),
    keptImageCount: count("kept_image_count", "keptImageCount"),
    rejectedImageCount: count("rejected_image_count", "rejectedImageCount"),
    failedImageCount: count("failed_image_count", "failedImageCount"),
    hasError,
  });
}

export function sanitizeReviewPage(value, { batchId, filter = "", requestedOffset = 0 } = {}) {
  assertSafeRecord(value, "审核全量快照");
  const groupsValue = assertSafeRecord(value.groups, "审核全量分组");
  if (!Array.isArray(groupsValue.items)) throw new TypeError("审核全量快照格式无效");
  const safeBatchId = safeId(batchId || value.batch_id);
  if (!safeBatchId || !FILTERS.has(filter) || requestedOffset !== 0) {
    throw new TypeError("审核全量快照参数无效");
  }
  const items = groupsValue.items;
  const offset = strictCount(groupsValue.offset, "审核全量偏移", REVIEW_GROUP_LIMIT);
  const total = strictCount(groupsValue.total, "审核全量总数", REVIEW_GROUP_LIMIT);
  const responseLimit = strictCount(groupsValue.limit, "审核全量上限", REVIEW_GROUP_LIMIT);
  if (offset !== 0 || items.length > REVIEW_GROUP_LIMIT || total !== items.length ||
      responseLimit !== items.length) {
    throw new TypeError("审核全量快照边界无效");
  }
  const summary = sanitizeReviewSummary(value, safeBatchId);
  const groups = [];
  const groupIds = new Set();
  const imageIds = new Set();
  for (const raw of items) {
    const group = sanitizeGroup(raw, groups.length);
    if (!group || groupIds.has(group.id) || (filter && group.kind !== filter)) {
      throw new TypeError("审核全量快照包含无效或重复分组");
    }
    for (const image of group.images) {
      if (imageIds.has(image.id)) throw new TypeError("审核全量快照包含重复图片 ID");
      imageIds.add(image.id);
    }
    groupIds.add(group.id);
    groups.push(group);
  }
  return Object.freeze({
    batchId: safeBatchId,
    summary,
    groups: Object.freeze(groups),
    filter,
    offset: 0,
    limit: responseLimit,
    total,
    dirty: false,
    dirtyGroupIds: Object.freeze([]),
  });
}

export function validateReviewState(value) {
  if (!isRecord(value) || !safeId(value.batchId) || !isRecord(value.summary) ||
      !Array.isArray(value.groups) || value.groups.length > REVIEW_GROUP_LIMIT ||
      !FILTERS.has(value.filter) || value.offset !== 0 || !Number.isInteger(value.limit) ||
      value.limit < 0 || value.limit !== value.groups.length ||
      value.total !== value.groups.length || typeof value.dirty !== "boolean" ||
      !Array.isArray(value.dirtyGroupIds)) {
    throw new TypeError("审核状态数据无效");
  }
  const groupIds = new Set();
  const imageIds = new Set();
  for (const group of value.groups) {
    if (!safeId(group.id) || groupIds.has(group.id) || !Array.isArray(group.images)) {
      throw new TypeError("审核分组数据无效");
    }
    groupIds.add(group.id);
    const groupImageIds = new Set();
    for (const image of group.images) {
      if (!safeId(image.id) || groupImageIds.has(image.id) || imageIds.has(image.id) ||
          Object.prototype.hasOwnProperty.call(image, "relative_path") ||
          Object.prototype.hasOwnProperty.call(image, "url")) {
        throw new TypeError("审核图片数据包含不允许的字段");
      }
      groupImageIds.add(image.id);
      imageIds.add(image.id);
    }
  }
  const dirtyIds = new Set();
  for (const groupId of value.dirtyGroupIds) {
    const normalized = safeId(groupId);
    if (!normalized || normalized !== groupId || dirtyIds.has(groupId) || !groupIds.has(groupId)) {
      throw new TypeError("待提交审核组 ID 无效、未知或重复");
    }
    dirtyIds.add(groupId);
  }
  if (value.dirty !== Boolean(value.dirtyGroupIds.length)) {
    throw new TypeError("审核脏状态与待提交组不一致");
  }
  return value;
}

function addDirtyReviewGroups(reviewState, groupIds) {
  const known = new Set(reviewState.groups.map((group) => group.id));
  const nextIds = [...reviewState.dirtyGroupIds];
  const dirty = new Set(nextIds);
  for (const groupId of groupIds) {
    if (!known.has(groupId)) continue;
    if (!dirty.has(groupId)) {
      dirty.add(groupId);
      nextIds.push(groupId);
    }
  }
  if (nextIds.length === reviewState.dirtyGroupIds.length) return reviewState;
  return { ...reviewState, dirty: true, dirtyGroupIds: nextIds };
}

export function buildReviewDecisionPayload(reviewState) {
  validateReviewState(reviewState);
  if (reviewState.summary.status !== "ready" || !reviewState.dirtyGroupIds.length) {
    throw new TypeError("当前审核快照没有可保存的决策");
  }
  const groupsById = new Map(reviewState.groups.map((group) => [group.id, group]));
  const groups = reviewState.dirtyGroupIds.map((groupId) => {
    const group = groupsById.get(groupId);
    if (!group) throw new TypeError("待提交审核组 ID 未知");
    return {
      group_id: group.id,
      selected_image_ids: group.images.filter((image) => image.selected).map((image) => image.id),
    };
  });
  if (!groups.length) throw new TypeError("审核决策 payload 不能为空");
  return { groups };
}

export function splitReviewDecisionPayload(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.groups) || !payload.groups.length) {
    throw new TypeError("审核决策 payload 不能为空");
  }
  const chunks = [];
  for (let index = 0; index < payload.groups.length; index += REVIEW_DECISION_BATCH_LIMIT) {
    chunks.push({ groups: payload.groups.slice(index, index + REVIEW_DECISION_BATCH_LIMIT) });
  }
  return chunks;
}

export function updateReviewImageSelection(reviewState, groupId, imageId, selected) {
  validateReviewState(reviewState);
  const safeGroupId = safeId(groupId);
  const safeImageId = safeId(imageId);
  let changed = false;
  const groups = reviewState.groups.map((group) => {
    if (group.id !== safeGroupId) return group;
    let groupChanged = false;
    const images = group.images.map((image) => {
      if (image.id !== safeImageId || image.selected === Boolean(selected)) return image;
      changed = true;
      groupChanged = true;
      return { ...image, selected: Boolean(selected) };
    });
    if (!groupChanged) return group;
    return {
      ...group,
      decided: false,
      selectedImageCount: images.filter((image) => image.selected).length,
      images,
    };
  });
  return changed
    ? addDirtyReviewGroups({ ...reviewState, groups }, [safeGroupId])
    : reviewState;
}

export function markReviewGroupDirty(reviewState, groupId) {
  if (!isRecord(reviewState) || !isRecord(reviewState.summary) || !Array.isArray(reviewState.groups)) {
    return reviewState;
  }
  validateReviewState(reviewState);
  const safeGroupId = safeId(groupId);
  if (!safeGroupId || !reviewState.groups.some(
    (group) => group.id === safeGroupId && group.images.length,
  )) return reviewState;
  return addDirtyReviewGroups(reviewState, [safeGroupId]);
}

export function markReviewPageSaved(reviewState, summary) {
  validateReviewState(reviewState);
  const safeSummary = sanitizeReviewSummary(summary, reviewState.batchId);
  const savedIds = new Set(reviewState.dirtyGroupIds);
  return {
    ...reviewState,
    summary: safeSummary,
    groups: reviewState.groups.map((group) => (
      savedIds.has(group.id) ? { ...group, decided: true } : group
    )),
    dirty: false,
    dirtyGroupIds: [],
  };
}

export function shouldPollReview(summary) {
  return Boolean(summary && ACTIVE_STATUSES.has(summary.status));
}

export function reviewCanList(summary) {
  return Boolean(summary && LISTABLE_STATUSES.has(summary.status));
}

export function reviewApplyCounts(summary) {
  const total = summary?.totalImageCount || 0;
  const selected = summary?.selectedImageCount || 0;
  return Object.freeze({
    automatic: summary?.automaticRejectedImageCount || 0,
    selected,
    rejected: Math.max(0, total - selected),
  });
}

export function reviewCompletionPresentation(summary, filter = "") {
  if (!isRecord(summary) || !FILTERS.has(filter)) {
    throw new TypeError("审核完成态参数无效");
  }
  const total = projectedCount(summary.totalGroupCount);
  const decided = Math.min(total, projectedCount(summary.decidedGroupCount));
  const remaining = Math.max(0, total - decided);
  if (remaining) {
    const filterLabel = REVIEW_FILTERS.find((item) => item.id === filter)?.label || "当前";
    return Object.freeze({
      batchComplete: false,
      title: "当前筛选已过一遍",
      message: `“${filterLabel}”筛选已到末组；权威摘要显示本批次仍有 ${remaining} 组未确认。请切换顶部筛选或从全量组选择器返回待确认组继续。`,
      operationMessage: `当前筛选已过一遍；本批次仍有 ${remaining} 组未确认，请切换筛选继续。`,
    });
  }
  const counts = reviewApplyCounts(summary);
  return Object.freeze({
    batchComplete: true,
    title: "本批次已全部过一遍",
    message: `自动移除 ${counts.automatic} 张；最终保留 ${counts.selected} 张，预计移出 ${counts.rejected} 张。`,
    operationMessage: "最后一组已保存，本批次已完成复核。",
  });
}

export function reviewImageUrl(batchId, imageId) {
  const batch = safeId(batchId);
  const image = safeId(imageId);
  if (!batch || !image) throw new TypeError("审核图片引用无效");
  return `/api/v1/crawls/${encodeURIComponent(batch)}/review/images/${encodeURIComponent(image)}`;
}

export function reviewErrorGuidance(error) {
  const rawCode = ownValue(error, "code", "request_failed");
  const candidateCode = typeof rawCode === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(rawCode)
    ? rawCode
    : "request_failed";
  const code = /(?:token|cookie|password|secret|authorization|oauth|session)/i.test(candidateCode)
    ? "request_failed"
    : candidateCode;
  const rawStatus = ownValue(error, "status", 0);
  const status = Number.isInteger(rawStatus) && rawStatus >= 0 && rawStatus <= 599 ? rawStatus : 0;
  const requestId = safeId(ownValue(error, "requestId", ""));
  const conflict = status === 409 || code === "review_state_conflict" || code === "crawl_not_finished";
  const missing = status === 404;
  return Object.freeze({
    code,
    requestId,
    conflict,
    missing,
    title: missing ? "审核内容不存在" : conflict ? "审核状态已变化" : "审核请求失败",
    message: status === 0 ? "无法连接到 ImageWeave 服务。" : "服务未接受本次审核操作。",
    nextStep: missing
      ? "返回已结束批次列表并选择仍存在的批次。"
      : conflict
        ? "页面将重新读取最新状态，不会覆盖其他页面已保存的结果。"
        : "保留待提交组并重试；若持续失败，请打开系统诊断。",
  });
}

export function createReviewRequestGate() {
  const channels = new Set(["page", "recent", "summary"]);
  let lifecycle = 0;
  let write = 0;
  let sequence = 0;
  const applied = new Map();
  return Object.freeze({
    beginRead(channel, batchId = "", filter = "", offset = 0) {
      if (!channels.has(channel)) throw new TypeError("未知审核请求通道");
      const safeBatchId = batchId ? safeId(batchId) : "";
      if ((channel === "page" || channel === "summary") && !safeBatchId) {
        throw new TypeError("审核读取 ID 无效");
      }
      if (!FILTERS.has(filter) || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
        throw new TypeError("审核读取参数无效");
      }
      return Object.freeze({
        lifecycle,
        write,
        sequence: ++sequence,
        channel,
        batchId: safeBatchId,
        filter,
        offset,
      });
    },
    isReadCurrent(ticket, { channel, batchId = "", filter = "", offset = 0 }) {
      const safeBatchId = batchId ? safeId(batchId) : "";
      const current = channels.has(channel) && ticket?.lifecycle === lifecycle &&
        ticket?.write === write && ticket?.sequence >= (applied.get(channel) || 0) &&
        ticket?.channel === channel && ticket?.batchId === safeBatchId &&
        ticket?.filter === filter && ticket?.offset === offset;
      if (current) applied.set(channel, ticket.sequence);
      return current;
    },
    beginWrite() {
      write += 1;
      return Object.freeze({ lifecycle, write });
    },
    isWriteCurrent(ticket) {
      return ticket?.lifecycle === lifecycle && ticket?.write === write;
    },
    advanceLifecycle() {
      lifecycle += 1;
    },
  });
}
