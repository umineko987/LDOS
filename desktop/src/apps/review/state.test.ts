import { describe, expect, it, vi } from "vitest";

import { sanitizeReviewPage } from "./model";
import { createReviewStore } from "./state";

function page() {
  return sanitizeReviewPage({
    batch_id: "batch-review",
    status: "ready",
    total_image_count: 3,
    total_group_count: 2,
    duplicate_group_count: 1,
    unreadable_image_count: 0,
    automatic_group_count: 0,
    automatic_rejected_image_count: 0,
    selected_image_count: 3,
    decided_group_count: 0,
    kept_image_count: 0,
    rejected_image_count: 0,
    failed_image_count: 0,
    error: "",
    groups: {
      items: [
        { id: "group-1", ordinal: 1, kind: "duplicate", decided: false, images: [
          { id: "image-1", ordinal: 1, readable: true, recommended: true, selected: true, metadata: { w: 800, h: 1200 } },
          { id: "image-2", ordinal: 2, readable: true, recommended: false, selected: true, metadata: { w: 1200, h: 800 } },
        ] },
        { id: "group-2", ordinal: 2, kind: "single", decided: false, images: [
          { id: "image-3", ordinal: 1, readable: true, recommended: true, selected: true, metadata: { w: 900, h: 900 } },
        ] },
      ],
      offset: 0,
      limit: 2,
      total: 2,
    },
  }, { batchId: "batch-review", filter: "" });
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

  it("keeps batch selection terminal-only and anchors it across recent refreshes", () => {
    const store = createReviewStore();
    store.commitRecent([
      { id: "batch-one", status: "succeeded", statusLabel: "已完成", createdAt: null, terminal: true },
      { id: "batch-two", status: "cancelled", statusLabel: "已取消", createdAt: null, terminal: true },
    ]);
    expect(store.selectBatch("batch-two")).toBe(true);
    expect(store.selectBatch("unknown")).toBe(false);
    store.commitRecent([{ id: "batch-one", status: "succeeded", statusLabel: "已完成", createdAt: null, terminal: true }]);
    expect(store.getState().selectedBatchId).toBe("");
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
    expect(store.selectBatch("batch-review")).toBe(false);
    expect(store.toggleImage("group-1", "image-1")).toBe(false);
  });
});
