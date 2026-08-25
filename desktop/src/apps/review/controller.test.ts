import { describe, expect, it, vi } from "vitest";

import type { PersistenceService } from "../../core/persistence/service";
import type { PollingRegistration, PollingService } from "../../core/polling/service";
import { createReviewController, REVIEW_POLL_KEY, REVIEW_SCOPE } from "./controller";
import { sanitizeReviewPage, type ReviewSnapshot } from "./model";
import type { ReviewService } from "./service";
import { createReviewStore } from "./state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function snapshot(status = "ready", count = 1, decided = false): ReviewSnapshot {
  const groups = Array.from({ length: count }, (_, index) => ({
    id: `group-${index + 1}`,
    ordinal: index + 1,
    kind: "duplicate",
    decided,
    images: [{ id: `image-${index + 1}`, ordinal: 1, readable: true, recommended: true, selected: true, metadata: { w: 800, h: 1200 } }],
  }));
  return sanitizeReviewPage({
    batch_id: "batch-review",
    status,
    total_image_count: count,
    total_group_count: count,
    duplicate_group_count: count,
    unreadable_image_count: 0,
    automatic_group_count: 0,
    automatic_rejected_image_count: 0,
    selected_image_count: count,
    decided_group_count: decided ? count : 0,
    kept_image_count: decided ? count : 0,
    rejected_image_count: 0,
    failed_image_count: 0,
    error: "",
    groups: { items: groups, offset: 0, limit: count, total: count },
  }, { batchId: "batch-review", filter: "" });
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
    readRecent: vi.fn(async () => [{ id: "batch-review", status: "succeeded", statusLabel: "成功", createdAt: null, terminal: true }] as const),
    readPage: vi.fn(async () => initialPage),
    writeDecisions: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    imageUrl: vi.fn((batchId: string, imageId: string) => `http://127.0.0.1:8787/api/v1/crawls/${batchId}/review/images/${imageId}`),
    ...overrides,
  } as ReviewService;
  const persistence = {
    readActiveBatchId: vi.fn(() => "batch-review"),
    writeActiveBatchId: vi.fn(() => true),
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
  it("loads recent plus the persisted terminal batch and scopes active polling", async () => {
    const runtime = harness({}, snapshot("analyzing", 0));
    runtime.controller.activate();
    await flush();
    expect(runtime.service.readRecent).toHaveBeenCalledOnce();
    expect(runtime.service.readPage).toHaveBeenCalledWith("batch-review", "", expect.any(AbortSignal));
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
    const authority = snapshot("ready", 51, true);
    const write = deferred<void>();
    const runtime = harness({
      writeDecisions: vi.fn(async () => write.promise),
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
    write.resolve();
    await flush();
    await expect(leave).resolves.toBe(true);
    expect(vi.mocked(runtime.service.writeDecisions).mock.calls.map(([, payload]) => payload.groups.length)).toEqual([50, 1]);
    expect(vi.mocked(runtime.service.readPage).mock.calls.length).toBe(beforeReadCount + 1);
    expect(runtime.store.getState().snapshot?.dirty).toBe(false);
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

    vi.mocked(runtime.service.writeDecisions).mockResolvedValue(undefined);
    vi.mocked(runtime.service.readPage).mockResolvedValue(snapshot("ready", 2, true));
    await expect(runtime.controller.beforeWindowHide("closed")).resolves.toBe(true);
    expect(vi.mocked(runtime.service.writeDecisions).mock.calls[1][1]).toEqual(firstPayload);
    runtime.controller.destroy();
  });

  it("drops stale reads and writes after destroy even when adapters ignore abort", async () => {
    const recent = deferred<readonly never[]>();
    let recentSignal: AbortSignal | null = null;
    const staleRead = harness({ readRecent: vi.fn((signal) => { recentSignal = signal; return recent.promise; }) });
    staleRead.controller.activate();
    await flush(1);
    staleRead.controller.destroy();
    expect((recentSignal as AbortSignal | null)?.aborted).toBe(true);
    recent.resolve([]);
    await flush();
    expect(staleRead.store.getState().recent).toEqual([]);

    const write = deferred<void>();
    let writeSignal: AbortSignal | null = null;
    const staleWrite = harness({ writeDecisions: vi.fn((_batchId, _payload, signal) => { writeSignal = signal; return write.promise; }) });
    staleWrite.controller.activate();
    await flush();
    staleWrite.store.confirmGroup("group-1");
    const dirty = staleWrite.store.getState().snapshot;
    const pending = staleWrite.controller.beforeLeave();
    await flush(1);
    const readsBeforeDestroy = vi.mocked(staleWrite.service.readPage).mock.calls.length;
    staleWrite.controller.destroy();
    expect((writeSignal as AbortSignal | null)?.aborted).toBe(true);
    write.resolve();
    await expect(pending).resolves.toBe(false);
    expect(staleWrite.store.getState().snapshot).toBe(dirty);
    expect(vi.mocked(staleWrite.service.readPage).mock.calls.length).toBe(readsBeforeDestroy);
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
