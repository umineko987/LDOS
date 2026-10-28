import { describe, expect, it } from "vitest";

import { setApi, useApi } from "./context.ts";

describe("api context", () => {
  it("导出一对 get/set", () => {
    expect(typeof useApi).toBe("function");
    expect(typeof setApi).toBe("function");
  });
});
