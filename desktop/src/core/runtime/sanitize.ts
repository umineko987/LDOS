const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_DETAIL_KEY = /(?:authorization|cookie|credential|password|secret|token|traceback|stack|exception|(?:^|_)path(?:$|_))/i;
const STATUS_MESSAGES = Object.freeze({
  backend_config_invalid: "后端配置无效",
  backend_exited: "后端进程意外退出",
  backend_start_failed: "后端进程无法启动",
  backend_start_timeout: "等待后端启动超时",
  backend_stopped: "后端服务已停止",
  platform_unavailable: "桌面宿主暂时不可用",
});

export class RuntimeContractError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "RuntimeContractError";
  }
}

export interface RuntimeMetadata {
  readonly apiOrigin: string;
  readonly backendVersion: string | null;
}

export type BackendState = "starting" | "ready" | "failed" | "stopped";

export interface BackendStatus {
  readonly state: BackendState;
  readonly code: string | null;
  readonly message: string;
}

export interface HealthSnapshot {
  readonly ok: boolean;
  readonly components: Readonly<{
    process: Readonly<{ status: "ok" | "error" }>;
    database: Readonly<{ status: "ok" | "error" }>;
  }>;
  readonly time: number;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new RuntimeContractError(`invalid_${key}`);
  }
  return descriptor.value;
}

function optionalOwnValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new RuntimeContractError(`invalid_${key}`);
  return descriptor.value;
}

function loopbackOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) {
    throw new RuntimeContractError("invalid_api_origin");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeContractError("invalid_api_origin");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new RuntimeContractError("invalid_api_origin");
  }
  return url.origin;
}

function backendVersion(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value)) {
    throw new RuntimeContractError("invalid_backend_version");
  }
  return value;
}

export function sanitizeRuntimeMetadata(value: unknown): RuntimeMetadata {
  if (!isPlainRecord(value)) throw new RuntimeContractError("invalid_runtime_metadata");
  return Object.freeze({
    apiOrigin: loopbackOrigin(ownValue(value, "apiOrigin")),
    backendVersion: backendVersion(optionalOwnValue(value, "backendVersion")),
  });
}

export function sanitizeBackendStatus(value: unknown): BackendStatus {
  if (!isPlainRecord(value)) throw new RuntimeContractError("invalid_backend_status");
  const rawState = ownValue(value, "state");
  if (!(["starting", "ready", "failed", "stopped"] as const).includes(rawState as BackendState)) {
    throw new RuntimeContractError("invalid_backend_state");
  }
  const state = rawState as BackendState;
  const rawCode = optionalOwnValue(value, "code");
  const code = typeof rawCode === "string" && Object.hasOwn(STATUS_MESSAGES, rawCode)
    ? rawCode as keyof typeof STATUS_MESSAGES
    : null;
  const message = code ? STATUS_MESSAGES[code] : state === "starting"
    ? "正在启动本地服务"
    : state === "ready"
      ? "本地服务已就绪"
      : state === "stopped"
        ? STATUS_MESSAGES.backend_stopped
        : "桌面宿主发生错误";
  return Object.freeze({ state, code, message });
}

function componentStatus(value: unknown, name: string): Readonly<{ status: "ok" | "error" }> {
  if (!isPlainRecord(value)) throw new RuntimeContractError(`invalid_health_${name}`);
  const status = ownValue(value, "status");
  if (status !== "ok" && status !== "error") {
    throw new RuntimeContractError(`invalid_health_${name}`);
  }
  return Object.freeze({ status });
}

export function sanitizeHealthSnapshot(value: unknown): HealthSnapshot {
  if (!isPlainRecord(value)) throw new RuntimeContractError("invalid_health");
  const ok = ownValue(value, "ok");
  const components = ownValue(value, "components");
  const time = ownValue(value, "time");
  if (typeof ok !== "boolean" || !isPlainRecord(components) || typeof time !== "number" || !Number.isFinite(time)) {
    throw new RuntimeContractError("invalid_health");
  }
  return Object.freeze({
    ok,
    components: Object.freeze({
      process: componentStatus(ownValue(components, "process"), "process"),
      database: componentStatus(ownValue(components, "database"), "database"),
    }),
    time,
  });
}

export function sanitizeErrorDetails(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 500);
  if (depth >= 4) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeErrorDetails(item, depth + 1));
  }
  if (!isPlainRecord(value)) return null;

  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).slice(0, 32)) {
    if (BLOCKED_KEYS.has(key) || SENSITIVE_DETAIL_KEY.test(key) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    result[key] = sanitizeErrorDetails(descriptor.value, depth + 1);
  }
  return result;
}
