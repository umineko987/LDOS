import { describe, expect, it } from "vitest";
import { emptyScope, isStablePrefix, parsePageRange, projectScope, selectLoadedScope, toggleScopeItem, type CollectionScope } from "./workbench-selection.ts";

const entry = (id: string, collectable = true) => ({ id, collectable });
const page = (number: number) => ({ ...entry(`page-${number}`), page: number });
const items = [entry("newest"), entry("unavailable", false), entry("anchor"), entry("oldest")];

describe("workbench collection scope", () => {
  it("excludes the newer-than boundary by default and includes it only when requested", () => {
    const scope: CollectionScope = { kind: "newer", boundary: "anchor", includeBoundary: false, excluded: new Set() };
    expect(projectScope(items, scope).ids).toEqual(["newest"]);
    expect(projectScope(items, { ...scope, includeBoundary: true }).ids).toEqual(["newest", "anchor"]);
  });

  it("uses both inclusive interval endpoints in source order and supports individual omissions", () => {
    const scope: CollectionScope = { kind: "interval", start: "oldest", end: "newest", excluded: new Set() };
    const projection = projectScope(items, scope);
    expect(projection.ids).toEqual(["newest", "anchor", "oldest"]);
    expect(projectScope(items, toggleScopeItem(scope, items[2], projection.eligible)).ids).toEqual(["newest", "oldest"]);
    expect(projectScope(items, { ...scope, end: null })).toMatchObject({ ready: false, ids: [] });
  });

  it("never shrinks a requested page range to loaded pages or accepts a gap", () => {
    const scope: CollectionScope = { kind: "pages", start: 2, end: 4, excluded: new Set(["page-3"]) };
    expect(projectScope([page(1), page(2), page(4)], scope)).toMatchObject({ ready: false, ids: [] });
    expect(projectScope([page(1), page(2), page(3), page(4), page(5)], scope)).toMatchObject({ ready: true, ids: ["page-2", "page-4"] });
    expect(parsePageRange("2", "4")).toEqual({ start: 2, end: 4 });
    expect(parsePageRange("4", "2")).toBeNull();
    expect(parsePageRange("1", "2.5")).toBeNull();
  });

  it("keeps Select loaded and individually selected IDs fixed after more results arrive", () => {
    const first = items.slice(0, 3);
    expect(projectScope(items, selectLoadedScope(first)).ids).toEqual(["newest", "anchor"]);
    const single = toggleScopeItem(emptyScope(), items[2], new Set());
    expect(projectScope(items, single).ids).toEqual(["anchor"]);
  });

  it("verifies complete ordered prefixes, rejecting shorter, reordered or prepended results", () => {
    expect(isStablePrefix(items.slice(0, 2), items)).toBe(true);
    expect(isStablePrefix(items, items.slice(0, 2))).toBe(false);
    expect(isStablePrefix(items.slice(0, 2), [items[1], items[0], ...items.slice(2)])).toBe(false);
    expect(isStablePrefix(items, [entry("inserted"), ...items])).toBe(false);
  });
});
