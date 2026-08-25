import { describe, expect, it } from "vitest";

import { createExportController } from "./controller";
import { createExportStore } from "./state";

describe("export preview controller", () => {
  it("has an idempotent request-free lifecycle", () => {
    const store = createExportStore();
    const controller = createExportController(store);
    expect(controller.activate()).toBe(true);
    expect(controller.activate()).toBe(false);
    controller.deactivate();
    expect(controller.activate()).toBe(true);
    controller.destroy();
    controller.destroy();
    expect(controller.activate()).toBe(false);
  });
});
