import { describe, expect, it } from "vitest";

import {
  REVIEW_DECISION_BATCH_LIMIT,
  REVIEW_GROUP_LIMIT,
  REVIEW_POLL_INTERVAL_MS,
  buildReviewDecisionPayload,
  mergeReviewPageChunks,
  createReviewRequestGate,
  resolveReviewCommand,
  reviewErrorPresentation,
  reviewApplyCounts,
  reviewImagePath,
  sanitizeReviewPage,
  sanitizeReviewPageChunk,
  splitReviewDecisionPayload,
  updateReviewImageSelection,
  type ReviewSnapshot,
} from "./model";

const SECRET = "review-cookie-token-path-secret";

function rawImage(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `image-${index}`,
    asset_id: `image-${index}`, source_display_name: "Source", relative_path: `album/image-${index}.jpg`,
    ordinal: index,
    readable: true,
    recommended: index === 1,
    selected: true,
    final_relative_path: `/private/${SECRET}/image-${index}.jpg`,
    url: `https://private.invalid/${SECRET}/${index}`,
    metadata: { w: 1200, h: 1800, path: `/private/${SECRET}`, token: SECRET },
    ...overrides,
  };
}

function rawGroup(index: number, images = [rawImage(index * 2 - 1), rawImage(index * 2)]) {
  return { id: `group-${index}`, ordinal: index, kind: "duplicate", decided: false, images, raw: SECRET };
}

function rawPage(groups = [rawGroup(1)], overrides: Record<string, unknown> = {}) {
  return {
    review_id: "review-one",
    response_profile: "desktop-gallery-review-v1",
    version: 1,
    directories: [{ directory_id: "directory-one", source_id: "source-one", source_display_name: "Source", relative_path: "album", name: "album" }],
    status: "ready",
    totalImageCount: groups.reduce((count, group) => count + group.images.length, 0),
    totalGroupCount: groups.length,
    duplicateGroupCount: groups.length,
    unreadableImageCount: 0,
    automaticGroupCount: 0,
    automaticRejectedImageCount: 0,
    selectedImageCount: groups.reduce((count, group) => count + group.images.length, 0),
    decidedGroupCount: 0,
    keptImageCount: 0,
    rejectedImageCount: 0,
    failedImageCount: 0,
    hasError: false,
    groups: { items: groups, offset: 0, limit: groups.length, total: groups.length, secret: SECRET },
    details: { token: SECRET },
    ...overrides,
  };
}

function sanitize(groups = [rawGroup(1)]): ReviewSnapshot {
  return sanitizeReviewPage(rawPage(groups), { reviewId: "review-one", filter: "", requestedOffset: 0 });
}

