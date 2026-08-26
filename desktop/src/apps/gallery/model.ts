const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STATE_KEYS = new Set(["phase", "collection", "query", "sort", "mode", "inspectorOpen"]);
const PATCH_KEYS = new Set(["collection", "query", "sort", "mode", "inspectorOpen"]);
const COLLECTIONS = new Set<GalleryCollection>(["library", "favorites", "sources"]);
const SORTS = new Set<GallerySort>(["newest", "oldest", "site"]);
const MODES = new Set<GalleryMode>(["grid", "list"]);

export type GalleryCollection = "library" | "favorites" | "sources";
export type GallerySort = "newest" | "oldest" | "site";
export type GalleryMode = "grid" | "list";

export interface GalleryPreviewState {
  readonly phase: "unavailable";
  readonly collection: GalleryCollection;
  readonly query: string;
  readonly sort: GallerySort;
  readonly mode: GalleryMode;
  readonly inspectorOpen: boolean;
}

export interface GalleryPreviewPresentation {
  readonly kind: "disabled";
  readonly label: "后端能力尚未接入";
  readonly message: "图片库后端能力尚未接入；当前不会读取下载目录或发送业务请求。";
}

export const GALLERY_PREVIEW_DEFAULTS: GalleryPreviewState = Object.freeze({
  phase: "unavailable",
  collection: "library",
  query: "",
  sort: "newest",
  mode: "grid",
  inspectorOpen: true,
});

function strictRecord(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`invalid_${label}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`invalid_${label}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key) || !allowed.has(key)) throw new TypeError(`invalid_${label}`);
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`invalid_${label}`);
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function enumValue<T extends string>(value: unknown, choices: ReadonlySet<T>): T {
  if (typeof value !== "string" || !choices.has(value as T)) throw new TypeError("invalid_gallery_preview_state");
  return value as T;
}

export function sanitizeGalleryPreviewState(raw: unknown): GalleryPreviewState {
  const value = strictRecord(raw, STATE_KEYS, "gallery_preview_state");
  if (Object.keys(value).length !== STATE_KEYS.size || value.phase !== "unavailable") throw new TypeError("invalid_gallery_preview_state");
  if (typeof value.query !== "string" || value.query.length > 80 || /[\u0000-\u001f\u007f]/.test(value.query)) throw new TypeError("invalid_gallery_preview_state");
  if (typeof value.inspectorOpen !== "boolean") throw new TypeError("invalid_gallery_preview_state");
  return Object.freeze({
    phase: "unavailable",
    collection: enumValue(value.collection, COLLECTIONS),
    query: value.query,
    sort: enumValue(value.sort, SORTS),
    mode: enumValue(value.mode, MODES),
    inspectorOpen: value.inspectorOpen,
  });
}

export function updateGalleryPreviewState(
  current: GalleryPreviewState,
  patch: Partial<Omit<GalleryPreviewState, "phase">>,
): GalleryPreviewState {
  const delta = strictRecord(patch, PATCH_KEYS, "gallery_preview_patch");
  return sanitizeGalleryPreviewState({ ...current, ...delta });
}

export function galleryPreviewPresentation(): GalleryPreviewPresentation {
  return Object.freeze({
    kind: "disabled",
    label: "后端能力尚未接入",
    message: "图片库后端能力尚未接入；当前不会读取下载目录或发送业务请求。",
  });
}

// ---------------------------------------------------------------------------
// G2 目标模型：消费后端 §6.4 安全投影（docs/图库(含导出).md §3.3）。
// 词汇表逐一镜像后端 gallery_catalog / gallery repository；未知字段、人工
// 质量标签（approved/needs_review 等）、绝对路径、root_path、原始错误文本
// 与原型注入一律拒绝，绝不落入 UI 状态。
// ---------------------------------------------------------------------------

export type GallerySourceKind = "imported" | "crawl_batch";
export type GallerySourceAvailability =
  | "available"
  | "offline"
  | "conflict"
  | "scanning"
  | "error";
export type GalleryTxtState =
  | "normal"
  | "missing"
  | "blank"
  | "invalid_encoding"
  | "pair_conflict"
  | "io_error";
