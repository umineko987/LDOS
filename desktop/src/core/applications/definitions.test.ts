import { describe, expect, it } from "vitest";

import {
  APPLICATION_DEFINITIONS,
  APPLICATION_GROUPS,
  APPLICATION_IDS,
  getApplicationDefinition,
  getApplicationDefinitionByRoute,
} from "./definitions";

const expected = [
  ["crawl", "/crawl", "图片采集", "download", "workflow", 0, "ready", 0, "normal"],
  ["tasks", "/tasks", "批次管理", "list", "workflow", 1, "ready", 1, "normal"],
  ["proxy", "/proxy", "代理管理", "network", "connections", 0, "ready", null, "normal"],
  ["vault", "/vault", "授权管理", "key", "connections", 1, "ready", null, "normal"],
  ["review", "/review", "去重审核", "images", "workflow", 3, "ready", 3, "maximized"],
  ["policy", "/policy", "站点设置", "sliders", "connections", 2, "ready", null, "normal"],
  ["diagnostics", "/diagnostics", "系统诊断", "activity", "system", 0, "ready", null, "normal"],
  ["personalization", "/personalization", "外观设置", "sliders", "system", 1, "ready", null, "normal"],
  ["filter-presets", "/filter-presets", "筛选预设", "sliders", "system", 2, "ready", null, "normal"],
  ["gallery", "/gallery", "图片库", "folder", "workflow", 2, "ready", 2, "normal"],
] as const;

describe("typed application definitions", () => {
  it("preserves the exact ten-application metadata and default window contract", () => {
    expect(APPLICATION_DEFINITIONS.map((definition) => [
      definition.id,
      definition.route,
      definition.title,
      definition.icon,
      definition.group,
      definition.order,
      definition.availability,
      definition.dockOrder,
      definition.defaultWindow.state,
    ])).toEqual(expected);
    expect(APPLICATION_IDS).toEqual(expected.map(([id]) => id));
    expect(APPLICATION_DEFINITIONS.map(({ defaultWindow }) => defaultWindow.rect)).toEqual(
      Array.from({ length: 10 }, () => ({ x: 160, y: 64, w: 800, h: 560 })),
    );
    expect(APPLICATION_DEFINITIONS.filter(({ availability }) => availability === "ready").map(({ id }) => id))
      .toEqual(["crawl", "tasks", "proxy", "vault", "review", "policy", "diagnostics", "personalization", "filter-presets", "gallery"]);
    expect(APPLICATION_DEFINITIONS.filter(({ availability }: { availability: string }) => availability === "preview")).toEqual([]);
  });

  it("keeps groups, IDs, routes, and group order unique and immutable", () => {
    expect(APPLICATION_GROUPS).toEqual([
      { id: "workflow", title: "工作流", order: 0 },
      { id: "connections", title: "连接与策略", order: 1 },
      { id: "system", title: "系统", order: 2 },
    ]);
    expect(new Set(APPLICATION_IDS).size).toBe(10);
    expect(new Set(APPLICATION_DEFINITIONS.map(({ route }) => route)).size).toBe(10);
    for (const group of APPLICATION_GROUPS) {
      const members = APPLICATION_DEFINITIONS.filter(({ group: id }) => id === group.id);
      expect(new Set(members.map(({ order }) => order)).size).toBe(members.length);
    }
    expect(Object.isFrozen(APPLICATION_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(APPLICATION_DEFINITIONS[0])).toBe(true);
    expect(Object.isFrozen(APPLICATION_DEFINITIONS[0].defaultWindow.rect)).toBe(true);
  });

  it("looks up only canonical IDs and routes", () => {
    expect(getApplicationDefinition("crawl")?.route).toBe("/crawl");
    expect(getApplicationDefinition("unknown")).toBeNull();
    expect(getApplicationDefinition(null)).toBeNull();
    expect(getApplicationDefinitionByRoute("/review")?.id).toBe("review");
    expect(getApplicationDefinitionByRoute("/unknown")).toBeNull();
    expect(getApplicationDefinitionByRoute(undefined)).toBeNull();
  });
});
