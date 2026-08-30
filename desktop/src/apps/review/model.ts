const REVIEW_STATUS_VALUES = [
  "not_started", "waiting_for_crawl", "pending", "analyzing", "auto_applying",
  "ready", "applying", "applied", "failed", "apply_failed", "disabled",
] as const;
const REVIEW_STATUS_SET = new Set<string>(REVIEW_STATUS_VALUES);
const REVIEW_FILTER_SET = new Set<string>(["", "duplicate", "single", "unreadable"]);
const REVIEW_GROUP_KIND_SET = new Set<string>(["duplicate", "single", "unreadable"]);
const ACTIVE_STATUS_SET = new Set<string>(["pending", "analyzing", "auto_applying", "applying"]);
const LISTABLE_STATUS_SET = new Set<string>(["ready", "applying", "applied", "apply_failed"]);
const TERMINAL_BATCH_STATUS_SET = new Set<string>(["succeeded", "completed_with_errors", "cancelled"]);
const MODEL_SETUP_PHASE_SET = new Set<string>(["idle", "installing", "ready", "failed"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const REVIEW_GROUP_LIMIT = 10_000;
export const REVIEW_DECISION_BATCH_LIMIT = 50;
export const REVIEW_POLL_INTERVAL_MS = 1_500;
export const REVIEW_FILTERS = Object.freeze([
  Object.freeze({ id: "", label: "全部" }),
  Object.freeze({ id: "duplicate", label: "重复组" }),
  Object.freeze({ id: "single", label: "独立图片" }),
  Object.freeze({ id: "unreadable", label: "读取失败" }),
] as const);

export type ReviewStatus = typeof REVIEW_STATUS_VALUES[number];
export type ReviewFilter = typeof REVIEW_FILTERS[number]["id"];
export type ReviewGroupKind = "duplicate" | "single" | "unreadable";
export type ReviewStatusKind = "ready" | "running" | "warning" | "error" | "disabled";
export type ReviewPhase = "empty" | "loading" | "content" | "polling" | "writing" | "error";
export type ReviewOperation = "load" | "refresh" | "save" | "start" | "retry" | "apply" | "";

export interface ReviewImage {
  readonly id: string;
  readonly ordinal: number;
  readonly readable: boolean;
  readonly recommended: boolean;
  readonly selected: boolean;
  readonly width: number;
  readonly height: number;
}

export interface ReviewGroup {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: ReviewGroupKind;
  readonly decided: boolean;
  readonly imageOrder: readonly string[];
  readonly images: Readonly<Record<string, ReviewImage>>;
  readonly imageCount: number;
  readonly selectedImageCount: number;
}

export interface ReviewSummary {
  readonly batchId: string;
  readonly status: ReviewStatus;
  readonly statusLabel: string;
  readonly statusKind: ReviewStatusKind;
  readonly totalImageCount: number;
  readonly totalGroupCount: number;
  readonly duplicateGroupCount: number;
  readonly unreadableImageCount: number;
  readonly automaticGroupCount: number;
  readonly automaticRejectedImageCount: number;
  readonly selectedImageCount: number;
  readonly decidedGroupCount: number;
  readonly keptImageCount: number;
  readonly rejectedImageCount: number;
  readonly failedImageCount: number;
  readonly hasError: boolean;
}

export interface ReviewSnapshot {
  readonly batchId: string;
  readonly summary: ReviewSummary;
  readonly groupOrder: readonly string[];
  readonly groups: Readonly<Record<string, ReviewGroup>>;
  readonly filter: ReviewFilter;
  readonly dirty: boolean;
  readonly dirtyGroupIds: readonly string[];
}

export interface ReviewPageChunk {
  readonly snapshot: ReviewSnapshot;
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}

export interface ReviewRecentBatch {
  readonly id: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly createdAt: number | null;
  readonly terminal: boolean;
}

export type ModelSetupPhase = "idle" | "installing" | "ready" | "failed";

export interface ModelSetupSnapshot {
  readonly phase: ModelSetupPhase;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly usingProxy: boolean;
  readonly downloadedBytes: number;
  readonly expectedBytes: number;
  readonly message: string;
  readonly models: Readonly<{
    sscd: Readonly<{ installed: boolean }>;
    dino: Readonly<{ installed: boolean }>;
  }>;
}

export interface ReviewDecisionPayload {
  readonly groups: readonly Readonly<{
    group_id: string;
    selected_image_ids: readonly string[];
  }>[];
}

export interface ReviewErrorPresentation {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  readonly conflict: boolean;
  readonly missing: boolean;
  readonly title: string;
  readonly message: string;
  readonly nextStep: string;
}

export type ReviewRequestChannel = "page" | "recent" | "summary";

export interface ReviewReadTicket {
  readonly channel: ReviewRequestChannel;
  readonly batchId: string;
  readonly filter: ReviewFilter;
  readonly offset: number;
  readonly lifecycle: number;
  readonly write: number;
  readonly sequence: number;
}

export interface ReviewWriteTicket {
  readonly lifecycle: number;
  readonly write: number;
}

export interface ReviewRequestGate {
  beginRead(channel: ReviewRequestChannel, batchId: string, filter: ReviewFilter, offset: number): ReviewReadTicket;
  isReadCurrent(ticket: ReviewReadTicket): boolean;
  beginWrite(): ReviewWriteTicket;
  isWriteCurrent(ticket: ReviewWriteTicket): boolean;
  advanceLifecycle(): void;
}

export function createReviewRequestGate(): ReviewRequestGate {
  let lifecycle = 0;
  let write = 0;
  const sequences: Record<ReviewRequestChannel, number> = { page: 0, recent: 0, summary: 0 };

  const gate: ReviewRequestGate = {
    beginRead(channel, batchId, filter, offset) {
      if (!Object.hasOwn(sequences, channel) || !Number.isInteger(offset) || offset < 0 || offset > REVIEW_GROUP_LIMIT) throw new TypeError("invalid_review_request");
      if (channel === "recent") {
        if (batchId || filter || offset !== 0) throw new TypeError("invalid_review_request");
      } else {
        validateReviewId(batchId);
        if (!REVIEW_FILTER_SET.has(filter)) throw new TypeError("invalid_review_request");
      }
      const sequence = ++sequences[channel];
      return Object.freeze({ channel, batchId, filter, offset, lifecycle, write, sequence });
    },
    isReadCurrent(ticket) {
      return ticket.lifecycle === lifecycle
        && ticket.write === write
        && ticket.sequence === sequences[ticket.channel];
    },
    beginWrite() {
      write += 1;
      return Object.freeze({ lifecycle, write });
    },
    isWriteCurrent(ticket) {
      return ticket.lifecycle === lifecycle && ticket.write === write;
    },
    advanceLifecycle() {
      lifecycle += 1;
      write += 1;
    },
  };
  return Object.freeze(gate);
}

const STATUS_LABELS: Readonly<Record<ReviewStatus, string>> = Object.freeze({
  not_started: "去重未开始",
  waiting_for_crawl: "待开始分析",
  pending: "分析已排队",
  analyzing: "去重分析中",
  auto_applying: "自动去重中",
  ready: "待审核",
  applying: "正在应用",
  applied: "审核已应用",
  failed: "分析失败",
  apply_failed: "部分处理失败",
  disabled: "审核未启用",
});

const BATCH_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  succeeded: "成功",
  completed_with_errors: "部分失败",
  cancelled: "已取消",
});

