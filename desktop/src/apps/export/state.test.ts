import { describe, expect, it, vi } from "vitest";

import { createExportStore } from "./state";

describe("export preview store", () => {
  it("owns one immutable unavailable projection without invented progress", () => {
    const store = createExportStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState()).toEqual({ phase: "unavailable" });
    expect(store.commit({ phase: "unavailable" })).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    expect(() => store.commit({ phase: "unavailable", job: "fake" })).toThrow(TypeError);

    unsubscribe();
    store.destroy();
    expect(store.commit({ phase: "unavailable" })).toBe(false);
    expect(store.subscribe(listener)).toEqual(expect.any(Function));
  });
});
