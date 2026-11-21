import { describe, expect, it, vi } from "vitest";

import {
  createGalleryReviewActions,
  galleryCategories,
  galleryStudioDirectory,
  galleryStudioPath,
  matchesReviewFilter,
  readGalleryStudioPreferences,
  saveGalleryStudioPreferences,
} from "./gallery-studio-state.ts";

describe("gallery review scope", () => {
  it("round trips a directory in the hash, without changing the route for an entire source", () => {
    const source = galleryStudioPath("source/1");
    const directory = galleryStudioPath("source/1", "nested?id&x");
    expect(source).toBe("/library/source%2F1/review");
    expect(galleryStudioDirectory(`#${source}`)).toBeNull();
    expect(galleryStudioDirectory(`#${directory}`)).toBe("nested?id&x");
  });

  it("filters pending/reviewed against persistent Keeps", () => {
    const kept = new Set(["a"]);
    const all = ["a", "b"];
    expect(all.filter((id) => matchesReviewFilter(kept, "all", id))).toEqual(all);
    expect(all.filter((id) => matchesReviewFilter(kept, "pending", id))).toEqual(["b"]);
    expect(all.filter((id) => matchesReviewFilter(kept, "reviewed", id))).toEqual(["a"]);
  });

  it("isolates saved source preferences and only uses an explicit category vocabulary", () => {
    const values = new Map();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
    try {
      const preferences = { triggerWord: "prefix", blacklist: ["remove me"], categories: "character: Original_Name\nkind: invalid" };
      expect(galleryCategories(preferences.categories)).toBeNull();
      const valid = { ...preferences, categories: "character: Original_Name\nartist: name_2" };
      expect(galleryCategories(valid.categories)).toEqual(new Map([["original name", "character"], ["name 2", "artist"]]));
      saveGalleryStudioPreferences("s1", valid);
      expect(readGalleryStudioPreferences("s1")).toEqual(valid);
      expect(readGalleryStudioPreferences("s2")).toEqual({ triggerWord: "", blacklist: [], categories: "" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("gallery review actions", () => {
  it("serializes writes and does not record a failed Keep or advance its cursor", async () => {
    const busy = vi.fn();
    const undoAvailable = vi.fn();
    const actions = createGalleryReviewActions(busy, undoAvailable);
    const { promise, reject } = Promise.withResolvers<void>();
    const advance = vi.fn();
    const keep = vi.fn(async () => {
      await promise;
      actions.remember({ kind: "keep", assetIds: ["a"], kept: false, focusId: "a" });
      advance();
    });
    const pending = actions.run(keep);
    const duplicate = await actions.run(keep);
    expect(duplicate).toBeUndefined();
    expect(keep).toHaveBeenCalledTimes(1);
    expect(busy.mock.calls).toEqual([[true]]);
    reject(new Error("not saved"));
    await expect(pending).rejects.toThrow("not saved");
    expect(advance).not.toHaveBeenCalled();
    expect(undoAvailable).not.toHaveBeenCalled();
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });

  it("keeps an exact Trash operation retryable on failed undo and starts clean in a new scope", async () => {
    const available = vi.fn();
    const actions = createGalleryReviewActions(() => {}, available);
    const keep = { kind: "keep", assetIds: ["a"], kept: false } as const;
    const trash = { kind: "trash", assetId: "a", operationId: "op-12" } as const;
    actions.remember(keep);
    actions.remember(trash);
    const restore = vi.fn().mockRejectedValueOnce(new Error("restore unavailable")).mockResolvedValueOnce(false).mockResolvedValue(undefined);
    await expect(actions.undo(restore)).rejects.toThrow("restore unavailable");
    await expect(actions.undo(restore)).resolves.toBe(false);
    const newScope = createGalleryReviewActions(() => {}, () => {});
    await expect(newScope.undo(restore)).resolves.toBe(false);
    await expect(actions.undo(restore)).resolves.toBe(true);
    await expect(actions.undo(restore)).resolves.toBe(true);
    expect(restore.mock.calls).toEqual([[trash], [trash], [trash], [keep]]);
    expect(available.mock.calls.at(-1)).toEqual([false]);
  });
});
