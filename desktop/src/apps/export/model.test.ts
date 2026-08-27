import { describe, expect, it } from "vitest";

import {
  EXPORT_BLOCKER_CODES,
  EXPORT_BLOCKER_LABELS,
  EXPORT_JOB_STATES,
  EXPORT_STATE_LABELS,
  EXPORT_TERMINAL_STATES,
  formatExportBytes,
  sanitizeExportBlocker,
  sanitizeExportJobDetail,
  sanitizeExportJobSummary,
  validateExportAlias,
} from "./model";

function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    export_id: "exp-001",
    status: "ready",
    sample_count: 12,
    staged_sample_count: 0,
    committed_sample_count: 0,
    image_bytes: 1024,
    txt_bytes: 512,
    created_at: 1700000000,
    updated_at: 1700000100,
    error_class: null,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe("export job model sanitization", () => {
  it("sanitizes a full job summary with authoritative counts", () => {
    const job = sanitizeExportJobSummary(summaryFixture());
    expect(job.export_id).toBe("exp-001");
    expect(job.status).toBe("ready");
    expect(job.sample_count).toBe(12);
    expect(job.error_class).toBeNull();
    expect(Object.isFrozen(job)).toBe(true);
  });

  it("rejects unknown status values, extra keys and accessor traps", () => {
    expect(() => sanitizeExportJobSummary(summaryFixture({ status: "invented" }))).toThrow(TypeError);
    expect(() => sanitizeExportJobSummary(summaryFixture({ progress_percent: 42 }))).toThrow(TypeError);
    let reads = 0;
    const raw = Object.defineProperty(summaryFixture(), "status", {
      enumerable: true,
      get() {
        reads += 1;
        return "ready";
      },
    });
    expect(() => sanitizeExportJobSummary(raw)).toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it("rejects negative counts and non-finite bytes", () => {
    expect(() => sanitizeExportJobSummary(summaryFixture({ sample_count: -1 }))).toThrow(TypeError);
    expect(() => sanitizeExportJobSummary(summaryFixture({ image_bytes: Number.NaN }))).toThrow(TypeError);
    expect(() => sanitizeExportJobSummary(summaryFixture({ started_at: -5 }))).toThrow(TypeError);
  });

  it("sanitizes blockers with stable codes only", () => {
    expect(sanitizeExportBlocker({ code: "txt_missing", count: 3 })).toEqual({ code: "txt_missing", count: 3 });
    expect(() => sanitizeExportBlocker({ code: "custom_code", count: 1 })).toThrow(TypeError);
    expect(() => sanitizeExportBlocker({ code: "txt_empty", count: -1 })).toThrow(TypeError);
    for (const code of EXPORT_BLOCKER_CODES) {
      expect(EXPORT_BLOCKER_LABELS[code].length).toBeGreaterThan(0);
    }
  });

  it("sanitizes job detail with sources and blockers", () => {
    const detail = sanitizeExportJobDetail({
      ...summaryFixture({ status: "blocked" }),
      sources: [
        {
          source_id: "src-1",
          directory_id: "dir-1",
          include_descendants: true,
          output_alias: "batch-a",
        },
      ],
      blockers: [{ code: "txt_missing", count: 2 }],
    });
    expect(detail.status).toBe("blocked");
    expect(detail.sources[0].output_alias).toBe("batch-a");
    expect(detail.blockers[0].code).toBe("txt_missing");
    expect(() =>
      sanitizeExportJobDetail({
        ...summaryFixture(),
        sources: [],
        blockers: [],
        target_path: "/absolute/secret",
      }),
    ).toThrow(TypeError);
  });

  it("keeps the 12-state machine mirrored and labels complete", () => {
    expect(EXPORT_JOB_STATES).toHaveLength(12);
    expect(EXPORT_TERMINAL_STATES).toEqual(["completed", "discarded", "failed"]);
    for (const state of EXPORT_JOB_STATES) {
      expect(EXPORT_STATE_LABELS[state].length).toBeGreaterThan(0);
    }
  });

  it("validates aliases and formats bytes deterministically", () => {
    expect(validateExportAlias("batch-a")).toBe(true);
    expect(validateExportAlias("")).toBe(false);
    expect(validateExportAlias("a/b")).toBe(false);
    expect(validateExportAlias("超长".repeat(33))).toBe(false);
    expect(validateExportAlias("超长".repeat(32))).toBe(true);
    expect(formatExportBytes(0)).toBe("0 B");
    expect(formatExportBytes(1536)).toContain("KiB");
    expect(formatExportBytes(3 * 1024 * 1024)).toContain("MiB");
  });
});
