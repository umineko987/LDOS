import { describe, expect, it, vi } from "vitest";

import type { ExportJobSummary } from "./model";
import { createExportStore, EXPORT_INITIAL_STATE, exportStatesEqual } from "./state";

function jobFixture(overrides: Partial<ExportJobSummary> = {}): ExportJobSummary {
  return {
    export_id: "exp-001",
    status: "ready",
    sample_count: 3,
    staged_sample_count: 0,
    committed_sample_count: 0,
    image_bytes: 100,
    txt_bytes: 50,
    created_at: 1700000000,
    updated_at: 1700000100,
    error_class: null,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe("export store", () => {
  it("starts from a frozen idle projection and replays state on subscribe", () => {
    const store = createExportStore();
    expect(store.getState()).toEqual(EXPORT_INITIAL_STATE);
    expect(Object.isFrozen(EXPORT_INITIAL_STATE)).toBe(true);

    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toEqual(EXPORT_INITIAL_STATE);
    unsubscribe();
  });

  it("transitions jobs through loading, ready and error phases", () => {
    const store = createExportStore();
    store.setJobsLoading();
    expect(store.getState().jobs.phase).toBe("loading");

    store.appendJobs([jobFixture()], { mayHaveMore: false, replace: true });
    const loaded = store.getState();
    expect(loaded.jobs.phase).toBe("ready");
    expect(loaded.jobs.jobs).toHaveLength(1);
    expect(loaded.jobs.loadedCount).toBe(1);

    store.setJobsError("export_unavailable");
    expect(store.getState().jobs.phase).toBe("error");
    expect(store.getState().jobs.errorCode).toBe("export_unavailable");
  });

  it("merges job pages by export_id and sorts by recency", () => {
    const store = createExportStore();
    store.appendJobs([jobFixture({ export_id: "exp-a", updated_at: 100 })], { mayHaveMore: true, replace: true });
    store.appendJobs([jobFixture({ export_id: "exp-b", updated_at: 200 })], { mayHaveMore: false, replace: false });
    const state = store.getState();
    expect(state.jobs.jobs.map((job) => job.export_id)).toEqual(["exp-b", "exp-a"]);
    expect(state.jobs.mayHaveMore).toBe(false);
  });

  it("rejects fabricated job payloads at the store boundary", () => {
    const store = createExportStore();
    expect(() =>
      store.appendJobs([{ fabricated: true } as unknown as ExportJobSummary], {
        mayHaveMore: false,
        replace: true,
      }),
    ).toThrow(TypeError);
  });

  it("manages detail state and operation state with equality guard", () => {
    const store = createExportStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setDetailLoading("exp-001");
    expect(store.getState().detail.phase).toBe("loading");
    expect(store.getState().detail.exportId).toBe("exp-001");

    store.setDetailError("exp-001", "export_not_found");
    expect(store.getState().detail.phase).toBe("error");

    const before = listener.mock.calls.length;
    store.setDetailError("exp-001", "export_not_found");
    expect(listener.mock.calls.length).toBe(before); // 无变化不发布

    store.clearDetail();
    expect(store.getState().detail.phase).toBe("idle");

    store.setOperationBusy("start", "exp-001");
    expect(store.getState().operation).toEqual({
      kind: "start",
      exportId: "exp-001",
      phase: "busy",
      errorCode: null,
    });
    store.setOperationError("start", "exp-001", "export_state_invalid");
    expect(store.getState().operation.phase).toBe("error");
    store.setOperationIdle();
    expect(store.getState().operation.phase).toBe("idle");
  });

  it("patches a job summary in place and isolates throwing subscribers", () => {
    const store = createExportStore();
    store.appendJobs([jobFixture({ status: "ready" })], { mayHaveMore: false, replace: true });
    const broken = vi.fn(() => {
      throw new Error("listener crash");
    });
    store.subscribe(broken);

    store.patchJobSummary(jobFixture({ status: "staging" }));
    expect(store.getState().jobs.jobs[0].status).toBe("staging");
    expect(broken).toHaveBeenCalled();

    const healthy = vi.fn();
    store.subscribe(healthy);
    expect(healthy).toHaveBeenCalled(); // 抛错订阅者不阻断后续发布。
  });

  it("compares states structurally and resets to initial", () => {
    const store = createExportStore();
    expect(exportStatesEqual(store.getState(), EXPORT_INITIAL_STATE)).toBe(true);
    store.setJobsLoading();
    expect(exportStatesEqual(store.getState(), EXPORT_INITIAL_STATE)).toBe(false);
    store.reset();
    expect(store.getState()).toEqual(EXPORT_INITIAL_STATE);
  });
});
