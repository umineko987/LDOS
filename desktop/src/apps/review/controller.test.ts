import { describe, expect, it, vi } from "vitest";

import type { PersistenceService } from "../../core/persistence/service";
import type { PollingRegistration, PollingService } from "../../core/polling/service";
import { createReviewController, REVIEW_POLL_KEY, REVIEW_SCOPE } from "./controller";
import { sanitizeReviewPage, type ReviewOperationResult, type ReviewTaskPage, type ReviewSnapshot } from "./model";
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
    images: [{ id: `image-${index + 1}`, ordinal: 1, readable: true, recommended: true, selected: true, asset_id: `image-${index + 1}`, source_display_name: "Source", relative_path: "album/image.jpg", metadata: { w: 800, h: 1200 } }],
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
    readRecent: vi.fn(async () => ({ items: [initialPage], total: 1, offset: 0, limit: 50 })),
    readPage: vi.fn(async () => initialPage),
    writeDecisions: vi.fn(async (_id, payload) => ({ ...initialPage, version: payload.version + 1 })),
    run: vi.fn(async () => initialPage),
    imageUrl: vi.fn((reviewId: string, imageId: string) => `http://127.0.0.1:8787/api/v1/gallery/reviews/${reviewId}/images/${imageId}`),
    ...overrides,
  } satisfies Partial<ReviewService> as ReviewService;
  const persistence = {
    readActiveReviewId: vi.fn(() => "review-one"),
    writeActiveReviewId: vi.fn(() => true),
  } as unknown as PersistenceService;
  const polling = pollingHarness();
  const store = createReviewStore();
  const controller = createReviewController({ store, service, polling: polling as unknown as PollingService, persistence });
  return { controller, store, service, polling, persistence };
}

