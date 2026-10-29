import { describe, expect, it } from "vitest";

import type { ReadinessComponent } from "#lib/api/queries/system.ts";

import { domainOf, groupComponents, overallStatus } from "./diagnostics.ts";

const component = (id: string, status: ReadinessComponent["status"] = "ok", required = true): ReadinessComponent => ({
  id,
  status,
  required,
  summary: "",
});

describe("diagnostics domain", () => {
  it("按领域分组，已知组件按固定顺序，新组件归到 other", () => {
    const groups = groupComponents([
      component("torch"),
      component("zeta_new"),
      component("database"),
      component("alpha_new"),
      component("process"),
      component("mihomo"),
      component("scheduler"),
    ]);
    expect(groups.map((group) => [group.domain, group.components.map((item) => item.id)])).toEqual([
      ["service", ["process", "database"]],
      ["network", ["mihomo"]],
      ["tasks", ["scheduler"]],
      ["dedup", ["torch"]],
      ["other", ["alpha_new", "zeta_new"]],
    ]);
    expect(groupComponents([])).toEqual([]);
    expect(domainOf("toString")).toBe("other");
  });

  it("必需组件异常才算整体异常，其余问题只算提示", () => {
    expect(overallStatus([component("a"), component("b", "disabled", false)])).toBe("ok");
    expect(overallStatus([component("a", "error", false), component("b", "warning")])).toBe("warning");
    expect(overallStatus([component("a", "warning"), component("b", "error")])).toBe("error");
    expect(overallStatus([])).toBe("ok");
  });
});
