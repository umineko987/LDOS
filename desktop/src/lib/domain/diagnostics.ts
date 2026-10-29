// 设置 › 诊断：把 /readyz 的组件按领域分组并排序。组件 ID 与 gdl_backend/diagnostics.py 一致。

import type { ComponentStatus, ReadinessComponent } from "#lib/api/queries/system.ts";

export const DIAGNOSTICS_POLL_MS = 20_000;

export const DIAGNOSTIC_DOMAINS = ["service", "network", "tasks", "dedup", "other"] as const;

export type DiagnosticDomain = (typeof DIAGNOSTIC_DOMAINS)[number];

/** 已知组件的显示顺序和所属领域；后端新增的组件归到 other，按 ID 排序。 */
export const KNOWN_COMPONENTS: Readonly<Record<string, DiagnosticDomain>> = Object.freeze({
  process: "service",
  database: "service",
  gallery_source: "service",
  project_proxy: "network",
  mihomo: "network",
  scheduler: "tasks",
  ordered_crawls: "tasks",
  dedup: "dedup",
  dedup_python: "dedup",
  torch: "dedup",
  sscd_model: "dedup",
  dino_model: "dedup",
});

const ORDER = Object.keys(KNOWN_COMPONENTS);

export interface DiagnosticGroup {
  readonly domain: DiagnosticDomain;
  readonly components: readonly ReadinessComponent[];
}

export function domainOf(id: string): DiagnosticDomain {
  return Object.hasOwn(KNOWN_COMPONENTS, id) ? KNOWN_COMPONENTS[id]! : "other";
}

function rank(id: string): number {
  const index = ORDER.indexOf(id);
  return index === -1 ? ORDER.length : index;
}

export function groupComponents(components: readonly ReadinessComponent[]): DiagnosticGroup[] {
  const sorted = [...components].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return DIAGNOSTIC_DOMAINS.map((domain) => ({
    domain,
    components: sorted.filter((component) => domainOf(component.id) === domain),
  })).filter((group) => group.components.length > 0);
}

/** 必需组件里最差的状态决定整体结论；可选组件出问题只算提示。 */
export function overallStatus(components: readonly ReadinessComponent[]): ComponentStatus {
  let result: ComponentStatus = "ok";
  for (const component of components) {
    if (component.status === "ok" || component.status === "disabled") continue;
    if (component.required && component.status === "error") return "error";
    result = "warning";
  }
  return result;
}