export type GalleryDedupVisibility = "candidate" | "kept" | "excluded";
export type GalleryAssetLifecycleState = "active" | "missing" | "trashed";
export type GalleryDedupState = "not_required" | "pending_analysis";
export type GalleryAssetReadState = "pending" | "ok" | "failed";

const SOURCE_KINDS = new Set<GallerySourceKind>(["imported", "crawl_batch"]);
const SOURCE_AVAILABILITIES = new Set<GallerySourceAvailability>([
  "available",
  "offline",
  "conflict",
  "scanning",
  "error",
]);
const TXT_STATE_VALUES = new Set<GalleryTxtState>([
  "normal",
  "missing",
  "blank",
  "invalid_encoding",
  "pair_conflict",
  "io_error",
]);
const DEDUP_VISIBILITIES = new Set<GalleryDedupVisibility>(["candidate", "kept", "excluded"]);
const ASSET_LIFECYCLE_STATES = new Set<GalleryAssetLifecycleState>([
  "active",
  "missing",
  "trashed",
]);
const DEDUP_STATES = new Set<GalleryDedupState>(["not_required", "pending_analysis"]);
const ASSET_READ_STATES = new Set<GalleryAssetReadState>(["pending", "ok", "failed"]);
// 镜像 _probe_image 的固定错误码；后续阶段新增后端码时同步扩展。
const ASSET_ERROR_CODES = new Set(["", "unidentified", "decode_failed", "probe_error"]);

const SOURCE_SUMMARY_KEYS = new Set([
  "source_id",
  "root_directory_id",
  "kind",
  "batch_id",
  "display_name",
  "availability",
  "asset_count",
  "crawl_complete",
  "dedup_required",
  "dedup_state",
  "content_version",
  "annotation_version",
  "indexed_version",
  "last_scanned_at",
  "created_at",
  "updated_at",
]);
const DIRECTORY_ENTRY_KEYS = new Set([
  "directory_id",
  "source_id",
  "parent_id",
  "relative_path",
  "name",
  "direct_directory_count",
  "direct_asset_count",
  "recursive_asset_count",
  "cover_asset_ids",
  "indexed_version",
]);
const ASSET_ENTRY_KEYS = new Set([
  "asset_id",
  "source_id",
  "directory_id",
  "relative_path",
  "name",
  "extension",
  "size_bytes",
  "modified_ns",
  "content_sha256",
  "content_version",
  "format",
  "width",
  "height",
  "read_state",
  "error_code",
  "txt_relative_path",
  "txt_size_bytes",
  "txt_modified_ns",
  "txt_version",
  "txt_state",
  "dedup_visibility",
  "lifecycle_state",
  "updated_at",
]);

