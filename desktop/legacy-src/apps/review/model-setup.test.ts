import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../core/api/client";
import { baseModelsReady, sanitizeModelSetup } from "./model";
import { createReviewService } from "./service";
import { createFilterPresetService } from "../filter-presets/service";

const snapshot = {
  phase: "ready", enabled: false, installed: false, using_proxy: false,
  downloaded_bytes: 150_300_000, expected_bytes: 150_300_000, message: "",
  requested_models: ["ccip"],
  models: { sscd: { installed: false }, dino: { installed: false }, ccip: { installed: true } },
  review_filters: {
    filter_monochrome: { available: false, reason: "missing" },
    filter_character: { available: true, reason: "" },
    filter_sketch: { available: false, reason: "deferred" },
  },
};

describe("selective model setup", () => {
  it("accepts real filtering status without claiming base models are ready", () => {
    const setup = sanitizeModelSetup(snapshot);
    expect(setup.requestedModels).toEqual(["ccip"]);
    expect(setup.reviewFilters?.filter_character.available).toBe(true);
    expect(baseModelsReady(setup)).toBe(false);
    expect(baseModelsReady(sanitizeModelSetup({ ...snapshot, installed: true, enabled: true,
      models: { sscd: { installed: true }, dino: { installed: true } } }))).toBe(true);
  });

  it("rejects unknown phases, invalid capabilities and invalid model selections", () => {
    for (const value of [
      { ...snapshot, phase: "unknown" }, { ...snapshot, requested_models: [] },
      { ...snapshot, requested_models: ["sscd"] },
      { ...snapshot, review_filters: { ...snapshot.review_filters, filter_character: { available: "true", reason: "" } } },
    ]) expect(() => sanitizeModelSetup(value)).toThrow();
  });

  it("shares installation, proxy validation and abort signals with Review", async () => {
    const post = vi.fn().mockResolvedValue(snapshot);
    const get = vi.fn().mockResolvedValue(snapshot);
    const api = { post, get } as unknown as ApiClient;
    const service = createReviewService(api);
    const signal = new AbortController().signal;
    await service.installModels(" http://127.0.0.1:7890 ", signal, ["ccip"]);
    expect(post).toHaveBeenCalledWith("/api/v1/setup/models/install", { proxy_url: "http://127.0.0.1:7890", models: ["ccip"] }, { signal });
    for (const models of [[], ["sketch"], ["sscd"]]) await expect(service.installModels("", signal, models as never)).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect(await createFilterPresetService(api).readModelSetup(signal)).toMatchObject({ reviewFilters: snapshot.review_filters });
    get.mockResolvedValue({ ...snapshot, review_filters: undefined });
    await expect(createFilterPresetService(api).readModelSetup(signal)).rejects.toThrow("invalid_filter_capabilities");
  });
});
