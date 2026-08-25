import { describe, expect, it } from "vitest";

import { EXPORT_PREVIEW_DEFAULTS, exportPreviewPresentation, sanitizeExportPreviewState } from "./model";

describe("export preview model", () => {
  it("projects only the explicit unavailable state", () => {
    expect(sanitizeExportPreviewState({ phase: "unavailable" })).toBe(EXPORT_PREVIEW_DEFAULTS);
    expect(Object.isFrozen(EXPORT_PREVIEW_DEFAULTS)).toBe(true);
    expect(exportPreviewPresentation()).toEqual(expect.objectContaining({ kind: "disabled", label: "后端能力尚未接入" }));
  });

  it("rejects fabricated jobs, extra keys and accessors", () => {
    expect(() => sanitizeExportPreviewState({ phase: "content" })).toThrow(TypeError);
    expect(() => sanitizeExportPreviewState({ phase: "unavailable", progress: 42 })).toThrow(TypeError);
    let reads = 0;
    const raw = Object.defineProperty({}, "phase", { enumerable: true, get: () => { reads += 1; return "unavailable"; } });
    expect(() => sanitizeExportPreviewState(raw)).toThrow(TypeError);
    expect(reads).toBe(0);
  });
});
