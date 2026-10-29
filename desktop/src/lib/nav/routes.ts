// 信息架构：侧栏分区、数据集阶段和“上一级”的规则。路由 ID 与 src/routes 的目录一一对应。

export const STAGES = ["collect", "clean", "dedup", "tag", "review", "export", "atlas"] as const;

export type Stage = (typeof STAGES)[number];

export type Section = "datasets" | "library" | "jobs" | "settings" | "dev";

export const SETTINGS_PAGES = ["network", "models", "preferences", "diagnostics"] as const;

export type SettingsPage = (typeof SETTINGS_PAGES)[number];

type Params = Readonly<Record<string, string | undefined>>;

/** 当前路由属于侧栏的哪一项；未知路由（404）返回 null。 */
export function sectionOf(routeId: string | null): Section | null {
  if (routeId === null) return null;
  if (routeId === "/" || routeId.startsWith("/datasets/")) return "datasets";
  for (const section of ["library", "jobs", "settings", "dev"] as const) {
    if (routeId === `/${section}` || routeId.startsWith(`/${section}/`)) return section;
  }
  return null;
}

export function stageOf(routeId: string | null): Stage | null {
  const match = /^\/datasets\/\[id\]\/([a-z]+)$/.exec(routeId ?? "");
  return match && (STAGES as readonly string[]).includes(match[1]!) ? (match[1] as Stage) : null;
}

const segment = (value: string | undefined) => encodeURIComponent(value ?? "");

/**
 * Esc 链最后一步“回到上一级”的目标路径（不带 `#`）。
 * 顶层分区（数据集首页、图库、任务、设置）没有上一级，返回 null，让 Esc 不被消费。
 */
export function parentPath(routeId: string | null, params: Params): string | null {
  switch (routeId) {
    case null:
      return "/";
    case "/library/[sourceId]/[[directoryId]]":
      return params.directoryId ? `/library/${segment(params.sourceId)}` : "/library";
    case "/jobs/crawls/[batchId]":
      return "/jobs";
  }
  if (stageOf(routeId)) return "/";
  return null;
}