export interface GallerySourceSummary {
  readonly source_id: string;
  /** 进入来源首页所需的稳定根目录 ID；首次扫描前为 null。 */
  readonly root_directory_id: string | null;
  readonly kind: GallerySourceKind;
  readonly batch_id: string | null;
  readonly display_name: string;
  readonly availability: GallerySourceAvailability;
  readonly asset_count: number;
  readonly crawl_complete: boolean;
  readonly dedup_required: boolean;
  readonly dedup_state: GalleryDedupState;
  readonly content_version: number;
  readonly annotation_version: number;
  readonly indexed_version: number;
  readonly last_scanned_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface GalleryDirectoryEntry {
  readonly directory_id: string;
  readonly source_id: string;
  readonly parent_id: string | null;
  readonly relative_path: string;
  readonly name: string;
  readonly direct_directory_count: number;
  readonly direct_asset_count: number;
  readonly recursive_asset_count: number;
  readonly cover_asset_ids: readonly string[];
  readonly indexed_version: number;
}

export interface GalleryAssetEntry {
  readonly asset_id: string;
  readonly source_id: string | null;
  readonly directory_id: string | null;
  readonly relative_path: string;
  readonly name: string;
  readonly extension: string;
  readonly size_bytes: number;
  readonly modified_ns: number;
  readonly content_sha256: string;
  readonly content_version: number;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly read_state: GalleryAssetReadState;
  readonly error_code: string;
  readonly txt_relative_path: string | null;
  readonly txt_size_bytes: number;
  readonly txt_modified_ns: number;
  readonly txt_version: number;
  readonly txt_state: GalleryTxtState;
  readonly dedup_visibility: GalleryDedupVisibility;
  readonly lifecycle_state: GalleryAssetLifecycleState;
  readonly updated_at: number;
}

function idText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`invalid_${label}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`invalid_${label}`);
  return value;
}

function boundedText(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || value.length > limit) throw new TypeError(`invalid_${label}`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`invalid_${label}`);
  return value;
}

function optionalText(value: unknown, label: string, limit: number): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(value, label, limit);
}

function defaultedText(value: unknown, label: string, limit: number, fallback: string): string {
  if (value === undefined) return fallback;
  return boundedText(value, label, limit);
}

function countValue(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`invalid_${label}`);
  }
  return value;
}

function positiveVersion(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`invalid_${label}`);
  }
  return value;
}

function epochValue(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`invalid_${label}`);
  }
  return value;
}

function optionalEpoch(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`invalid_${label}`);
  }
  return value;
}

function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`invalid_${label}`);
  return value;
}

function safeRelativePath(value: unknown, label: string, options: { allowEmpty?: boolean } = {}): string {
  const allowEmpty = options.allowEmpty === true;
  if (typeof value !== "string") throw new TypeError(`invalid_${label}`);
  if (allowEmpty && value === "") return "";
  if (value.length === 0 || value.length > 4096) throw new TypeError(`invalid_${label}`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`invalid_${label}`);
  if (value.startsWith("/") || value.includes("\\")) throw new TypeError(`invalid_${label}`);
  if (/^[A-Za-z]:/.test(value)) throw new TypeError(`invalid_${label}`);
  if (value.endsWith("/")) throw new TypeError(`invalid_${label}`);
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new TypeError(`invalid_${label}`);
    }
  }
  return value;
}

function fileNameText(value: unknown, label: string): string {
  const name = boundedText(value, label, 255);
  if (name.includes("/") || name === "." || name === "..") throw new TypeError(`invalid_${label}`);
  return name;
}

function optionalIdList(value: unknown, label: string, limit: number): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > limit) throw new TypeError(`invalid_${label}`);
  return Object.freeze(value.map((item) => idText(item, label)));
}

function vocabularyValue<T extends string>(value: unknown, choices: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !choices.has(value as T)) {
    throw new TypeError(`invalid_${label}`);
  }
  return value as T;
}

export function sanitizeGallerySourceSummary(raw: unknown): GallerySourceSummary {
  const value = strictRecord(raw, SOURCE_SUMMARY_KEYS, "gallery_source_summary");
  return Object.freeze({
    source_id: idText(value.source_id, "gallery_source_id"),
    root_directory_id: optionalText(value.root_directory_id, "gallery_root_directory_id", 128),
    kind: vocabularyValue(value.kind, SOURCE_KINDS, "gallery_source_kind"),
    batch_id: optionalText(value.batch_id, "gallery_batch_id", 128),
    display_name: boundedText(value.display_name, "gallery_display_name", 256),
    availability: vocabularyValue(
      value.availability,
      SOURCE_AVAILABILITIES,
      "gallery_source_availability",
    ),
    asset_count: countValue(value.asset_count, "gallery_asset_count", 0),
    crawl_complete: booleanValue(value.crawl_complete, "gallery_crawl_complete", false),
    dedup_required: booleanValue(value.dedup_required, "gallery_dedup_required", false),
    dedup_state:
      value.dedup_state === undefined
        ? "not_required"
        : vocabularyValue(value.dedup_state, DEDUP_STATES, "gallery_dedup_state"),
    content_version: positiveVersion(value.content_version, "gallery_content_version", 1),
    annotation_version: positiveVersion(
      value.annotation_version,
      "gallery_annotation_version",
      1,
    ),
    indexed_version: positiveVersion(value.indexed_version, "gallery_indexed_version", 1),
    last_scanned_at: optionalEpoch(value.last_scanned_at, "gallery_last_scanned_at"),
    created_at: epochValue(value.created_at, "gallery_created_at", 0),
    updated_at: epochValue(value.updated_at, "gallery_updated_at", 0),
  });
}

export function sanitizeGalleryDirectoryEntry(raw: unknown): GalleryDirectoryEntry {
  const value = strictRecord(raw, DIRECTORY_ENTRY_KEYS, "gallery_directory_entry");
  return Object.freeze({
    directory_id: idText(value.directory_id, "gallery_directory_id"),
    source_id: idText(value.source_id, "gallery_source_id"),
    parent_id: optionalText(value.parent_id, "gallery_parent_id", 128),
    relative_path: safeRelativePath(value.relative_path, "gallery_relative_path", {
      allowEmpty: true,
    }),
    name: boundedText(value.name, "gallery_directory_name", 255),
    direct_directory_count: countValue(
      value.direct_directory_count,
      "gallery_direct_directory_count",
      0,
    ),
    direct_asset_count: countValue(value.direct_asset_count, "gallery_direct_asset_count", 0),
    recursive_asset_count: countValue(
      value.recursive_asset_count,
      "gallery_recursive_asset_count",
      0,
    ),
    cover_asset_ids: optionalIdList(value.cover_asset_ids, "gallery_cover_asset_ids", 9),
    indexed_version: positiveVersion(value.indexed_version, "gallery_indexed_version", 1),
  });
}

export function sanitizeGalleryAssetEntry(raw: unknown): GalleryAssetEntry {
  const value = strictRecord(raw, ASSET_ENTRY_KEYS, "gallery_asset_entry");
  return Object.freeze({
    asset_id: idText(value.asset_id, "gallery_asset_id"),
    source_id: optionalText(value.source_id, "gallery_source_id", 128),
    directory_id: optionalText(value.directory_id, "gallery_directory_id", 128),
    relative_path: safeRelativePath(value.relative_path, "gallery_relative_path"),
    name: fileNameText(value.name, "gallery_asset_name"),
    extension: defaultedText(value.extension, "gallery_asset_extension", 16, ""),
    size_bytes: countValue(value.size_bytes, "gallery_asset_size", 0),
    // 纳秒时间戳超出 Number.MAX_SAFE_INTEGER，JSON 解析后为有损 double；
    // 桌面端只透传展示，精确比较一律由后端在 Python 全精度下进行。
    modified_ns: epochValue(value.modified_ns, "gallery_asset_modified_ns", 0),
    content_sha256: defaultedText(value.content_sha256, "gallery_content_sha256", 64, ""),
    content_version: positiveVersion(value.content_version, "gallery_content_version", 1),
    format: defaultedText(value.format, "gallery_asset_format", 16, ""),
    width: countValue(value.width, "gallery_asset_width", 0),
    height: countValue(value.height, "gallery_asset_height", 0),
    read_state:
      value.read_state === undefined
        ? "pending"
        : vocabularyValue(value.read_state, ASSET_READ_STATES, "gallery_read_state"),
    error_code:
      value.error_code === undefined
        ? ""
        : vocabularyValue(value.error_code, ASSET_ERROR_CODES, "gallery_asset_error_code"),
    txt_relative_path:
      value.txt_relative_path === null || value.txt_relative_path === undefined
        ? null
        : safeRelativePath(value.txt_relative_path, "gallery_txt_relative_path"),
    txt_size_bytes: countValue(value.txt_size_bytes, "gallery_txt_size", 0),
    txt_modified_ns: epochValue(value.txt_modified_ns, "gallery_txt_modified_ns", 0),
    txt_version: positiveVersion(value.txt_version, "gallery_txt_version", 1),
    txt_state: vocabularyValue(value.txt_state, TXT_STATE_VALUES, "gallery_txt_state"),
    dedup_visibility:
      value.dedup_visibility === undefined
        ? "candidate"
        : vocabularyValue(value.dedup_visibility, DEDUP_VISIBILITIES, "gallery_dedup_visibility"),
    lifecycle_state:
      value.lifecycle_state === undefined
        ? "active"
        : vocabularyValue(value.lifecycle_state, ASSET_LIFECYCLE_STATES, "gallery_lifecycle_state"),
    updated_at: epochValue(value.updated_at, "gallery_updated_at", 0),
  });
}

const DIGIT_RUN = /\d+/g;

function naturalKey(name: string): string {
  // 镜像后端 natural_sort_key：casefold + 数字游程两位长度前缀编码。
  const folded = name.toLowerCase();
  let key = "";
  let position = 0;
  for (const match of folded.matchAll(DIGIT_RUN)) {
    const digits = match[0];
    key += folded.slice(position, match.index);
    key += digits.length < 99 ? `${digits.length.toString().padStart(2, "0")}${digits}` : digits;
    position = (match.index ?? 0) + digits.length;
  }
  return key + folded.slice(position);
}

export function galleryNaturalCompare(left: string, right: string): number {
  if (typeof left !== "string" || typeof right !== "string") {
    throw new TypeError("gallery_natural_compare_requires_strings");
  }
  const leftKey = naturalKey(left);
  const rightKey = naturalKey(right);
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  // 折叠后并列时以原始文件名做次级排序（与后端 sort_key 语义一致）。
  if (left !== right) return left < right ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// G2-2 浏览页模型：分页投影清洗、目录树/面包屑、虚拟化窗口与 UI 标签。
// ---------------------------------------------------------------------------

export interface GallerySourcePage {
  readonly sources: readonly GallerySourceSummary[];
}

export interface GalleryDirectoryPage {
  readonly directory: GalleryDirectoryEntry;
  readonly directories: readonly GalleryDirectoryEntry[];
  readonly assets: readonly GalleryAssetEntry[];
  readonly directory_cursor: string | null;
  readonly asset_cursor: string | null;
  readonly include_descendants: boolean;
  readonly limit: number;
}

const SOURCE_PAGE_KEYS = new Set(["sources"]);
const DIRECTORY_PAGE_KEYS = new Set([
  "directory",
  "directories",
  "assets",
  "directory_cursor",
  "asset_cursor",
  "include_descendants",
  "limit",
]);


export function sanitizeGallerySourcePage(raw: unknown): GallerySourcePage {
  const value = strictRecord(raw, SOURCE_PAGE_KEYS, "gallery_source_page");
  if (!Array.isArray(value.sources)) throw new TypeError("invalid_gallery_sources");
  return Object.freeze({ sources: Object.freeze(value.sources.map(sanitizeGallerySourceSummary)) });
}

export function sanitizeGalleryDirectoryPage(raw: unknown): GalleryDirectoryPage {
  const value = strictRecord(raw, DIRECTORY_PAGE_KEYS, "gallery_directory_page");
  if (!Array.isArray(value.directories)) throw new TypeError("invalid_gallery_directories");
  if (!Array.isArray(value.assets)) throw new TypeError("invalid_gallery_assets");
  return Object.freeze({
    directory: sanitizeGalleryDirectoryEntry(value.directory),
    directories: Object.freeze(value.directories.map(sanitizeGalleryDirectoryEntry)),
    assets: Object.freeze(value.assets.map(sanitizeGalleryAssetEntry)),
    directory_cursor: optionalText(value.directory_cursor, "gallery_directory_cursor", 512),
    asset_cursor: optionalText(value.asset_cursor, "gallery_asset_cursor", 512),
    include_descendants: booleanValue(value.include_descendants, "gallery_include_descendants", false),
    limit: countValue(value.limit, "gallery_page_limit", 0),
  });
}

export function sortGalleryDirectoryEntries(
  entries: readonly GalleryDirectoryEntry[],
): readonly GalleryDirectoryEntry[] {
  // 稳定排序（Array#sort 稳定）；折叠并列由原始串确定性 tie-break。
  return [...entries].sort((left, right) => galleryNaturalCompare(left.name, right.name));
}

export function sortGalleryAssetEntries(
  entries: readonly GalleryAssetEntry[],
): readonly GalleryAssetEntry[] {
  return [...entries].sort((left, right) => galleryNaturalCompare(left.relative_path, right.relative_path));
}

export const GALLERY_TXT_STATE_LABELS: Readonly<Record<GalleryTxtState, string>> = Object.freeze({
  normal: "TXT 正常",
  missing: "TXT 缺失",
  blank: "TXT 空白",
  invalid_encoding: "TXT 编码异常",
  pair_conflict: "同名配对冲突",
  io_error: "TXT 读取失败",
});

export const GALLERY_AVAILABILITY_LABELS: Readonly<Record<GallerySourceAvailability, string>> =
  Object.freeze({
    available: "可用",
    offline: "目录不可访问",
    conflict: "路径冲突",
    scanning: "扫描中",
    error: "扫描失败",
  });

export const GALLERY_DEDUP_STATE_LABELS: Readonly<Record<GalleryDedupState, string>> = Object.freeze({
  not_required: "无需去重",
  pending_analysis: "待去重分析",
});

export const GALLERY_SOURCE_KIND_LABELS: Readonly<Record<GallerySourceKind, string>> = Object.freeze({
  imported: "导入目录",
  crawl_batch: "下载批次",
});

export type GallerySearchScope = "directory" | "source" | "library";

export interface GalleryPathSegment {
  readonly directory_id: string;
  readonly name: string;
}

export interface GalleryBreadcrumbSegment {
  readonly directory_id: string;
  readonly label: string;
}

export function galleryBreadcrumb(
  sourceName: string,
  path: readonly GalleryPathSegment[],
): readonly GalleryBreadcrumbSegment[] {
  if (sourceName.length === 0) throw new TypeError("invalid_gallery_source_name");
  const segments: GalleryBreadcrumbSegment[] = [{ directory_id: "", label: sourceName }];
  for (const segment of path) {
    segments.push({
      directory_id: idText(segment.directory_id, "gallery_directory_id"),
      label: boundedText(segment.name, "gallery_directory_name", 255),
    });
  }
  return Object.freeze(segments);
}

export function validateGalleryQuery(query: string): string {
  if (typeof query !== "string") throw new TypeError("invalid_gallery_query");
  const trimmed = query.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length > 256) throw new TypeError("invalid_gallery_query");
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new TypeError("invalid_gallery_query");
  return trimmed;
}

// 虚拟化网格窗口计算（纯函数，供网格与列表共用行窗口逻辑）。
export interface GalleryWindowingInput {
  readonly total: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly columnCount: number;
  readonly rowHeight: number;
  readonly overscanRows: number;
}

export interface GalleryWindowingRange {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly totalHeight: number;
  readonly startOffsetY: number;
}

export function galleryVisibleRange(input: GalleryWindowingInput): GalleryWindowingRange {
  const {
    total,
    scrollTop,
    viewportHeight,
    columnCount,
    rowHeight,
    overscanRows,
  } = input;
  if (
    !Number.isFinite(total) ||
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isSafeInteger(columnCount) ||
    columnCount < 1 ||
    !Number.isFinite(rowHeight) ||
    rowHeight < 1 ||
    !Number.isSafeInteger(overscanRows) ||
    overscanRows < 0
  ) {
    throw new TypeError("invalid_gallery_windowing");
  }
  if (total <= 0 || viewportHeight <= 0) {
    return { startIndex: 0, endIndex: 0, totalHeight: 0, startOffsetY: 0 };
  }
  const rowCount = Math.ceil(total / columnCount);
  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / rowHeight));
  const visibleRowCount = Math.ceil(viewportHeight / rowHeight);
  const startRow = Math.max(0, firstVisibleRow - overscanRows);
  const endRow = Math.min(rowCount - 1, firstVisibleRow + visibleRowCount + overscanRows);
  return Object.freeze({
    startIndex: startRow * columnCount,
    endIndex: Math.min(total - 1, (endRow + 1) * columnCount - 1),
    totalHeight: rowCount * rowHeight,
    startOffsetY: startRow * rowHeight,
  });
}
