import { sanitizeFilterConfig, type FilterConfig } from "../filter-presets/model";
const REVIEW_STATUS_VALUES = [
  "pending", "analyzing", "auto_applying", "ready", "blocked", "failed",
  "applying", "apply_failed", "applied",
] as const;
const REVIEW_STATUS_SET = new Set<string>(REVIEW_STATUS_VALUES);
const REVIEW_FILTER_SET = new Set<string>(["", "duplicate", "single", "unreadable"]);
const REVIEW_GROUP_KIND_SET = new Set<string>(["duplicate", "single", "unreadable"]);
const ACTIVE_STATUS_SET = new Set<string>(["pending", "analyzing", "auto_applying", "applying"]);
const LISTABLE_STATUS_SET = new Set<string>(["ready", "applying", "applied", "apply_failed"]);
const MODEL_SETUP_PHASE_SET = new Set<string>(["idle", "installing", "ready", "failed"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const REVIEW_GROUP_LIMIT = 10_000;
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
export type ReviewOperation = "load" | "refresh" | "adopt" | "retry" | "finish" | "";

export interface ReviewImage {
  readonly id: string;
  readonly ordinal: number;
  readonly readable: boolean;
  readonly recommended: boolean;
  readonly selected: boolean;
  readonly width: number;
  readonly height: number;
  readonly sourceLabel: string;
  readonly relativePath: string;
  readonly failed: boolean;
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
  readonly reviewId: string;
  readonly status: ReviewStatus;
  readonly statusLabel: string;
  readonly statusKind: ReviewStatusKind;
  readonly totalImageCount: number;
  readonly totalGroupCount: number;
  readonly duplicateGroupCount: number;
  readonly unreadableImageCount: number;
  readonly automaticGroupCount: number;
  readonly automaticRejectedImageCount: number;
  /** Subset of automaticRejectedImageCount, not an additional rejection count. */
  readonly filteredImageCount: number;
  readonly selectedImageCount: number;
  readonly decidedGroupCount: number;
  readonly keptImageCount: number;
  readonly rejectedImageCount: number;
  readonly failedImageCount: number;
  readonly hasError: boolean;
}

export interface ReviewSnapshot {
  readonly reviewId: string;
  readonly version: number;
  readonly filterConfig: FilterConfig | null;
  readonly directories: readonly ReviewDirectory[];
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
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

export interface ReviewDirectory {
  readonly directoryId: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly relativePath: string;
  readonly name: string;
}

export interface ReviewOperationResult {
  readonly reviewId: string;
  readonly version: number;
  readonly filterConfig: FilterConfig | null;
  readonly summary: ReviewSummary;
  readonly directories: readonly ReviewDirectory[];
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
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
  readonly reviewId: string;
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
  beginRead(channel: ReviewRequestChannel, reviewId: string, filter: ReviewFilter, offset: number): ReviewReadTicket;
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
    beginRead(channel, reviewId, filter, offset) {
      if (!Object.hasOwn(sequences, channel) || !Number.isInteger(offset) || offset < 0 || offset > REVIEW_GROUP_LIMIT) throw new TypeError("invalid_review_request");
      if (channel === "recent") {
        if (reviewId || filter || offset !== 0) throw new TypeError("invalid_review_request");
      } else {
        validateReviewId(reviewId);
        if (!REVIEW_FILTER_SET.has(filter)) throw new TypeError("invalid_review_request");
      }
      const sequence = ++sequences[channel];
      return Object.freeze({ channel, reviewId, filter, offset, lifecycle, write, sequence });
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
  pending: "分析已排队",
  analyzing: "去重分析中",
  auto_applying: "自动去重中",
  ready: "待审核",
  applying: "正在应用",
  applied: "审核已应用",
  failed: "分析失败",
  apply_failed: "部分处理失败",
  blocked: "分析受阻",
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
  if (value === "blocked" || value === "apply_failed") return "warning";
  return "error";
}

function sanitizeImage(value: unknown, index: number): ReviewImage {
  const record = requireRecord(value, "invalid_review_image");
  const id = safeId(own(record, "id"));
  if (!id) throw new TypeError("invalid_review_image_id");
  if (own(record, "asset_id") !== id) throw new TypeError("review_image_identity_changed");
  const relativePath = displayText(own(record, "relative_path"));
  if (!relativePath || /[\\\\:\u0000-\u001f\u007f]/.test(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw new TypeError("invalid_review_image_path");
  const metadataValue = own(record, "metadata");
  const metadata = metadataValue === undefined ? { descriptors: Object.create(null) as PropertyDescriptorMap } : requireRecord(metadataValue, "invalid_review_image_metadata");
  const ordinal = strictCount(own(record, "ordinal"), "invalid_review_image_ordinal", 100_000);
  const galleryValue = own(record, "gallery");
  const gallery = galleryValue === undefined ? null : requireRecord(galleryValue, "invalid_review_image_gallery");
  return Object.freeze({
    id,
    ordinal: ordinal || index + 1,
    readable: strictBoolean(own(record, "readable"), "invalid_review_image_readable"),
    recommended: strictBoolean(own(record, "recommended"), "invalid_review_image_recommended"),
    selected: strictBoolean(own(record, "selected"), "invalid_review_image_selected"),
    width: strictCount(own(metadata, "w") ?? 0, "invalid_review_image_width", 1_000_000),
    height: strictCount(own(metadata, "h") ?? 0, "invalid_review_image_height", 1_000_000),
    sourceLabel: displayText(own(record, "source_display_name")),
    relativePath,
    failed: gallery !== null && strictBoolean(own(gallery, "hasError"), "invalid_review_image_error"),
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

export function sanitizeReviewSummary(value: unknown, expectedId?: string): ReviewSummary {
  const record = requireRecord(value, "invalid_review_summary");
  const reviewId = validateReviewId(own(record, "review_id"));
  if (expectedId !== undefined && reviewId !== validateReviewId(expectedId)) throw new TypeError("review_identity_changed");
  const count = (key: string): number => strictCount(own(record, key), `invalid_review_summary_${key}`);
  const nextStatus = status(own(record, "status"));
  return Object.freeze({
    reviewId,
    status: nextStatus,
    statusLabel: STATUS_LABELS[nextStatus],
    statusKind: statusKind(nextStatus),
    totalImageCount: count("totalImageCount"),
    totalGroupCount: count("totalGroupCount"),
    duplicateGroupCount: count("duplicateGroupCount"),
    unreadableImageCount: count("unreadableImageCount"),
    automaticGroupCount: count("automaticGroupCount"),
    automaticRejectedImageCount: count("automaticRejectedImageCount"),
    filteredImageCount: own(record, "filteredImageCount") === undefined ? 0 : count("filteredImageCount"),
    selectedImageCount: count("selectedImageCount"),
    decidedGroupCount: count("decidedGroupCount"),
    keptImageCount: count("keptImageCount"),
    rejectedImageCount: count("rejectedImageCount"),
    failedImageCount: count("failedImageCount"),
    hasError: strictBoolean(own(record, "hasError"), "invalid_review_summary_error"),
  });
}

function displayText(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw new TypeError("invalid_review_directory_text");
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function sanitizeDirectories(value: unknown): readonly ReviewDirectory[] {
  if (!Array.isArray(value) || value.length > 200) throw new TypeError("invalid_review_directories");
  const seen = new Set<string>();
  return Object.freeze(value.map((raw) => {
    const record = requireRecord(raw, "invalid_review_directory");
    const directoryId = validateReviewId(own(record, "directory_id"));
    const relativePath = displayText(own(record, "relative_path"));
    if (seen.has(directoryId) || /[\\\\:\u0000-\u001f\u007f]/.test(relativePath) || (relativePath && relativePath.split("/").some((part) => !part || part === "." || part === ".."))) throw new TypeError("invalid_review_directory_path");
    seen.add(directoryId);
    return Object.freeze({
      directoryId,
      sourceId: validateReviewId(own(record, "source_id")),
      sourceLabel: displayText(own(record, "source_display_name")),
      relativePath,
      name: displayText(own(record, "name")),
    });
  }));
}

function reviewIdentity(value: unknown, profile: string, expectedId?: string): ReviewOperationResult {
  const record = requireRecord(value, "invalid_review_response");
  if (own(record, "response_profile") !== profile) throw new TypeError("invalid_review_profile");
  const summary = sanitizeReviewSummary(value, expectedId);
  const version = strictCount(own(record, "version"), "invalid_review_version", Number.MAX_SAFE_INTEGER);
  if (!version) throw new TypeError("invalid_review_version");
  return Object.freeze({
    reviewId: summary.reviewId,
    version,
    filterConfig: own(record, "filter_config") == null ? null : sanitizeFilterConfig(own(record, "filter_config")),
    summary,
    directories: sanitizeDirectories(own(record, "directories")),
    createdAt: safeTime(own(record, "created_at")),
    updatedAt: safeTime(own(record, "updated_at")),
  });
}

export function sanitizeReviewOperation(value: unknown, expectedId?: string): ReviewOperationResult {
  return reviewIdentity(value, "desktop-gallery-review-operation-v1", expectedId);
}

export function sanitizeReviewPageChunk(value: unknown, {
  reviewId,
  filter = "",
  requestedOffset = 0,
}: {
  readonly reviewId: string;
  readonly filter?: ReviewFilter;
  readonly requestedOffset?: number;
}): ReviewPageChunk {
  const record = requireRecord(value, "invalid_review_page");
  const groupsRecord = requireRecord(own(record, "groups"), "invalid_review_page_groups");
  const items = own(groupsRecord, "items");
  const safeReviewId = validateReviewId(reviewId);
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
    ...reviewIdentity(value, "desktop-gallery-review-v1", safeReviewId),
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
  const reviewId = first.snapshot.reviewId;
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
    if (chunk.offset !== expectedOffset || chunk.total !== total || snapshot.reviewId !== reviewId || snapshot.version !== first.snapshot.version || JSON.stringify(snapshot.directories) !== JSON.stringify(first.snapshot.directories) || JSON.stringify(snapshot.filterConfig) !== JSON.stringify(first.snapshot.filterConfig) || snapshot.filter !== filter || JSON.stringify(snapshot.summary) !== serializedSummary) {
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
    ...first.snapshot,
    groupOrder: Object.freeze(groupOrder),
    groups: Object.freeze(groups) as Readonly<Record<string, ReviewGroup>>,
    filter,
    dirty: false,
    dirtyGroupIds: Object.freeze([]),
  });
}

export function sanitizeReviewPage(value: unknown, options: {
  readonly reviewId: string;
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
  if (!Number.isSafeInteger(value.version) || value.version < 1 || !Array.isArray(value.directories)) throw new TypeError("invalid_review_snapshot");
  if (!safeId(value.reviewId) || value.summary.reviewId !== value.reviewId || !REVIEW_FILTER_SET.has(value.filter) || !Array.isArray(value.groupOrder) || value.groupOrder.length > REVIEW_GROUP_LIMIT || !safeRecord(value.groups) || !Array.isArray(value.dirtyGroupIds)) {
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

export function shouldPollReview(summary: ReviewSummary | null): boolean {
  return Boolean(summary && ACTIVE_STATUS_SET.has(summary.status));
}

export function reviewCanList(summary: ReviewSummary | null): boolean {
  return Boolean(summary && LISTABLE_STATUS_SET.has(summary.status));
}

export function reviewImagePath(reviewId: string, imageId: string): string {
  return `/api/v1/gallery/reviews/${encodeURIComponent(validateReviewId(reviewId))}/images/${encodeURIComponent(validateReviewId(imageId))}`;
}

export function resolveReviewCommand(key: string, {
  editable,
  readOnly,
  hasImages,
}: {
  readonly editable: boolean;
  readonly readOnly: boolean;
  readonly hasImages: boolean;
}): "previous-group" | "focus-previous-image" | "focus-next-image" | "toggle-active-image" | "accept-advance" | "browse-next-group" | null {
  if (key === "Escape" || key === "Backspace") return "previous-group";
  if (hasImages && key === "ArrowLeft") return "focus-previous-image";
  if (hasImages && key === "ArrowRight") return "focus-next-image";
  if (key === " " && editable) return "toggle-active-image";
  if (key === "Enter" && editable) return "accept-advance";
  if (key === "Enter" && readOnly) return "browse-next-group";
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
    rejected: Math.max(0, summary.totalImageCount - summary.selectedImageCount - summary.automaticRejectedImageCount),
  });
}

export function reviewCompletionPresentation(summary: ReviewSummary, filter: ReviewFilter): Readonly<{ reviewComplete: boolean; title: string; message: string }> {
  const remaining = Math.max(0, summary.totalGroupCount - Math.min(summary.totalGroupCount, summary.decidedGroupCount));
  if (remaining) {
    const label = REVIEW_FILTERS.find((item) => item.id === filter)?.label ?? "当前";
    return Object.freeze({ reviewComplete: false, title: "当前筛选已到最后一组", message: `“${label}”仍有 ${remaining} 组未采纳；可切换筛选继续。` });
  }
  const counts = reviewApplyCounts(summary);
  return Object.freeze({ reviewComplete: true, title: "本次任务已全部采纳", message: `原位保留 ${counts.selected} 张，回收 ${counts.automatic + counts.rejected} 张；点击“完成”结束本次任务。` });
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
  const conflict = safeStatus === 409 || code === "review_state_conflict" || code === "review_page_changed" || code === "review_identity_changed";
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
      ? "刷新审核任务列表并打开仍存在的任务。"
      : conflict
        ? "放弃冲突草稿并重新读取最新状态，或保留草稿稍后重试。"
        : "保留待提交组并重试；若持续失败，请打开系统诊断。",
  });
}

export function deriveReviewPresentation(phase: ReviewPhase, summary: ReviewSummary | null): Readonly<{ kind: ReviewStatusKind; label: string; message: string }> {
  if (phase === "loading") return Object.freeze({ kind: "running", label: "正在加载", message: "正在读取审核任务与图片。" });
  if (phase === "writing") return Object.freeze({ kind: "running", label: "正在写入", message: "正在落地采纳结果。" });
  if (phase === "error") return Object.freeze({ kind: "error", label: "审核读取失败", message: "草稿和最后一次安全快照已保留。" });
  if (!summary) return Object.freeze({ kind: "disabled", label: "尚无去重任务", message: "请在图库勾选图片或目录发起去重。" });
  return Object.freeze({ kind: summary.statusKind, label: summary.statusLabel, message: reviewCanList(summary) ? "当前筛选的全部审核组已加载。" : "分析会自动开始；失败或受阻时可重试。" });
}
