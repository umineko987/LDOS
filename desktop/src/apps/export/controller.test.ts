import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../core/api/client";

import type { ExportBlocker, ExportJobDetail, ExportJobSummary } from "./model";
import { createExportController, exportJobNeedsPolling } from "./controller";
import { createExportStore, type ExportStore } from "./state";
import type { ExportService, ExportSourceInput } from "./service";

function summaryFixture(overrides: Partial<ExportJobSummary> = {}): ExportJobSummary {
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

function detailFixture(overrides: Partial<ExportJobDetail> = {}): ExportJobDetail {
  return {
    ...summaryFixture(),
    sources: [
      {
        source_id: "src-1",
        directory_id: "dir-1",
        include_descendants: true,
        output_alias: "batch-a",
      },
    ],
    blockers: [],
    ...overrides,
  };
}

function makeService(overrides: Partial<ExportService> = {}): ExportService {
  return {
    listJobs: vi.fn(async () => ({ jobs: [summaryFixture()], mayHaveMore: false })),
    getJob: vi.fn(async () => detailFixture()),
    getBlockers: vi.fn(async () => [] as ExportBlocker[]),
    createExport: vi.fn(async (_target: string, _selections: readonly ExportSourceInput[]) => ({
      job: summaryFixture(),
      blockers: [],
    })),
    start: vi.fn(async () => summaryFixture({ status: "staging" })),
    pause: vi.fn(async () => summaryFixture({ status: "paused" })),
    resume: vi.fn(async () => summaryFixture({ status: "staging" })),
    discard: vi.fn(async () => summaryFixture({ status: "discarded" })),
    ...overrides,
  } as ExportService;
}

function makeController(service: ExportService): { controller: ReturnType<typeof createExportController>; store: ExportStore } {
  const store = createExportStore();
  const controller = createExportController({} as ApiClient, store, service);
  return { controller, store };
}

describe("export controller", () => {
  it("activates once, loads the job list, and destroys cleanly", async () => {
    const service = makeService();
    const { controller, store } = makeController(service);
    expect(controller.activate()).toBe(true);
    expect(controller.activate()).toBe(false);
    await vi.waitFor(() => expect(store.getState().jobs.phase).toBe("ready"));
    controller.destroy();
    expect(store.getState().jobs.phase).toBe("idle");
  });

  it("opens and refreshes job detail", async () => {
    const service = makeService();
    const { controller, store } = makeController(service);
    await controller.openDetail("exp-001");
    expect(store.getState().detail.phase).toBe("ready");
    expect(store.getState().detail.job?.export_id).toBe("exp-001");

    await controller.refreshDetail();
    expect(service.getJob).toHaveBeenCalledTimes(2);

    controller.closeDetail();
    expect(store.getState().detail.phase).toBe("idle");
  });

  it("records detail errors without crashing", async () => {
    const service = makeService({
      getJob: vi.fn(async () => {
        throw new Error("export_not_found");
      }),
    });
    const { controller, store } = makeController(service);
    const ok = await controller.openDetail("exp-missing");
    expect(ok).toBe(false);
    expect(store.getState().detail.phase).toBe("error");
    expect(store.getState().detail.errorCode).toBe("export_not_found");
  });

  it("drives start, pause, resume and discard through the operation state", async () => {
    const service = makeService();
    const { controller, store } = makeController(service);
    controller.activate();
    await vi.waitFor(() => expect(store.getState().jobs.phase).toBe("ready"));

    expect(await controller.startJob("exp-001")).toBe(true);
    expect(store.getState().operation.phase).toBe("idle");
    expect(store.getState().jobs.jobs[0].status).toBe("staging");

    expect(await controller.pauseJob("exp-001")).toBe(true);
    expect(store.getState().jobs.jobs[0].status).toBe("paused");

    expect(await controller.discardJob("exp-001")).toBe(true);
    expect(store.getState().jobs.jobs[0].status).toBe("discarded");
  });

  it("captures operation failures as stable error codes", async () => {
    const service = makeService({
      start: vi.fn(async () => {
        throw new Error("export_state_invalid");
      }),
    });
    const { controller, store } = makeController(service);
    expect(await controller.startJob("exp-001")).toBe(false);
    expect(store.getState().operation.phase).toBe("error");
    expect(store.getState().operation.errorCode).toBe("export_state_invalid");
  });

  it("exposes polling semantics for non-terminal, non-blocked jobs", () => {
    expect(exportJobNeedsPolling(summaryFixture({ status: "staging" }))).toBe(true);
    expect(exportJobNeedsPolling(summaryFixture({ status: "paused" }))).toBe(true);
    expect(exportJobNeedsPolling(summaryFixture({ status: "blocked" }))).toBe(false);
    expect(exportJobNeedsPolling(summaryFixture({ status: "completed" }))).toBe(false);
    expect(exportJobNeedsPolling(summaryFixture({ status: "discarded" }))).toBe(false);
    expect(exportJobNeedsPolling(summaryFixture({ status: "failed" }))).toBe(false);
  });

  it("loads more pages only when a page is ready and more exist", async () => {
    const service = makeService();
    const { controller, store } = makeController(service);
    expect(await controller.loadMoreJobs()).toBe(false); // 未加载
    controller.activate();
    await vi.waitFor(() => expect(store.getState().jobs.phase).toBe("ready"));
    expect(await controller.loadMoreJobs()).toBe(false); // mayHaveMore=false
    expect(service.listJobs).toHaveBeenCalledTimes(1);
  });
});
