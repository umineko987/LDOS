import { describe, expect, it } from "vitest";

import {
  GALLERY_PREVIEW_DEFAULTS,
  galleryPreviewPresentation,
  sanitizeGalleryPreviewState,
  updateGalleryPreviewState,
} from "./model";

describe("gallery preview model", () => {
  it("projects only the explicit unavailable preview state", () => {
    const state = sanitizeGalleryPreviewState({ ...GALLERY_PREVIEW_DEFAULTS });
    expect(state).toEqual(GALLERY_PREVIEW_DEFAULTS);
    expect(Object.isFrozen(state)).toBe(true);
    expect(updateGalleryPreviewState(state, { collection: "favorites", query: "portrait", sort: "site", mode: "list", inspectorOpen: false })).toEqual({
      phase: "unavailable",
      collection: "favorites",
      query: "portrait",
      sort: "site",
      mode: "list",
      inspectorOpen: false,
    });
    expect(galleryPreviewPresentation()).toEqual(expect.objectContaining({ kind: "disabled", label: "后端能力尚未接入" }));
  });

  it("rejects fabricated content states, extra keys, controls and accessors", () => {
    expect(() => sanitizeGalleryPreviewState({ ...GALLERY_PREVIEW_DEFAULTS, phase: "content" })).toThrow(TypeError);
    expect(() => sanitizeGalleryPreviewState({ ...GALLERY_PREVIEW_DEFAULTS, items: ["fake"] })).toThrow(TypeError);
    expect(() => updateGalleryPreviewState(GALLERY_PREVIEW_DEFAULTS, { query: "line\nfeed" })).toThrow(TypeError);
    let reads = 0;
    const raw = Object.defineProperty({ ...GALLERY_PREVIEW_DEFAULTS }, "query", { enumerable: true, get: () => { reads += 1; return "unsafe"; } });
    expect(() => sanitizeGalleryPreviewState(raw)).toThrow(TypeError);
    expect(reads).toBe(0);
  });
});
