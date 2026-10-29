import { describe, expect, it } from "vitest";

import { parentPath, sectionOf, stageOf } from "./routes.ts";

describe("nav routes", () => {
  it("把路由归到侧栏分区", () => {
    expect(sectionOf("/")).toBe("datasets");
    expect(sectionOf("/datasets/[id]/tag")).toBe("datasets");
    expect(sectionOf("/library")).toBe("library");
    expect(sectionOf("/library/[sourceId]/[[directoryId]]")).toBe("library");
    expect(sectionOf("/jobs/crawls/[batchId]")).toBe("jobs");
    expect(sectionOf("/settings/diagnostics")).toBe("settings");
    expect(sectionOf("/dev/gfx")).toBe("dev");
    expect(sectionOf("/libraryx")).toBeNull();
    expect(sectionOf(null)).toBeNull();
  });

  it("识别数据集阶段", () => {
    expect(stageOf("/datasets/[id]/atlas")).toBe("atlas");
    expect(stageOf("/datasets/[id]/unknown")).toBeNull();
    expect(stageOf("/jobs")).toBeNull();
    expect(stageOf(null)).toBeNull();
  });

  it("算出上一级", () => {
    expect(parentPath("/datasets/[id]/review", { id: "d1" })).toBe("/");
    expect(parentPath("/library/[sourceId]/[[directoryId]]", { sourceId: "s 1", directoryId: "7" })).toBe(
      "/library/s%201",
    );
    expect(parentPath("/library/[sourceId]/[[directoryId]]", { sourceId: "s1" })).toBe("/library");
    expect(parentPath("/jobs/crawls/[batchId]", { batchId: "b1" })).toBe("/jobs");
    expect(parentPath(null, {})).toBe("/");
    for (const top of ["/", "/library", "/jobs", "/settings/network", "/dev/gfx"]) {
      expect(parentPath(top, {})).toBeNull();
    }
  });
});
