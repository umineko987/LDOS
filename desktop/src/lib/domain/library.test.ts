import { describe, expect, it } from "vitest";

import { crumbs, libraryPath, scanJobId, SOURCE_DOT, sourceState, stemOf, stemProblem } from "./library.ts";

describe("library domain", () => {
  it("扫描中的来源一律显示扫描中", () => {
    expect(sourceState("offline", true)).toBe("scanning");
    expect(sourceState("offline", false)).toBe("offline");
    expect(SOURCE_DOT[sourceState("available", false)]).toBe("ok");
    expect(SOURCE_DOT.error).toBe("error");
    expect(scanJobId("s1")).toBe("scan:s1");
  });

  it("根目录不写目录段，其余目录转义", () => {
    expect(libraryPath("s 1")).toBe("/library/s%201");
    expect(libraryPath("s1", "root", "root")).toBe("/library/s1");
    expect(libraryPath("s1", "d/2", "root")).toBe("/library/s1/d%2F2");
    expect(libraryPath("s1", null, "root")).toBe("/library/s1");
  });

  it("面包屑的根目录显示来源名", () => {
    const chain = [
      { directory_id: "root", name: "pictures", parent_id: null },
      { directory_id: "d1", name: "a", parent_id: "root" },
      { directory_id: "d2", name: "b", parent_id: "d1" },
    ];
    expect(crumbs("s1", "我的图", chain)).toEqual([
      { directoryId: "root", label: "我的图", path: "/library/s1" },
      { directoryId: "d1", label: "a", path: "/library/s1/d1" },
      { directoryId: "d2", label: "b", path: "/library/s1/d2" },
    ]);
    expect(crumbs("s1", "", chain.slice(0, 1))[0]!.label).toBe("pictures");
    // 链断了（上级取不到）时没有根，全部按目录显示。
    expect(crumbs("s1", "我的图", chain.slice(1)).map((crumb) => crumb.path)).toEqual(["/library/s1/d1", "/library/s1/d2"]);
  });

  it("主名去掉扩展名", () => {
    expect(stemOf("a.b.PNG", ".png")).toBe("a.b");
    expect(stemOf("noext", "")).toBe("noext");
    expect(stemOf(".png", ".png")).toBe(".png");
    expect(stemOf("a.jpg", ".png")).toBe("a.jpg");
  });

  it("改名校验和后端一致", () => {
    expect(stemProblem("  ", "a", ".png")).toBe("empty");
    expect(stemProblem(" a ", "a", ".png")).toBe("unchanged");
    expect(stemProblem("x".repeat(256), "a", ".png")).toBe("too_long");
    for (const bad of ["a/b", "a\\b", "a:b", "a?", "..", ".", "a.", "a\u0001"]) {
      expect(stemProblem(bad, "a", ".png"), bad).toBe("invalid");
    }
    expect(stemProblem("b.PNG", "a", ".png")).toBe("extension");
    expect(stemProblem("b.png", "a", "")).toBeNull();
    expect(stemProblem("新名字", "a", ".png")).toBeNull();
  });
});
