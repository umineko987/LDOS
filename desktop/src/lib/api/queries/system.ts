// 系统查询：/healthz、/readyz、/api/v1/config?view=diagnostics。
// 这三个接口在 OpenAPI 里没有响应模型，返回值先经下面的消毒函数再进缓存。

import { queryOptions } from "@tanstack/svelte-query";

import { data, type Api } from "../client.ts";
import { isApiError } from "../errors.ts";
import { boundedCount, isPlainRecord, ownRecord, ownValue } from "../sanitize.ts";

export const systemKeys = {
  all: ["system"] as const,
  health: () => [...systemKeys.all, "health"] as const,
  readiness: () => [...systemKeys.all, "readiness"] as const,
  config: () => [...systemKeys.all, "config", "diagnostics"] as const,
};

export type ComponentStatus = "ok" | "error" | "disabled" | "warning";

export interface Health {
  readonly ok: boolean;
  readonly database: "ok" | "error";
  readonly time: number | null;
}

export interface ReadinessComponent {
  readonly id: string;
  readonly status: ComponentStatus;
  readonly required: boolean;
  /** 后端给的一句话说明（目前只有中文），已压缩空白并截断。 */
  readonly summary: string;
}

export interface Readiness {
  readonly ready: boolean;
  readonly time: number | null;
  readonly components: readonly ReadinessComponent[];
}

export interface DiagnosticsConfig {
  readonly loopbackOnly: boolean;
  readonly corsEnabled: boolean;
  readonly privateTargetsEnabled: boolean;
  readonly proxyEnabled: boolean;
  readonly proxyAutoStart: boolean;
  readonly transportCoreEnabled: boolean;
  readonly schedulerCapacity: number;
  readonly dedupEnabled: boolean;
  readonly dedupDevice: "auto" | "cpu" | "cuda" | "unknown";
  readonly sscdEnabled: boolean;
  readonly dinoEnabled: boolean;
}

const COMPONENT_ID = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_COMPONENTS = 64;

export class ContractError extends TypeError {
  constructor(code: string) {
    super(code);
    this.name = "ContractError";
  }
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function componentStatus(value: unknown): ComponentStatus {
  if (value === "ok" || value === "error" || value === "disabled") return value;
  // optional_missing、optional_warning 以及以后新增的状态都按提示处理。
  return typeof value === "string" && /^[a-z_]{1,32}$/.test(value) ? "warning" : "error";
}

function summary(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

export function sanitizeHealth(value: unknown): Health {
  if (!isPlainRecord(value) || typeof ownValue(value, "ok") !== "boolean") throw new ContractError("invalid_health");
  const database = ownValue(ownRecord(ownRecord(value, "components"), "database"), "status");
  return Object.freeze({
    ok: ownValue(value, "ok") as boolean,
    database: database === "ok" ? "ok" : "error",
    time: timestamp(ownValue(value, "time")),
  });
}

export function sanitizeReadiness(value: unknown): Readiness {
  if (!isPlainRecord(value) || typeof ownValue(value, "ready") !== "boolean") {
    throw new ContractError("invalid_readiness");
  }
  const raw = ownRecord(value, "components");
  const components: ReadinessComponent[] = [];
  for (const id of raw ? Object.keys(raw).slice(0, MAX_COMPONENTS) : []) {
    const item = ownRecord(raw, id);
    if (!COMPONENT_ID.test(id) || !item) continue;
    components.push(
      Object.freeze({
        id,
        status: componentStatus(ownValue(item, "status")),
        required: ownValue(item, "required") !== false,
        summary: summary(ownValue(item, "summary")),
      }),
    );
  }
  return Object.freeze({
    ready: ownValue(value, "ready") as boolean,
    time: timestamp(ownValue(value, "time")),
    components: Object.freeze(components),
  });
}

function flag(record: Record<string, unknown> | null, key: string): boolean {
  return ownValue(record, key) === true;
}

export function sanitizeDiagnosticsConfig(value: unknown): DiagnosticsConfig {
  if (!isPlainRecord(value) || ownValue(value, "response_profile") !== "diagnostics") {
    throw new ContractError("invalid_diagnostics_config");
  }
  const server = ownRecord(value, "server");
  const proxy = ownRecord(value, "proxy");
  const scheduler = ownRecord(value, "scheduler");
  const dedup = ownRecord(value, "dedup");
  const device = ownValue(dedup, "configured_device");
  return Object.freeze({
    loopbackOnly: flag(server, "loopback_only"),
    corsEnabled: flag(server, "cors_enabled"),
    privateTargetsEnabled: flag(server, "private_targets_enabled"),
    proxyEnabled: flag(proxy, "enabled"),
    proxyAutoStart: flag(proxy, "auto_start"),
    transportCoreEnabled: flag(proxy, "transport_core_enabled"),
    schedulerCapacity: boundedCount(ownValue(scheduler, "max_concurrent_tasks"), 100_000),
    dedupEnabled: flag(dedup, "enabled"),
    dedupDevice: device === "auto" || device === "cpu" || device === "cuda" ? device : "unknown",
    sscdEnabled: flag(dedup, "sscd_enabled"),
    dinoEnabled: flag(dedup, "dino_enabled"),
  });
}

export function healthQuery(api: Api) {
  return queryOptions({
    queryKey: systemKeys.health(),
    queryFn: async ({ signal }) => sanitizeHealth(await data(api.client.GET("/healthz", { signal }))),
  });
}

/** 未就绪时后端返回 503 和同样结构的正文，这里把它当作正常数据而不是失败。 */
export function readinessQuery(api: Api) {
  return queryOptions({
    queryKey: systemKeys.readiness(),
    queryFn: async ({ signal }) => {
      try {
        return sanitizeReadiness(await data(api.client.GET("/readyz", { signal })));
      } catch (error) {
        if (isApiError(error) && error.status === 503 && error.code === "http_error") {
          return sanitizeReadiness(error.payload);
        }
        throw error;
      }
    },
  });
}

export function diagnosticsConfigQuery(api: Api) {
  return queryOptions({
    queryKey: systemKeys.config(),
    queryFn: async ({ signal }) =>
      sanitizeDiagnosticsConfig(
        await data(api.client.GET("/api/v1/config", { params: { query: { view: "diagnostics" } }, signal })),
      ),
  });
}