interface SafeRecord {
  readonly descriptors: PropertyDescriptorMap;
}

function safeRecord(value: unknown): SafeRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && !(value instanceof Error)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) return null;
      if (!Object.hasOwn(descriptors[key], "value")) return null;
    }
    return { descriptors };
  } catch {
    return null;
  }
}

function requireRecord(value: unknown, code: string): SafeRecord {
  const record = safeRecord(value);
  if (!record) throw new TypeError(code);
  return record;
}

function own(record: SafeRecord, key: string): unknown {
  const descriptor = record.descriptors[key];
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function safeId(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return SAFE_ID_PATTERN.test(text) && !/(?:authorization|cookie|credential|password|secret|token|oauth|session)/i.test(text) ? text : "";
}

export function validateReviewId(value: unknown): string {
  const id = safeId(value);
  if (!id || id !== value) throw new TypeError("invalid_review_id");
  return id;
}

function strictCount(value: unknown, code: string, maximum = 1_000_000_000): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(code);
  }
  return value as number;
}

function strictBoolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(code);
  return value;
}

export function sanitizeModelSetup(value: unknown): ModelSetupSnapshot {
  const record = requireRecord(value, "invalid_model_setup");
  const models = requireRecord(own(record, "models"), "invalid_model_setup_models");
  const sscd = requireRecord(own(models, "sscd"), "invalid_model_setup_sscd");
  const dino = requireRecord(own(models, "dino"), "invalid_model_setup_dino");
  const rawPhase = own(record, "phase");
  const phase: ModelSetupPhase = typeof rawPhase === "string"
    && MODEL_SETUP_PHASE_SET.has(rawPhase)
    ? rawPhase as ModelSetupPhase
    : "failed";
  const expectedBytes = strictCount(own(record, "expected_bytes"), "invalid_model_setup_expected_bytes");
  const downloadedBytes = strictCount(own(record, "downloaded_bytes"), "invalid_model_setup_downloaded_bytes");
  if (!expectedBytes || downloadedBytes > expectedBytes) throw new TypeError("invalid_model_setup_progress");
  const rawMessage = own(record, "message");
  const message = typeof rawMessage === "string"
    ? rawMessage.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500)
    : "";
  return Object.freeze({
    phase,
    enabled: strictBoolean(own(record, "enabled"), "invalid_model_setup_enabled"),
    installed: strictBoolean(own(record, "installed"), "invalid_model_setup_installed"),
    usingProxy: strictBoolean(own(record, "using_proxy"), "invalid_model_setup_proxy"),
    downloadedBytes,
    expectedBytes,
    message,
    models: Object.freeze({
      sscd: Object.freeze({ installed: strictBoolean(own(sscd, "installed"), "invalid_model_setup_sscd") }),
      dino: Object.freeze({ installed: strictBoolean(own(dino, "installed"), "invalid_model_setup_dino") }),
    }),
  });
}

function safeTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000_000_000
    ? value
    : null;
}

function status(value: unknown): ReviewStatus {
  return typeof value === "string" && REVIEW_STATUS_SET.has(value) ? value as ReviewStatus : "failed";
}

function statusKind(value: ReviewStatus): ReviewStatusKind {
  if (value === "ready" || value === "applied") return "ready";
  if (ACTIVE_STATUS_SET.has(value)) return "running";
  if (value === "not_started" || value === "waiting_for_crawl" || value === "apply_failed") return "warning";
  if (value === "disabled") return "disabled";
  return "error";
}

function sanitizeImage(value: unknown, index: number): ReviewImage {
  const record = requireRecord(value, "invalid_review_image");
  const id = safeId(own(record, "id"));
  if (!id) throw new TypeError("invalid_review_image_id");
  const metadataValue = own(record, "metadata");
  const metadata = metadataValue === undefined ? { descriptors: Object.create(null) as PropertyDescriptorMap } : requireRecord(metadataValue, "invalid_review_image_metadata");
  const ordinal = strictCount(own(record, "ordinal"), "invalid_review_image_ordinal", 100_000);
  return Object.freeze({
    id,
    ordinal: ordinal || index + 1,
    readable: strictBoolean(own(record, "readable"), "invalid_review_image_readable"),
    recommended: strictBoolean(own(record, "recommended"), "invalid_review_image_recommended"),
    selected: strictBoolean(own(record, "selected"), "invalid_review_image_selected"),
    width: strictCount(own(metadata, "w") ?? 0, "invalid_review_image_width", 1_000_000),
    height: strictCount(own(metadata, "h") ?? 0, "invalid_review_image_height", 1_000_000),
  });
}

function sanitizeGroup(value: unknown, index: number): ReviewGroup {
  const record = requireRecord(value, "invalid_review_group");
  const id = safeId(own(record, "id"));
  const kindValue = own(record, "kind");
  const imagesValue = own(record, "images");
  if (!id || !Array.isArray(imagesValue) || imagesValue.length > 1_000) {
    throw new TypeError("invalid_review_group");
  }
  const kind = typeof kindValue === "string" && REVIEW_GROUP_KIND_SET.has(kindValue)
    ? kindValue as ReviewGroupKind
    : "single";
  const images = Object.create(null) as Record<string, ReviewImage>;
  const imageOrder: string[] = [];
  for (const rawImage of imagesValue) {
    const image = sanitizeImage(rawImage, imageOrder.length);
    if (images[image.id]) throw new TypeError("duplicate_review_image");
    images[image.id] = image;
    imageOrder.push(image.id);
  }
  const ordinal = strictCount(own(record, "ordinal"), "invalid_review_group_ordinal", 100_000);
  const frozenImages = Object.freeze(images) as Readonly<Record<string, ReviewImage>>;
  return Object.freeze({
    id,
    ordinal: ordinal || index + 1,
    kind,
    decided: strictBoolean(own(record, "decided"), "invalid_review_group_decided"),
    imageOrder: Object.freeze(imageOrder),
    images: frozenImages,
    imageCount: imageOrder.length,
    selectedImageCount: imageOrder.filter((imageId) => frozenImages[imageId].selected).length,
  });
}

