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
