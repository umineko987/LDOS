import { describe, expect, it, vi } from "vitest";

import { createGalleryStore } from "./state";

describe("gallery preview store", () => {
  it("owns one immutable local preview projection", () => {
    const store = createGalleryStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(listener).toHaveBeenCalledOnce();
    listener.mockClear();

    expect(store.selectCollection("favorites")).toBe(true);
    expect(store.setQuery("portrait")).toBe(true);
    expect(store.setSort("site")).toBe(true);
    expect(store.setMode("list")).toBe(true);
    expect(store.toggleInspector()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(5);
    expect(store.getState()).toEqual({ phase: "unavailable", collection: "favorites", query: "portrait", sort: "site", mode: "list", inspectorOpen: false });
    expect(store.setMode("list")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(5);

    unsubscribe();
    store.destroy();
    expect(store.setQuery("ignored")).toBe(false);
    expect(store.subscribe(listener)).toEqual(expect.any(Function));
  });

  it("sanitizes commits before publishing", () => {
    const store = createGalleryStore();
    expect(() => store.commit({ phase: "content", collection: "library", query: "", sort: "newest", mode: "grid", inspectorOpen: true })).toThrow(TypeError);
    expect(store.commit({ phase: "unavailable", collection: "sources", query: "", sort: "oldest", mode: "grid", inspectorOpen: true })).toBe(true);
    expect(store.getState().collection).toBe("sources");
  });
});
