import { describe, expect, it, vi } from "vitest";

import { sanitizeReviewPage } from "./model";
import { createReviewStore } from "./state";

function page() {
  return sanitizeReviewPage({
    review_id: "review-one",
    response_profile: "desktop-gallery-review-v1",
    version: 1,
    directories: [{ directory_id: "directory-one", source_id: "source-one", source_display_name: "Source", relative_path: "album", name: "album" }],
    status: "ready",
    totalImageCount: 3,
    totalGroupCount: 2,
    duplicateGroupCount: 1,
    unreadableImageCount: 0,
    automaticGroupCount: 0,
    automaticRejectedImageCount: 0,
    selectedImageCount: 3,
    decidedGroupCount: 0,
    keptImageCount: 0,
    rejectedImageCount: 0,
    failedImageCount: 0,
    hasError: false,
    groups: {
      items: [
        { id: "group-1", ordinal: 1, kind: "duplicate", decided: false, images: [
          { id: "image-1", asset_id: "image-1", source_display_name: "Source", relative_path: "album/1.jpg", ordinal: 1, readable: true, recommended: true, selected: true, metadata: { w: 800, h: 1200 } },
          { id: "image-2", asset_id: "image-2", source_display_name: "Source", relative_path: "album/2.jpg", ordinal: 2, readable: true, recommended: false, selected: true, metadata: { w: 1200, h: 800 } },
        ] },
        { id: "group-2", ordinal: 2, kind: "single", decided: false, images: [
          { id: "image-3", asset_id: "image-3", source_display_name: "Source", relative_path: "album/3.jpg", ordinal: 1, readable: true, recommended: true, selected: true, metadata: { w: 900, h: 900 } },
        ] },
      ],
      offset: 0,
      limit: 2,
      total: 2,
    },
  }, { reviewId: "review-one", filter: "" });
}

describe("review state", () => {
  it("owns one snapshot and notifies once while replacing only the affected keyed group", () => {
    const store = createReviewStore();
    store.commitSnapshot(page());
    const before = store.getState();
    const secondGroup = before.snapshot?.groups["group-2"];
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    expect(store.toggleImage("group-1", "image-2")).toBe(true);
    const after = store.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after.snapshot?.groups["group-1"]).not.toBe(before.snapshot?.groups["group-1"]);
    expect(after.snapshot?.groups["group-2"]).toBe(secondGroup);
    expect(after.snapshot?.dirty).toBe(true);
    expect(after.snapshot?.dirtyGroupIds).toEqual(["group-1"]);
    expect(after.activeImageId).toBe("image-2");
  });

  it("keeps task selection independent of task-list pages and tracks a pending switch", () => {
    const store = createReviewStore();
    store.commitRecent({ items: [page()], total: 2, offset: 0, limit: 1 });
    expect(store.selectReview("review-other-page")).toBe(true);
    store.commitRecent({ items: [], total: 2, offset: 2, limit: 1 });
    expect(store.getState().selectedReviewId).toBe("review-other-page");
    store.queueReview("review-pending");
    expect(store.getState().pendingReviewId).toBe("review-pending");
    expect(store.selectReview("review-pending")).toBe(true);
    expect(store.getState().pendingReviewId).toBe("");
  });

  it("confirms groups, gates writes, and preserves dirty snapshots on failure", () => {
    const store = createReviewStore();
    store.commitSnapshot(page());
    expect(store.confirmGroup("group-1")).toBe(true);
    expect(store.getState().snapshot?.groups["group-1"].decided).toBe(true);
    expect(store.begin("save", "正在保存")).toBe(true);
    expect(store.begin("save", "正在保存")).toBe(false);
    const dirty = store.getState().snapshot;
    store.fail(Object.freeze({ title: "审核状态已变化", message: "safe", nextStep: "safe", code: "review_state_conflict", status: 409, requestId: "", conflict: true, missing: false }));
    expect(store.getState().snapshot).toBe(dirty);
    expect(store.getState().snapshot?.dirty).toBe(true);
    expect(store.getState().phase).toBe("error");
    expect(store.requestConfirmation(Object.freeze({ action: "discard-reload", title: "放弃", message: "safe", confirmLabel: "放弃", warning: "safe" }))).toBe(true);
    expect(store.dismissConfirmation()).toBe(true);
  });

  it("releases subscribers and rejects mutations after destroy", () => {
    const store = createReviewStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.destroy();
    expect(store.subscribe(listener)).toEqual(expect.any(Function));
    expect(store.selectReview("review-one")).toBe(false);
    expect(store.toggleImage("group-1", "image-1")).toBe(false);
  });
});
