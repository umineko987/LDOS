import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER_OPTIONS, cloneFilterOptions, filterConfigBlockers, filterOptionsSummary,
  sanitizeFilterCapabilities, sanitizeFilterConfig, sanitizeFilterOptions, validateFilterName,
} from "./model";

const unavailable = {
  filter_monochrome: { available: false, reason: "monochrome not integrated" },
  filter_sketch: { available: false, reason: "sketch not integrated" },
  filter_character: { available: false, reason: "character not integrated" },
};

describe("filter preset model", () => {
  it("preserves all independent combinations and empty reference templates", () => {
    for (let mask = 0; mask < 32; mask += 1) {
      const raw = {
        basic_dedup: !!(mask & 1), filter_monochrome: !!(mask & 2), filter_sketch: !!(mask & 4),
        filter_character: !!(mask & 8), similarity_groups: !!(mask & 16), reference_asset_ids: [],
      };
      expect(sanitizeFilterOptions(raw)).toEqual(raw);
    }
    expect(sanitizeFilterConfig({ preset_name: " draft ", options: EMPTY_FILTER_OPTIONS }).preset_name).toBe("draft");
  });

  it("clones references without sharing arrays or rewriting asset ids", () => {
    const ids = ["old/off-page", "two"];
    const options = sanitizeFilterOptions({ ...EMPTY_FILTER_OPTIONS, reference_asset_ids: ids });
    const clone = cloneFilterOptions(options);
    ids.push("not-in-config");
    expect(clone.reference_asset_ids).toEqual(["old/off-page", "two"]);
    expect(clone.reference_asset_ids).not.toBe(options.reference_asset_ids);
    expect(Object.isFrozen(clone.reference_asset_ids)).toBe(true);
  });

  it("rejects unknown fields, accessors, non-booleans and invalid reference limits", () => {
    expect(() => sanitizeFilterOptions({ ...EMPTY_FILTER_OPTIONS, algorithm: "threshold" })).toThrow();
    expect(() => sanitizeFilterOptions({ ...EMPTY_FILTER_OPTIONS, basic_dedup: 1 })).toThrow();
    expect(() => sanitizeFilterOptions({ ...EMPTY_FILTER_OPTIONS, reference_asset_ids: [""] })).toThrow();
    expect(() => sanitizeFilterOptions({ ...EMPTY_FILTER_OPTIONS, reference_asset_ids: ["x".repeat(129)] })).toThrow();
    expect(() => sanitizeFilterOptions({ ...EMPTY_FILTER_OPTIONS, reference_asset_ids: Array(201).fill("id") })).toThrow();
    const getter = { ...EMPTY_FILTER_OPTIONS };
    Object.defineProperty(getter, "basic_dedup", { get: () => { throw new Error("must not invoke"); } });
    expect(() => sanitizeFilterOptions(getter)).toThrow("invalid_filter_options");
  });

  it("trims names and rejects empty, oversized and control-character names", () => {
    expect(validateFilterName("  test  ")).toBe("test");
    for (const name of [" ", "x".repeat(81), "a\nb", "a\u007fb"]) expect(() => validateFilterName(name)).toThrow();
  });

  it("fails closed for missing capabilities without changing saved choices", () => {
    const options = sanitizeFilterOptions({ ...EMPTY_FILTER_OPTIONS, filter_character: true, filter_sketch: true });
    expect(filterConfigBlockers(options, null).map(({ option }) => option)).toEqual(["filter_sketch", "filter_character", "reference_asset_ids"]);
    expect(filterConfigBlockers(options, sanitizeFilterCapabilities(unavailable))[0].reason).toBe("sketch not integrated");
    expect(options.filter_character).toBe(true);
    expect(filterConfigBlockers(EMPTY_FILTER_OPTIONS, null)).toEqual([]);
    expect(() => sanitizeFilterCapabilities({ ...unavailable, filter_character: { available: false, reason: "" } })).toThrow();
    expect(() => sanitizeFilterCapabilities({ filter_sketch: unavailable.filter_sketch })).toThrow();
    expect(() => sanitizeFilterCapabilities({ ...unavailable, filter_character: { available: "true", reason: "" } })).toThrow();
  });

  it("summarizes enabled functions and blocks only execution, not template saving", () => {
    const options = { ...EMPTY_FILTER_OPTIONS, similarity_groups: true, filter_character: true, reference_asset_ids: ["ref"] };
    const ready = sanitizeFilterCapabilities({ ...unavailable, filter_character: { available: true, reason: "" } });
    expect(filterConfigBlockers(options, ready)).toEqual([]);
    expect(filterOptionsSummary(options)).toEqual(["非目标角色", "相似图片分组"]);
  });
});
