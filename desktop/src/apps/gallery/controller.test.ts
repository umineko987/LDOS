import { describe, expect, it } from "vitest";

import { createGalleryController } from "./controller";
import { createGalleryStore } from "./state";

describe("gallery preview controller", () => {
  it("allows local preview controls only while active", () => {
    const store = createGalleryStore();
    const controller = createGalleryController(store);
    expect(controller.setQuery("before")).toBe(false);
    controller.activate();
    expect(controller.selectCollection("favorites")).toBe(true);
    expect(controller.setQuery("portrait")).toBe(true);
    expect(controller.setSort("site")).toBe(true);
    expect(controller.setMode("list")).toBe(true);
    expect(controller.toggleInspector()).toBe(true);
    controller.deactivate();
    expect(controller.setQuery("after")).toBe(false);
    expect(store.getState().query).toBe("portrait");

    controller.activate();
    controller.destroy();
    controller.destroy();
    controller.activate();
    expect(controller.selectCollection("sources")).toBe(false);
  });
});
