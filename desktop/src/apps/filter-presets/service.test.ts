import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../core/api/client";
import { EMPTY_FILTER_OPTIONS } from "./model";
import { createFilterPresetService } from "./service";

const preset = { id: "custom/1", name: "Example", builtin: false, options: EMPTY_FILTER_OPTIONS };
const capabilities = {
  filter_monochrome: { available: false, reason: "monochrome unavailable" },
  filter_sketch: { available: false, reason: "sketch unavailable" },
  filter_character: { available: false, reason: "character unavailable" },
};
function fixture() {
  const get = vi.fn().mockResolvedValue({ items: [preset] });
  const post = vi.fn().mockResolvedValue(preset);
  const request = vi.fn().mockResolvedValue(preset);
  const remove = vi.fn().mockResolvedValue(null);
  const api = { get, post, request, delete: remove } as unknown as ApiClient;
  return { service: createFilterPresetService(api), get, post, request, remove };
}

describe("filter preset service", () => {
  it("lists with abort signals, and uses the existing POST / PUT request / DELETE contracts", async () => {
    const { service, get, post, request, remove } = fixture();
    const signal = new AbortController().signal;
    expect(await service.list(signal)).toEqual([preset]);
    expect(get).toHaveBeenCalledWith("/api/v1/gallery/review-presets", { signal });
    expect(await service.create(" Example ", EMPTY_FILTER_OPTIONS)).toEqual(preset);
    expect(post).toHaveBeenCalledWith("/api/v1/gallery/review-presets", { name: "Example", options: EMPTY_FILTER_OPTIONS });
    await service.update("custom/1", "Example", EMPTY_FILTER_OPTIONS);
    expect(request).toHaveBeenCalledWith("/api/v1/gallery/review-presets/custom%2F1", "PUT", { body: { name: "Example", options: EMPTY_FILTER_OPTIONS } });
    await service.remove("custom/1");
    expect(remove).toHaveBeenCalledWith("/api/v1/gallery/review-presets/custom%2F1");
  });

  it("validates writes before issuing requests", async () => {
    const { service, post, request } = fixture();
    await expect(service.create(" ", EMPTY_FILTER_OPTIONS)).rejects.toThrow();
    await expect(service.update("", "Example", EMPTY_FILTER_OPTIONS)).rejects.toThrow();
    await expect(service.create("Example", { ...EMPTY_FILTER_OPTIONS, filter_character: "true" } as never)).rejects.toThrow();
    expect(post).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it("strictly rejects malformed lists, duplicate ids, invalid mutation responses and nonempty deletion responses", async () => {
    const { service, get, request, post, remove } = fixture();
    for (const raw of [{}, { items: [preset, preset] }, { items: [preset], extra: true }, { items: [{ ...preset, builtin: 1 }] }]) {
      get.mockResolvedValueOnce(raw);
      await expect(service.list()).rejects.toThrow();
    }
    request.mockResolvedValueOnce({ ...preset, id: "wrong" });
    await expect(service.update(preset.id, preset.name, preset.options)).rejects.toThrow();
    post.mockResolvedValueOnce({ ...preset, builtin: true });
    await expect(service.create(preset.name, preset.options)).rejects.toThrow();
    remove.mockResolvedValueOnce({ ok: true });
    await expect(service.remove(preset.id)).rejects.toThrow();
  });

  it("requires complete filtering capability responses; never infers readiness from SSCD/DINO", async () => {
    const { service, get } = fixture();
    const signal = new AbortController().signal;
    get.mockResolvedValueOnce({ installed: true, models: { sscd: { installed: true } }, review_filters: capabilities });
    expect(await service.capabilities(signal)).toEqual(capabilities);
    expect(get).toHaveBeenLastCalledWith("/api/v1/setup/models", { signal });
    for (const raw of [{ installed: true }, { review_filters: null }, { review_filters: { filter_sketch: { available: true, reason: "" } } }]) {
      get.mockResolvedValueOnce(raw);
      await expect(service.capabilities()).rejects.toThrow();
    }
  });
});