describe("review model", () => {
  it("separates automatic and manual rejections in completion counts", () => {
    const summary = { ...sanitize().summary, totalImageCount: 10, selectedImageCount: 4, automaticRejectedImageCount: 3 };
    expect(reviewApplyCounts(summary)).toEqual({ automatic: 3, selected: 4, rejected: 3 });
  });
  it("strictly sanitizes review pages without retaining paths, URLs, or secrets", () => {
    const snapshot = sanitize();
    expect(snapshot.groupOrder).toEqual(["group-1"]);
    expect(snapshot.groups["group-1"].imageOrder).toEqual(["image-1", "image-2"]);
    const serialized = JSON.stringify(snapshot);
    for (const unsafe of [SECRET, "private.invalid", "/private/", "relative_path", '"url"']) expect(serialized).not.toContain(unsafe);

    const unreadable = sanitize([rawGroup(1, [rawImage(1, { readable: false, metadata: { file_hash: "safe" } })])]);
    expect(unreadable.groups["group-1"].images["image-1"]).toMatchObject({ readable: false, width: 0, height: 0 });
    for (const overrides of [
      { readable: "false" },
      { recommended: 1 },
      { selected: "true" },
      { metadata: { w: -1, h: 1800 } },
    ]) expect(() => sanitize([rawGroup(1, [rawImage(1, overrides)])])).toThrow(TypeError);
    expect(() => sanitizeReviewPage(rawPage(), { reviewId: "review-one", requestedOffset: 1 })).toThrow(TypeError);

    let reads = 0;
    const unsafe = Object.defineProperty(rawImage(1), "selected", { enumerable: true, get() { reads += 1; return true; } });
    expect(() => sanitize([rawGroup(1, [unsafe])])).toThrow(TypeError);
    expect(reads).toBe(0);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });


  it("merges bounded review pages and rejects gaps or cross-page duplicates", () => {
    const summary = { totalImageCount: 4, totalGroupCount: 2, duplicateGroupCount: 2, selectedImageCount: 4 };
    const first = sanitizeReviewPageChunk(rawPage([rawGroup(1)], {
      ...summary,
      groups: { items: [rawGroup(1)], offset: 0, limit: 1, total: 2 },
    }), { reviewId: "review-one", filter: "", requestedOffset: 0 });
    const second = sanitizeReviewPageChunk(rawPage([rawGroup(2)], {
      ...summary,
      groups: { items: [rawGroup(2)], offset: 1, limit: 1, total: 2 },
    }), { reviewId: "review-one", filter: "", requestedOffset: 1 });
    const snapshot = mergeReviewPageChunks([first, second]);
    expect(snapshot.groupOrder).toEqual(["group-1", "group-2"]);
    expect(snapshot.summary.totalGroupCount).toBe(2);
    expect(() => sanitizeReviewPageChunk(rawPage([], {
      ...summary,
      groups: { items: [], offset: 2, limit: 1, total: 2 },
    }), { reviewId: "review-one", filter: "", requestedOffset: 1 })).toThrow(TypeError);
    expect(() => mergeReviewPageChunks([first, sanitizeReviewPageChunk(rawPage([rawGroup(1)], {
      ...summary,
      groups: { items: [rawGroup(1)], offset: 1, limit: 1, total: 2 },
    }), { reviewId: "review-one", filter: "", requestedOffset: 1 })])).toThrow(TypeError);
  });
  it("updates one keyed image and chunks only confirmed business identifiers", () => {
    const groups = Array.from({ length: 101 }, (_, index) => rawGroup(index + 1, [rawImage(index + 1)]));
    let snapshot = sanitize(groups);
    const untouchedGroup = snapshot.groups["group-2"];
    snapshot = updateReviewImageSelection(snapshot, "group-1", "image-1", false);
    expect(snapshot.groups["group-1"].images["image-1"].selected).toBe(false);
    expect(snapshot.groups["group-2"]).toBe(untouchedGroup);

    const dirtyGroupIds = Object.freeze([...snapshot.groupOrder]);
    const dirtyGroups = Object.freeze(Object.fromEntries(snapshot.groupOrder.map((groupId) => [groupId, Object.freeze({ ...snapshot.groups[groupId], decided: true })])));
    const dirty = Object.freeze({ ...snapshot, groups: dirtyGroups, dirty: true, dirtyGroupIds });
    const chunks = splitReviewDecisionPayload(buildReviewDecisionPayload(dirty));
    expect(chunks.map(({ groups: items }) => items.length)).toEqual([50, 50, 1]);
    expect(chunks.flatMap(({ groups: items }) => items).every((item) => Object.keys(item).sort().join(",") === "group_id,selected_image_ids")).toBe(true);
    expect(REVIEW_GROUP_LIMIT).toBe(10_000);
    expect(REVIEW_DECISION_BATCH_LIMIT).toBe(50);
    expect(REVIEW_POLL_INTERVAL_MS).toBe(1_500);
  });

  it("invalidates stale read lanes across writes and lifecycle boundaries", () => {
    const gate = createReviewRequestGate();
    const page = gate.beginRead("page", "review-one", "", 0);
    const recent = gate.beginRead("recent", "", "", 0);
    expect(gate.isReadCurrent(page)).toBe(true);
    expect(gate.isReadCurrent(recent)).toBe(true);
    gate.beginRead("page", "review-one", "duplicate", 0);
    expect(gate.isReadCurrent(page)).toBe(false);
    expect(gate.isReadCurrent(recent)).toBe(true);
    const write = gate.beginWrite();
    expect(gate.isReadCurrent(recent)).toBe(false);
    expect(gate.isWriteCurrent(write)).toBe(true);
    gate.advanceLifecycle();
    expect(gate.isWriteCurrent(write)).toBe(false);
    expect(() => gate.beginRead("unsafe" as "page", "review-one", "", 0)).toThrow(TypeError);
    expect(() => gate.beginRead("recent", "review-one", "", 0)).toThrow(TypeError);
  });

  it("keeps command, media-path, and safe error projections closed", () => {
    expect(resolveReviewCommand("Enter", { editable: true, readOnly: false, hasImages: true, loupeAvailable: true })).toBe("accept-advance");
    expect(resolveReviewCommand("Escape", { editable: true, readOnly: false, hasImages: true, loupeAvailable: true })).toBe("previous-group");
    expect(resolveReviewCommand("ArrowLeft", { editable: true, readOnly: false, hasImages: true, loupeAvailable: true })).toBe("focus-previous-image");
    expect(resolveReviewCommand("ArrowRight", { editable: true, readOnly: false, hasImages: true, loupeAvailable: true })).toBe("focus-next-image");
    expect(resolveReviewCommand("ArrowUp", { editable: true, readOnly: false, hasImages: true, loupeAvailable: true })).toBeNull();
    expect(resolveReviewCommand("ArrowDown", { editable: true, readOnly: false, hasImages: true, loupeAvailable: true })).toBeNull();
    expect(resolveReviewCommand("X", { editable: false, readOnly: true, hasImages: true, loupeAvailable: true })).toBe("toggle-loupe");
    expect(reviewImagePath("review-one", "image-1")).toBe("/api/v1/gallery/reviews/review-one/images/image-1");
    for (const value of ["", "../batch", "batch/child", SECRET]) expect(() => reviewImagePath(value, "image-1")).toThrow(TypeError);
    const presentation = reviewErrorPresentation(Object.assign(new Error(SECRET), { code: `oauth_${SECRET}`, status: 409, requestId: "request-safe", details: { token: SECRET } }));
    expect(presentation.code).toBe("request_failed");
    expect(presentation.conflict).toBe(true);
    expect(JSON.stringify(presentation)).not.toContain(SECRET);
  });
});