async function flush(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

describe("review controller", () => {
  it("loads recent plus the persisted independent task and scopes active polling", async () => {
    const runtime = harness({}, snapshot("analyzing", 0));
    runtime.controller.activate();
    await flush();
    expect(runtime.service.readRecent).toHaveBeenCalledOnce();
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

  it("serializes leave, minimize, and close through one chunked save plus one authority reread", async () => {
    const authority = snapshot("ready", 51, true, "review-one", 3);
    const write = deferred<ReviewOperationResult>();
    const runtime = harness({
      writeDecisions: vi.fn(async (_id, payload) => { await write.promise; return { ...authority, version: payload.version + 1 }; }),
      readPage: vi.fn(async () => snapshot("ready", 51, false)),
    }, snapshot("ready", 51, false));
    runtime.controller.activate();
    await flush();
    for (let index = 1; index <= 51; index += 1) expect(runtime.store.confirmGroup(`group-${index}`)).toBe(true);
    const beforeReadCount = vi.mocked(runtime.service.readPage).mock.calls.length;
    const leave = runtime.controller.beforeLeave();
    const minimized = runtime.controller.beforeWindowHide("minimized");
    const closed = runtime.controller.beforeWindowHide("closed");
    expect(minimized).toBe(leave);
    expect(closed).toBe(leave);
    vi.mocked(runtime.service.readPage).mockResolvedValue(authority);
    write.resolve({ ...snapshot(), version: 2 });
    await flush();
    await expect(leave).resolves.toBe(true);
    expect(vi.mocked(runtime.service.writeDecisions).mock.calls.map(([, payload]) => [payload.groups.length, payload.version])).toEqual([[50, 1], [1, 2]]);
    expect(vi.mocked(runtime.service.readPage).mock.calls.length).toBe(beforeReadCount + 1);
    expect(runtime.store.getState().snapshot?.dirty).toBe(false);
    runtime.controller.destroy();
  });

  it("advances again from an already confirmed group after returning with Escape", async () => {
    const runtime = harness({}, snapshot("ready", 2, false));
    runtime.controller.activate();
    await flush();
    await expect(runtime.controller.confirmAndAdvance()).resolves.toBe(true);
    expect(runtime.store.getState().focusedGroupId).toBe("group-2");
    expect(runtime.controller.moveGroup(-1)).toBe(true);
    expect(runtime.store.getState().focusedGroupId).toBe("group-1");
    await expect(runtime.controller.confirmAndAdvance()).resolves.toBe(true);
    expect(runtime.store.getState().focusedGroupId).toBe("group-2");
    runtime.controller.destroy();
  });
  it("keeps the complete draft on a failed write and retries an identical payload", async () => {
    const failure = Object.assign(new Error("unsafe secret"), { code: "review_state_conflict", status: 409, details: { token: "unsafe" } });
    const runtime = harness({ writeDecisions: vi.fn().mockRejectedValueOnce(failure) }, snapshot("ready", 2, false));
    runtime.controller.activate();
    await flush();
    runtime.store.confirmGroup("group-1");
    runtime.store.confirmGroup("group-2");
    await expect(runtime.controller.beforeLeave()).resolves.toBe(false);
    const firstPayload = vi.mocked(runtime.service.writeDecisions).mock.calls[0][1];
    expect(runtime.store.getState().snapshot?.dirtyGroupIds).toEqual(["group-1", "group-2"]);
    expect(JSON.stringify(runtime.store.getState())).not.toContain("unsafe");

    vi.mocked(runtime.service.writeDecisions).mockResolvedValue({ ...snapshot(), version: 2 });
    vi.mocked(runtime.service.readPage).mockResolvedValue(snapshot("ready", 2, true));
    await expect(runtime.controller.beforeWindowHide("closed")).resolves.toBe(true);
    expect(vi.mocked(runtime.service.writeDecisions).mock.calls[1][1]).toEqual(firstPayload);
    runtime.controller.destroy();
  });

  it("drops stale reads and writes after destroy even when adapters ignore abort", async () => {
    const recent = deferred<ReviewTaskPage>();
    let recentSignal: AbortSignal | null = null;
    const staleRead = harness({ readRecent: vi.fn((signal) => { recentSignal = signal; return recent.promise; }) });
    staleRead.controller.activate();
    await flush(1);
    staleRead.controller.destroy();
    expect((recentSignal as AbortSignal | null)?.aborted).toBe(true);
    recent.resolve({ items: [], total: 0, offset: 0, limit: 50 });
    await flush();
    expect(staleRead.store.getState().recent).toEqual([]);

    const write = deferred<ReviewOperationResult>();
    let writeSignal: AbortSignal | null = null;
    const staleWrite = harness({ writeDecisions: vi.fn((_reviewId, _payload, signal) => { writeSignal = signal; return write.promise; }) });
    staleWrite.controller.activate();
    await flush();
    staleWrite.store.confirmGroup("group-1");
    const dirty = staleWrite.store.getState().snapshot;
    const pending = staleWrite.controller.beforeLeave();
    await flush(1);
    const readsBeforeDestroy = vi.mocked(staleWrite.service.readPage).mock.calls.length;
    staleWrite.controller.destroy();
    expect((writeSignal as AbortSignal | null)?.aborted).toBe(true);
    write.resolve({ ...snapshot(), version: 2 });
    await expect(pending).resolves.toBe(false);
    expect(staleWrite.store.getState().snapshot).toBe(dirty);
    expect(vi.mocked(staleWrite.service.readPage).mock.calls.length).toBe(readsBeforeDestroy);
  });

  it("reports a partial apply failure without claiming all rejected files were recycled", async () => {
    const initial = snapshot("ready", 1, true);
    const failed = snapshot("apply_failed", 1, true, "review-one", 3);
    const runtime = harness({}, initial);
    runtime.controller.activate();
    await flush();
    vi.mocked(runtime.service.readPage).mockResolvedValue(failed);
    expect(runtime.controller.requestApply()).toBe(true);
    expect(await runtime.controller.confirmAction(true)).toBe(true);
    expect(runtime.store.getState().snapshot?.summary.status).toBe("apply_failed");
    expect(runtime.store.getState().message).toContain("部分图片未能进入回收区");
    expect(runtime.controller.requestApply()).toBe(true);
    runtime.controller.destroy();
  });
  it("queues a new identity without overwriting a dirty draft and allows an explicit discard switch", async () => {
    const runtime = harness();
    runtime.controller.activate();
    await flush();
    runtime.store.confirmGroup("group-1");
    const draft = runtime.store.getState().snapshot;
    expect(await runtime.controller.openReview("review-two")).toBe(false);
    expect(runtime.store.getState().snapshot).toBe(draft);
    expect(runtime.store.getState().pendingReviewId).toBe("review-two");
    vi.mocked(runtime.service.writeDecisions).mockRejectedValueOnce({ status: 409, code: "review_state_conflict" });
    expect(await runtime.controller.saveAndSwitch()).toBe(false);
    expect(runtime.store.getState().snapshot).toBe(draft);
    expect(runtime.controller.requestDiscardSwitch()).toBe(true);
    vi.mocked(runtime.service.readPage).mockResolvedValue(snapshot("ready", 1, false, "review-two", 7));
    expect(await runtime.controller.confirmAction(true)).toBe(true);
    expect(runtime.store.getState().snapshot?.reviewId).toBe("review-two");
    expect(runtime.persistence.writeActiveReviewId).toHaveBeenLastCalledWith("review-two");
    runtime.controller.destroy();
  });

  it("ignores a hidden page's late polling response and resumes the same identity", async () => {
    const runtime = harness({}, snapshot("analyzing", 0));
    runtime.controller.activate();
    await flush();
    const poll = runtime.polling.registrations.get(REVIEW_POLL_KEY)!;
    const original = runtime.store.getState().snapshot;
    runtime.controller.deactivate();
    expect(runtime.polling.registrations.size).toBe(0);
    poll.registration.onResult?.(snapshot("ready", 1));
    expect(runtime.store.getState().snapshot).toBe(original);
    runtime.controller.activate();
    await flush();
    expect(runtime.polling.registrations.size).toBe(1);
    runtime.controller.destroy();
  });

  it("returns polling and request resources to baseline over twenty lifecycles", async () => {
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const current = harness({}, snapshot("analyzing", 0));
      current.controller.activate();
      await flush();
      expect(current.polling.registrations.size).toBe(1);
      current.controller.destroy();
      expect(current.polling.registrations.size).toBe(0);
    }
  });
});
