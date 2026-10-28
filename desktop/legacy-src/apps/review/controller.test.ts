import { describe, expect, it, vi } from "vitest";

import type { PollingRegistration, PollingService } from "../../core/polling/service";
import { createReviewController, REVIEW_POLL_KEY, REVIEW_SCOPE } from "./controller";
import { sanitizeReviewPage, type ReviewOperationResult, type ReviewSnapshot } from "./model";
import type { ReviewService } from "./service";
import { createReviewStore } from "./state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function snapshot(status = "ready", count = 1, decided = false, reviewId = "review-one", version = 1): ReviewSnapshot {
  const groups = Array.from({ length: count }, (_, index) => ({
    id: `group-${index + 1}`,
    ordinal: index + 1,
    kind: "duplicate",
    decided,
    images: [{ id: `image-${index + 1}`, ordinal: 1, readable: true, recommended: true, selected: true, asset_id: `image-${index + 1}`, source_display_name: "Source", relative_path: "album/image.jpg", metadata: { w: 800, h: 1200 }, gallery: { hasError: false } }],
  }));
  return sanitizeReviewPage({
    review_id: reviewId,
    response_profile: "desktop-gallery-review-v1",
    version,
    directories: [{ directory_id: "directory-one", source_id: "source-one", source_display_name: "Source", relative_path: "album", name: "album" }],
    status,
    totalImageCount: count,
    totalGroupCount: count,
    duplicateGroupCount: count,
    unreadableImageCount: 0,
    automaticGroupCount: 0,
    automaticRejectedImageCount: 0,
    selectedImageCount: count,
    decidedGroupCount: decided ? count : 0,
    keptImageCount: decided ? count : 0,
    rejectedImageCount: 0,
    failedImageCount: 0,
    hasError: false,
    groups: { items: groups, offset: 0, limit: count, total: count },
  }, { reviewId, filter: "" });
}

function pollingHarness() {
  type Entry = { registration: PollingRegistration<ReviewSnapshot>; stop: () => boolean; signal: AbortController | null };
  const registrations = new Map<string, Entry>();
  const polling = {
    start: vi.fn((registration: PollingRegistration<ReviewSnapshot>) => {
      const entry: Entry = {
        registration,
        signal: null,
        stop: vi.fn(() => { entry.signal?.abort(); registrations.delete(registration.key); return true; }),
      };
      registrations.set(registration.key, entry);
      return { key: registration.key, scope: registration.scope ?? "", trigger: vi.fn(async () => false), stop: entry.stop };
    }),
    stop: vi.fn((key: string) => { const entry = registrations.get(key); if (!entry) return false; entry.stop(); return true; }),
    stopScope: vi.fn((scope: string) => { for (const entry of [...registrations.values()]) if (entry.registration.scope === scope) entry.stop(); return 0; }),
    getSummary: vi.fn(() => []),
    destroy: vi.fn(),
    registrations,
  };
  return polling;
}

function harness(overrides: Partial<ReviewService> = {}, initialPage = snapshot()) {
  const service = {
    readPage: vi.fn(async () => initialPage),
    adoptGroup: vi.fn(async (_id, _groupId, _selection, version) => ({ ...initialPage, version: version + 1 })),
    finishReview: vi.fn(async () => undefined),
    run: vi.fn(async () => initialPage),
    imageUrl: vi.fn((reviewId: string, imageId: string) => `http://127.0.0.1:8787/api/v1/gallery/reviews/${reviewId}/images/${imageId}`),
    ...overrides,
  } satisfies Partial<ReviewService> as ReviewService;
  const polling = pollingHarness();
  const store = createReviewStore();
  const controller = createReviewController({ store, service, polling: polling as unknown as PollingService });
  return { controller, store, service, polling };
}

