import { dedupe, isTagCategory, normalizeTag, parseTagInput, type TagCategory } from "#lib/domain/captions.ts";

export function galleryStudioPath(sourceId: string, directoryId?: string | null): string {
  const path = `/library/${encodeURIComponent(sourceId)}/review`;
  return directoryId ? `${path}?${new URLSearchParams({ directory: directoryId })}` : path;
}

/** SvelteKit uses hash routing: the scope query lives inside the hash. */
export function galleryStudioDirectory(hash: string): string | null {
  return new URLSearchParams(hash.split("?", 2)[1]).get("directory") || null;
}
export type ReviewFilter = "all" | "pending" | "reviewed";

export function matchesReviewFilter(kept: ReadonlySet<string>, filter: ReviewFilter, assetId: string): boolean {
  return filter === "all" || kept.has(assetId) === (filter === "reviewed");
}

export type GalleryUndo =
  | { kind: "keep"; assetIds: readonly string[]; kept: boolean; focusId?: string }
  | { kind: "trash"; assetId: string; operationId: string }
  | { kind: "caption"; batchId: string; assetId?: string };

/** One write at a time. Failed writes neither add nor consume undo entries. */
export function createGalleryReviewActions(onBusy: (busy: boolean) => void, onUndoAvailable: (available: boolean) => void) {
  const history: GalleryUndo[] = [];
  let busy = false;

  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (busy) return;
    busy = true;
    onBusy(true);
    try {
      return await task();
    } finally {
      busy = false;
      onBusy(false);
    }
  }

  function remember(step: GalleryUndo) {
    history.push(step);
    onUndoAvailable(true);
  }

  async function undo(restore: (step: GalleryUndo) => Promise<boolean | void>) {
    return run(async () => {
      const last = history.at(-1);
      if (!last) return false;
      if (await restore(last) === false) return false;
      history.pop();
      onUndoAvailable(history.length > 0);
      return true;
    });
  }

  return { run, remember, undo };
}

export interface GalleryStudioPreferences {
  readonly triggerWord: string;
  readonly blacklist: readonly string[];
  readonly categories: string;
}

export const EMPTY_GALLERY_PREFERENCES: GalleryStudioPreferences = { triggerWord: "", blacklist: [], categories: "" };

/** One line per category (`character: tag, tag`); ordinary captions do not carry model categories. */
export function galleryCategories(text: string): Map<string, TagCategory> | null {
  const categories = new Map<string, TagCategory>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    const category = line.slice(0, separator).trim();
    const tags = parseTagInput(line.slice(separator + 1));
    if (separator === -1 || !isTagCategory(category) || tags.length === 0) return null;
    for (const tag of tags) categories.set(normalizeTag(tag), category);
  }
  return categories;
}

// These source-wide preferences are local to the desktop/browser, not dataset or export policy.
const storageKey = (sourceId: string) => `ldos:gallery-studio:${sourceId}`;

export function readGalleryStudioPreferences(sourceId: string): GalleryStudioPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(sourceId)) ?? "null");
    if (!raw || typeof raw.triggerWord !== "string" || typeof raw.categories !== "string" || !Array.isArray(raw.blacklist)) {
      return EMPTY_GALLERY_PREFERENCES;
    }
    return {
      triggerWord: raw.triggerWord,
      categories: raw.categories,
      blacklist: dedupe(raw.blacklist.filter((tag: unknown): tag is string => typeof tag === "string")),
    };
  } catch {
    return EMPTY_GALLERY_PREFERENCES;
  }
}

export function saveGalleryStudioPreferences(sourceId: string, preferences: GalleryStudioPreferences) {
  localStorage.setItem(storageKey(sourceId), JSON.stringify(preferences));
}