export function sanitizeReviewSummary(value: unknown, batchId?: string): ReviewSummary {
  const record = requireRecord(value, "invalid_review_summary");
  const resolvedBatchId = batchId ?? safeId(own(record, "batch_id"));
  const safeBatchId = safeId(resolvedBatchId);
  if (!safeBatchId) throw new TypeError("invalid_review_batch_id");
  const projected = Object.hasOwn(record.descriptors, "totalImageCount");
  const count = (legacyKey: string, projectedKey: string): number => strictCount(
    own(record, projected ? projectedKey : legacyKey) ?? 0,
    `invalid_review_summary_${projectedKey}`,
  );
  const nextStatus = status(own(record, "status"));
  const rawError = projected ? own(record, "hasError") : own(record, "error") ?? "";
  const hasError = projected
    ? strictBoolean(rawError, "invalid_review_summary_error")
    : typeof rawError === "string"
      ? rawError.length > 0
      : (() => { throw new TypeError("invalid_review_summary_error"); })();
  return Object.freeze({
    batchId: safeBatchId,
    status: nextStatus,
    statusLabel: STATUS_LABELS[nextStatus],
    statusKind: statusKind(nextStatus),
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

export function sanitizeReviewPageChunk(value: unknown, {
  batchId,
  filter = "",
  requestedOffset = 0,
}: {
  readonly batchId: string;
  readonly filter?: ReviewFilter;
  readonly requestedOffset?: number;
}): ReviewPageChunk {
  const record = requireRecord(value, "invalid_review_page");
  const groupsRecord = requireRecord(own(record, "groups"), "invalid_review_page_groups");
  const items = own(groupsRecord, "items");
  const safeBatchId = validateReviewId(batchId);
  if (!Array.isArray(items) || !REVIEW_FILTER_SET.has(filter) || !Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > REVIEW_GROUP_LIMIT) {
    throw new TypeError("invalid_review_page");
  }
  const offset = strictCount(own(groupsRecord, "offset"), "invalid_review_page_offset", REVIEW_GROUP_LIMIT);
  const total = strictCount(own(groupsRecord, "total"), "invalid_review_page_total", REVIEW_GROUP_LIMIT);
  const limit = strictCount(own(groupsRecord, "limit"), "invalid_review_page_limit", REVIEW_GROUP_LIMIT);
  if (offset !== requestedOffset || items.length > limit || offset + items.length > total || (offset < total && items.length === 0)) {
    throw new TypeError("invalid_review_page_boundary");
  }
  const groups = Object.create(null) as Record<string, ReviewGroup>;
  const groupOrder: string[] = [];
  const imageIds = new Set<string>();
  for (const rawGroup of items) {
    const group = sanitizeGroup(rawGroup, groupOrder.length);
    if (groups[group.id] || (filter && group.kind !== filter)) throw new TypeError("invalid_review_page_group");
    for (const imageId of group.imageOrder) {
      if (imageIds.has(imageId)) throw new TypeError("duplicate_review_image");
      imageIds.add(imageId);
    }
    groups[group.id] = group;
    groupOrder.push(group.id);
  }
  const snapshot = Object.freeze({
    batchId: safeBatchId,
    summary: sanitizeReviewSummary(value, safeBatchId),
    groupOrder: Object.freeze(groupOrder),
    groups: Object.freeze(groups) as Readonly<Record<string, ReviewGroup>>,
    filter,
    dirty: false,
    dirtyGroupIds: Object.freeze([]),
  });
  return Object.freeze({ snapshot, offset, limit, total });
}

export function mergeReviewPageChunks(chunks: readonly ReviewPageChunk[]): ReviewSnapshot {
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > REVIEW_GROUP_LIMIT) throw new TypeError("invalid_review_pages");
  const first = chunks[0];
  const batchId = first.snapshot.batchId;
  const filter = first.snapshot.filter;
  const total = first.total;
  const summary = first.snapshot.summary;
  const serializedSummary = JSON.stringify(summary);
  const groups = Object.create(null) as Record<string, ReviewGroup>;
  const groupOrder: string[] = [];
  const imageIds = new Set<string>();
  let expectedOffset = 0;
  for (const chunk of chunks) {
    const snapshot = validateReviewSnapshot(chunk.snapshot);
    if (chunk.offset !== expectedOffset || chunk.total !== total || snapshot.batchId !== batchId || snapshot.filter !== filter || JSON.stringify(snapshot.summary) !== serializedSummary) {
      throw new TypeError("review_page_changed");
    }
    for (const groupId of snapshot.groupOrder) {
      const group = snapshot.groups[groupId];
      if (Object.hasOwn(groups, groupId)) throw new TypeError("duplicate_review_group");
      for (const imageId of group.imageOrder) {
        if (imageIds.has(imageId)) throw new TypeError("duplicate_review_image");
        imageIds.add(imageId);
      }
      groups[groupId] = group;
      groupOrder.push(groupId);
    }
    expectedOffset += snapshot.groupOrder.length;
  }
  if (expectedOffset !== total) throw new TypeError("incomplete_review_pages");
  return Object.freeze({
    batchId,
    summary,
    groupOrder: Object.freeze(groupOrder),
    groups: Object.freeze(groups) as Readonly<Record<string, ReviewGroup>>,
    filter,
    dirty: false,
    dirtyGroupIds: Object.freeze([]),
  });
}

export function sanitizeReviewPage(value: unknown, options: {
  readonly batchId: string;
  readonly filter?: ReviewFilter;
  readonly requestedOffset?: number;
}): ReviewSnapshot {
  const chunk = sanitizeReviewPageChunk(value, options);
  if (chunk.offset !== 0 || chunk.total !== chunk.snapshot.groupOrder.length || chunk.limit !== chunk.snapshot.groupOrder.length) {
    throw new TypeError("invalid_review_page_boundary");
  }
  return chunk.snapshot;
}

export function validateReviewSnapshot(value: ReviewSnapshot): ReviewSnapshot {
  if (!safeId(value.batchId) || value.summary.batchId !== value.batchId || !REVIEW_FILTER_SET.has(value.filter) || !Array.isArray(value.groupOrder) || value.groupOrder.length > REVIEW_GROUP_LIMIT || !safeRecord(value.groups) || !Array.isArray(value.dirtyGroupIds)) {
    throw new TypeError("invalid_review_snapshot");
  }
  const seenGroups = new Set<string>();
  const seenImages = new Set<string>();
  for (const groupId of value.groupOrder) {
    const group = value.groups[groupId];
    if (!group || group.id !== groupId || seenGroups.has(groupId) || !Array.isArray(group.imageOrder)) throw new TypeError("invalid_review_group");
    seenGroups.add(groupId);
    for (const imageId of group.imageOrder) {
      const image = group.images[imageId];
      if (!image || image.id !== imageId || seenImages.has(imageId)) throw new TypeError("invalid_review_image");
      seenImages.add(imageId);
    }
  }
  const dirty = new Set<string>();
  for (const groupId of value.dirtyGroupIds) {
    if (!seenGroups.has(groupId) || dirty.has(groupId)) throw new TypeError("invalid_review_dirty_group");
    dirty.add(groupId);
  }
  if (value.dirty !== Boolean(value.dirtyGroupIds.length)) throw new TypeError("invalid_review_dirty_state");
  return value;
}

function addDirtyGroup(snapshot: ReviewSnapshot, groupId: string): readonly string[] {
  return snapshot.dirtyGroupIds.includes(groupId)
    ? snapshot.dirtyGroupIds
    : Object.freeze([...snapshot.dirtyGroupIds, groupId]);
}

export function updateReviewImageSelection(snapshot: ReviewSnapshot, groupId: string, imageId: string, selected: boolean): ReviewSnapshot {
  validateReviewSnapshot(snapshot);
  const group = snapshot.groups[safeId(groupId)];
  const image = group?.images[safeId(imageId)];
  if (!group || !image || image.selected === selected) return snapshot;
  const nextImage = Object.freeze({ ...image, selected });
  const images = Object.freeze({ ...group.images, [image.id]: nextImage });
  const nextGroup = Object.freeze({
    ...group,
    decided: false,
    images,
    selectedImageCount: group.imageOrder.filter((id) => images[id].selected).length,
  });
  const dirtyGroupIds = addDirtyGroup(snapshot, group.id);
  return Object.freeze({
    ...snapshot,
    groups: Object.freeze({ ...snapshot.groups, [group.id]: nextGroup }),
    dirty: true,
    dirtyGroupIds,
  });
}

export function confirmReviewGroup(snapshot: ReviewSnapshot, groupId: string): ReviewSnapshot {
  validateReviewSnapshot(snapshot);
  const group = snapshot.groups[safeId(groupId)];
  if (!group || !group.imageOrder.length) return snapshot;
  const dirtyGroupIds = addDirtyGroup(snapshot, group.id);
  const nextGroup = group.decided ? group : Object.freeze({ ...group, decided: true });
  if (nextGroup === group && dirtyGroupIds === snapshot.dirtyGroupIds) return snapshot;
  return Object.freeze({
    ...snapshot,
    groups: nextGroup === group ? snapshot.groups : Object.freeze({ ...snapshot.groups, [group.id]: nextGroup }),
    dirty: true,
    dirtyGroupIds,
  });
}

export function buildReviewDecisionPayload(snapshot: ReviewSnapshot): ReviewDecisionPayload {
  validateReviewSnapshot(snapshot);
  if (snapshot.summary.status !== "ready" || !snapshot.dirtyGroupIds.length) throw new TypeError("invalid_review_decisions");
  return Object.freeze({
    groups: Object.freeze(snapshot.dirtyGroupIds.map((groupId) => {
      const group = snapshot.groups[groupId];
      return Object.freeze({
        group_id: group.id,
        selected_image_ids: Object.freeze(group.imageOrder.filter((imageId) => group.images[imageId].selected)),
      });
    })),
  });
}

export function splitReviewDecisionPayload(payload: ReviewDecisionPayload): readonly ReviewDecisionPayload[] {
  if (!payload || !Array.isArray(payload.groups) || !payload.groups.length) throw new TypeError("invalid_review_decisions");
  const chunks: ReviewDecisionPayload[] = [];
  for (let index = 0; index < payload.groups.length; index += REVIEW_DECISION_BATCH_LIMIT) {
    chunks.push(Object.freeze({ groups: Object.freeze(payload.groups.slice(index, index + REVIEW_DECISION_BATCH_LIMIT)) }));
  }
  return Object.freeze(chunks);
}

export function sanitizeReviewRecentBatches(value: unknown): readonly ReviewRecentBatch[] {
  const record = requireRecord(value, "invalid_review_recent");
  const items = own(record, "items");
  if (!Array.isArray(items)) throw new TypeError("invalid_review_recent");
  const result: ReviewRecentBatch[] = [];
  const seen = new Set<string>();
  for (const raw of items.slice(0, 30)) {
    const item = safeRecord(raw);
    if (!item) continue;
    const id = safeId(own(item, "id"));
    const itemStatus = typeof own(item, "status") === "string" ? own(item, "status") as string : "failed";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(Object.freeze({
      id,
      status: itemStatus,
      statusLabel: BATCH_STATUS_LABELS[itemStatus] ?? "未结束",
      createdAt: safeTime(own(item, "created_at")),
      terminal: TERMINAL_BATCH_STATUS_SET.has(itemStatus),
    }));
  }
  return Object.freeze(result);
}

export function shouldPollReview(summary: ReviewSummary | null): boolean {
  return Boolean(summary && ACTIVE_STATUS_SET.has(summary.status));
}

export function reviewCanList(summary: ReviewSummary | null): boolean {
  return Boolean(summary && LISTABLE_STATUS_SET.has(summary.status));
}

export function reviewImagePath(batchId: string, imageId: string): string {
  return `/api/v1/crawls/${encodeURIComponent(validateReviewId(batchId))}/review/images/${encodeURIComponent(validateReviewId(imageId))}`;
}

export function resolveReviewCommand(key: string, {
  editable,
  readOnly,
  hasImages,
  loupeAvailable,
}: {
  readonly editable: boolean;
  readonly readOnly: boolean;
  readonly hasImages: boolean;
  readonly loupeAvailable: boolean;
}): "previous-group" | "focus-previous-image" | "focus-next-image" | "toggle-active-image" | "accept-advance" | "browse-next-group" | "toggle-loupe" | null {
  if (key === "Escape" || key === "Backspace") return "previous-group";
  if (hasImages && key === "ArrowLeft") return "focus-previous-image";
  if (hasImages && key === "ArrowRight") return "focus-next-image";
  if (key === " " && editable) return "toggle-active-image";
  if (key === "Enter" && editable) return "accept-advance";
  if (key === "Enter" && readOnly) return "browse-next-group";
  if ((key === "x" || key === "X") && loupeAvailable) return "toggle-loupe";
  return null;
}

export function reviewStepIndex(index: number, count: number, direction: -1 | 1): number | null {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 0 || index < 0 || (count > 0 && index >= count)) throw new TypeError("invalid_review_position");
  const next = index + direction;
  return next >= 0 && next < count ? next : null;
}

export function reviewApplyCounts(summary: ReviewSummary): Readonly<{ automatic: number; selected: number; rejected: number }> {
  return Object.freeze({
    automatic: summary.automaticRejectedImageCount,
    selected: summary.selectedImageCount,
    rejected: Math.max(0, summary.totalImageCount - summary.selectedImageCount),
  });
}

export function reviewCompletionPresentation(summary: ReviewSummary, filter: ReviewFilter): Readonly<{ batchComplete: boolean; title: string; message: string }> {
  const remaining = Math.max(0, summary.totalGroupCount - Math.min(summary.totalGroupCount, summary.decidedGroupCount));
  if (remaining) {
    const label = REVIEW_FILTERS.find((item) => item.id === filter)?.label ?? "当前";
    return Object.freeze({ batchComplete: false, title: "当前筛选已过一遍", message: `“${label}”仍有 ${remaining} 组未确认；请切换筛选继续。` });
  }
  const counts = reviewApplyCounts(summary);
  return Object.freeze({ batchComplete: true, title: "本批次已全部过一遍", message: `自动移除 ${counts.automatic} 张；最终保留 ${counts.selected} 张，预计移出 ${counts.rejected} 张。` });
}

function errorField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function reviewErrorPresentation(error: unknown): ReviewErrorPresentation {
  const rawCode = errorField(error, "code");
  const candidate = typeof rawCode === "string" && REQUEST_ID_PATTERN.test(rawCode) ? rawCode : "request_failed";
  const code = /(?:token|cookie|password|secret|authorization|oauth|session)/i.test(candidate) ? "request_failed" : candidate;
  const rawStatus = errorField(error, "status");
  const safeStatus = Number.isInteger(rawStatus) && (rawStatus as number) >= 0 && (rawStatus as number) <= 599 ? rawStatus as number : 0;
  const rawRequestId = errorField(error, "requestId");
  const requestId = typeof rawRequestId === "string" && REQUEST_ID_PATTERN.test(rawRequestId) ? rawRequestId : "";
  const conflict = safeStatus === 409 || code === "review_state_conflict" || code === "crawl_not_finished";
  const missing = safeStatus === 404;
  return Object.freeze({
    code,
    status: safeStatus,
    requestId,
    conflict,
    missing,
    title: missing ? "审核内容不存在" : conflict ? "审核状态已变化" : "审核请求失败",
    message: safeStatus === 0 ? "无法连接到 LDOS 服务。" : "服务未接受本次审核操作。",
    nextStep: missing
      ? "返回已结束批次列表并选择仍存在的批次。"
      : conflict
        ? "放弃冲突草稿并重新读取最新状态，或保留草稿稍后重试。"
        : "保留待提交组并重试；若持续失败，请打开系统诊断。",
  });
}

export function deriveReviewPresentation(phase: ReviewPhase, summary: ReviewSummary | null): Readonly<{ kind: ReviewStatusKind; label: string; message: string }> {
  if (phase === "loading") return Object.freeze({ kind: "running", label: "正在加载", message: "正在读取已结束批次与审核工作区。" });
  if (phase === "writing") return Object.freeze({ kind: "running", label: "正在写入", message: "写入完成后将重新读取权威审核快照。" });
  if (phase === "error") return Object.freeze({ kind: "error", label: "审核读取失败", message: "草稿和最后一次安全快照已保留。" });
  if (!summary) return Object.freeze({ kind: "disabled", label: "尚未选择批次", message: "选择一个已结束批次；打开批次不会自动开始分析。" });
  return Object.freeze({ kind: summary.statusKind, label: summary.statusLabel, message: reviewCanList(summary) ? "当前筛选的全部审核组已加载。" : "请根据状态启动、等待或重试去重分析。" });
}