async function flush(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

describe("review controller", () => {
  it("opens the one-off task and scopes active polling", async () => {
    const runtime = harness({}, snapshot("analyzing", 0));
    runtime.controller.activate();
    await runtime.controller.openReview("review-one");
    await flush();
    expect(runtime.service.readPage).toHaveBeenCalledWith("review-one", "", expect.any(AbortSignal));
    expect(runtime.polling.start).toHaveBeenCalledWith(expect.objectContaining({
      key: REVIEW_POLL_KEY,
      scope: REVIEW_SCOPE,
      intervalMs: 1_500,
      immediate: false,
      critical: false,
    }));
    runtime.controller.destroy();
    expect(runtime.polling.stopScope).toHaveBeenCalledWith(REVIEW_SCOPE);
  });

  it("adopts the focused group, rereads the authority, and advances to the next group", async () => {
    const authority = snapshot("ready", 2, true, "review-one", 3);
    const runtime = harness({}, snapshot("ready", 2, false));
    runtime.controller.activate();
    await runtime.controller.openReview("review-one");
    await flush();
    vi.mocked(runtime.service.readPage).mockResolvedValue(authority);
    expect(await runtime.controller.adoptFocused()).toBe(true);
    expect(vi.mocked(runtime.service.adoptGroup).mock.calls[0].slice(0, 4)).toEqual(["review-one", "group-1", ["image-1"], 1]);
    expect(runtime.store.getState().focusedGroupId).toBe("group-2");
    expect(runtime.store.getState().snapshot?.dirty).toBe(false);
    runtime.controller.destroy();
  });

  it("re-adopts a group after returning with Escape and changing the selection", async () => {
    const runtime = harness({}, snapshot("ready", 2, false));
    runtime.controller.activate();
    await runtime.controller.openReview("review-one");
    await flush();
    expect(await runtime.controller.adoptFocused()).toBe(true);
    expect(runtime.store.getState().focusedGroupId).toBe("group-2");
    expect(runtime.controller.moveGroup(-1)).toBe(true);
    expect(runtime.store.getState().focusedGroupId).toBe("group-1");
    expect(runtime.controller.toggleImage("group-1", "image-1")).toBe(true);
    expect(await runtime.controller.adoptFocused()).toBe(true);
    expect(vi.mocked(runtime.service.adoptGroup).mock.calls[1][2]).toEqual([]);
    runtime.controller.destroy();
  });
  it("keeps local marks on a failed adoption without leaking error details", async () => {
    const failure = Object.assign(new Error("unsafe secret"), { code: "review_state_conflict", status: 409, details: { token: "unsafe" } });
    const runtime = harness({ adoptGroup: vi.fn().mockRejectedValueOnce(failure) }, snapshot("ready", 2, false));
    runtime.controller.activate();
    await runtime.controller.openReview("review-one");
    await flush();
    runtime.controller.toggleImage("group-1", "image-1");
    const dirty = runtime.store.getState().snapshot;
    expect(await runtime.controller.adoptFocused()).toBe(false);
    expect(runtime.store.getState().snapshot).toBe(dirty);
    expect(runtime.store.getState().snapshot?.dirtyGroupIds).toEqual(["group-1"]);
    expect(JSON.stringify(runtime.store.getState())).not.toContain("unsafe");
    runtime.controller.destroy();
  });
  it("drops stale reads and writes after destroy even when adapters ignore abort", async () => {
    const page = deferred<ReviewSnapshot>();
    let pageSignal: AbortSignal | null = null;
    const staleRead = harness({ readPage: vi.fn((_reviewId, _filter, signal) => { pageSignal = signal; return page.promise; }) });
    staleRead.controller.activate();
    void staleRead.controller.openReview("review-one");
    await flush(1);
    staleRead.controller.destroy();
    expect((pageSignal as AbortSignal | null)?.aborted).toBe(true);
    page.resolve(snapshot());
    await flush();
    expect(staleRead.store.getState().snapshot).toBeNull();

    const write = deferred<ReviewOperationResult>();
    let writeSignal: AbortSignal | null = null;
    const staleWrite = harness({ adoptGroup: vi.fn((_reviewId, _groupId, _selection, _version, signal) => { writeSignal = signal; return write.promise; }) });
    staleWrite.controller.activate();
    await staleWrite.controller.openReview("review-one");
    await flush();
    staleWrite.controller.toggleImage("group-1", "image-1");
    const dirty = staleWrite.store.getState().snapshot;
    const pending = staleWrite.controller.adoptFocused();
    await flush(1);
    const readsBeforeDestroy = vi.mocked(staleWrite.service.readPage).mock.calls.length;
    staleWrite.controller.destroy();
    expect((writeSignal as AbortSignal | null)?.aborted).toBe(true);
    write.resolve({ ...snapshot(), version: 2 });
    await expect(pending).resolves.toBe(false);
    expect(staleWrite.store.getState().snapshot).toBe(dirty);
    expect(vi.mocked(staleWrite.service.readPage).mock.calls.length).toBe(readsBeforeDestroy);
  });

  it("stays on the group and reports per-image landing failures after adoption", async () => {
    const failing = sanitizeReviewPage({
      review_id: "review-one",
      response_profile: "desktop-gallery-review-v1",
      version: 2,
      directories: [],
      status: "ready",
      totalImageCount: 1,
      totalGroupCount: 1,
      duplicateGroupCount: 1,
      unreadableImageCount: 0,
      automaticGroupCount: 0,
      automaticRejectedImageCount: 0,
      selectedImageCount: 1,
      decidedGroupCount: 1,
      keptImageCount: 1,
      rejectedImageCount: 0,
      failedImageCount: 1,
      hasError: true,
      groups: { items: [{ id: "group-1", ordinal: 1, kind: "duplicate", decided: true, images: [{ id: "image-1", ordinal: 1, readable: true, recommended: true, selected: true, asset_id: "image-1", source_display_name: "Source", relative_path: "album/image.jpg", metadata: { w: 800, h: 1200 }, gallery: { hasError: true } }] }], offset: 0, limit: 1, total: 1 },
    }, { reviewId: "review-one", filter: "" });
    const runtime = harness({}, snapshot("ready", 1, false));
    runtime.controller.activate();
    await runtime.controller.openReview("review-one");
    await flush();
    vi.mocked(runtime.service.readPage).mockResolvedValue(failing);
    expect(await runtime.controller.adoptFocused()).toBe(true);
    expect(runtime.store.getState().focusedGroupId).toBe("group-1");
    expect(runtime.store.getState().message).toContain("落地失败");
    runtime.controller.destroy();
  });

  it("finishes a task, clears the workspace, and deletes the backend record", async () => {
    const runtime = harness({}, snapshot("ready", 1, false));
    runtime.controller.activate();
    await runtime.controller.openReview("review-one");
    await flush();
    expect(await runtime.controller.finish()).toBe(true);
    expect(vi.mocked(runtime.service.finishReview).mock.calls[0][0]).toBe("review-one");
    expect(runtime.store.getState().snapshot).toBeNull();
    expect(runtime.store.getState().phase).toBe("empty");
    runtime.controller.destroy();
  });

  it("finishes the old record on an explicit switch and stays on request", async () => {
    const runtime = harness();
    runtime.controller.activate();
    await runtime.controller.openReview("review-one");
    await flush();
    const draft = runtime.store.getState().snapshot;
    expect(await runtime.controller.openReview("review-two")).toBe(false);
    expect(runtime.store.getState().snapshot).toBe(draft);
    expect(runtime.store.getState().pendingReviewId).toBe("review-two");
    expect(runtime.store.getState().confirmation).toBeNull();
    expect(runtime.controller.stayOnTask()).toBe(true);
    expect(runtime.store.getState().pendingReviewId).toBe("");
    expect(runtime.store.getState().snapshot).toBe(draft);
    expect(await runtime.controller.openReview("review-two")).toBe(false);
    vi.mocked(runtime.service.readPage).mockResolvedValue(snapshot("ready", 1, false, "review-two", 7));
    expect(await runtime.controller.switchToPending()).toBe(true);
    expect(vi.mocked(runtime.service.finishReview).mock.calls[0][0]).toBe("review-one");
    expect(runtime.store.getState().snapshot?.reviewId).toBe("review-two");
    runtime.controller.destroy();
  });

  it("ignores a hidden page's late polling response and resumes the same identity", async () => {
    const runtime = harness({}, snapshot("analyzing", 0));
    runtime.controller.activate();
    await runtime.controller.openReview("review-one");
    await flush();
    const poll = runtime.polling.registrations.get(REVIEW_POLL_KEY)!;
    const original = runtime.store.getState().snapshot;
    runtime.controller.deactivate();
    expect(runtime.polling.registrations.size).toBe(0);
    poll.registration.onResult?.(snapshot("ready", 1));
    expect(runtime.store.getState().snapshot).toBe(original);
    runtime.controller.activate();
    await runtime.controller.openReview("review-one");
    await flush();
    expect(runtime.polling.registrations.size).toBe(1);
    runtime.controller.destroy();
  });

  it("returns polling and request resources to baseline over twenty lifecycles", async () => {
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const current = harness({}, snapshot("analyzing", 0));
      current.controller.activate();
      await current.controller.openReview("review-one");
      await flush();
      expect(current.polling.registrations.size).toBe(1);
      current.controller.destroy();
      expect(current.polling.registrations.size).toBe(0);
    }
  });
});
