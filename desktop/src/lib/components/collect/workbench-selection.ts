export interface ScopeItem {
  id: string;
  page?: number | null;
  collectable: boolean;
}

export type CollectionScope =
  | { kind: "manual"; ids: ReadonlySet<string> }
  | { kind: "newer"; boundary: string; includeBoundary: boolean; excluded: ReadonlySet<string> }
  | { kind: "interval"; start: string | null; end: string | null; excluded: ReadonlySet<string> }
  | { kind: "pages"; start: number; end: number; excluded: ReadonlySet<string> };

export const emptyScope = (): CollectionScope => ({ kind: "manual", ids: new Set() });

export function isStablePrefix(previous: readonly Pick<ScopeItem, "id">[], incoming: readonly Pick<ScopeItem, "id">[]): boolean {
  return previous.length <= incoming.length && previous.every((item, index) => item.id === incoming[index].id);
}

export function parsePageRange(start: string, end: string): { start: number; end: number } | null {
  if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) return null;
  const first = Number(start);
  const last = Number(end);
  return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first > 0 && last >= first
    ? { start: first, end: last }
    : null;
}

export function projectScope(items: readonly ScopeItem[], scope: CollectionScope) {
  let base: readonly ScopeItem[];
  switch (scope.kind) {
    case "manual":
      base = items.filter(({ id }) => scope.ids.has(id));
      break;
    case "newer": {
      const boundary = items.findIndex(({ id }) => id === scope.boundary);
      if (boundary < 0) return { ready: false as const, eligible: new Set<string>(), ids: [] as string[] };
      base = items.slice(0, boundary + Number(scope.includeBoundary));
      break;
    }
    case "interval": {
      const start = items.findIndex(({ id }) => id === scope.start);
      const end = items.findIndex(({ id }) => id === scope.end);
      if (start < 0 || end < 0) return { ready: false as const, eligible: new Set<string>(), ids: [] as string[] };
      base = items.slice(Math.min(start, end), Math.max(start, end) + 1);
      break;
    }
    case "pages": {
      base = items.filter(({ page }) => page != null && page >= scope.start && page <= scope.end);
      const pages = new Set(base.map(({ page }) => page));
      if (pages.size !== scope.end - scope.start + 1) {
        return { ready: false as const, eligible: new Set<string>(), ids: [] as string[] };
      }
      break;
    }
  }
  const eligible = new Set(base.filter(({ collectable }) => collectable).map(({ id }) => id));
  return {
    ready: true as const,
    eligible,
    ids: [...eligible].filter((id) => scope.kind === "manual" || !scope.excluded.has(id)),
  };
}

function toggleId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function toggleScopeItem(scope: CollectionScope, item: ScopeItem, eligible: ReadonlySet<string>): CollectionScope {
  if (!item.collectable) return scope;
  if (scope.kind === "manual") return { ...scope, ids: toggleId(scope.ids, item.id) };
  return eligible.has(item.id) ? { ...scope, excluded: toggleId(scope.excluded, item.id) } : scope;
}

export function selectLoadedScope(items: readonly ScopeItem[]): CollectionScope {
  return { kind: "manual", ids: new Set(items.filter(({ collectable }) => collectable).map(({ id }) => id)) };
}
