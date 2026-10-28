// 宿主（Tauri）返回值的消毒，从旧版 core/runtime/sanitize.ts 移植。
// 宿主可能附带配置路径之类的私有字段，这里只取白名单字段，文案由界面按语言给出。

import { isPlainRecord } from "#lib/api/sanitize.ts";

export class RuntimeContractError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "RuntimeContractError";
  }
}

export interface RuntimeMetadata {
  /** 已校验的本机回环 origin。 */
  readonly apiOrigin: string;
  readonly backendVersion: string | null;
}

export type BackendState = "starting" | "ready" | "failed" | "stopped";

export const BACKEND_STATUS_CODES = [
  "backend_config_invalid",
  "backend_exited",
  "backend_start_failed",
  "backend_start_timeout",
  "backend_stopped",
  "platform_unavailable",
] as const;

export type BackendStatusCode = (typeof BACKEND_STATUS_CODES)[number];

export interface BackendStatus {
  readonly state: BackendState;
  /** 已知的失败原因；宿主给了未知代码时为 null。 */
  readonly code: BackendStatusCode | null;
}

const BACKEND_STATES: readonly BackendState[] = ["starting", "ready", "failed", "stopped"];
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
const BACKEND_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

function requiredValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) throw new RuntimeContractError(`invalid_${key}`);
  return descriptor.value;
}

function optionalValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new RuntimeContractError(`invalid_${key}`);
  return descriptor.value;
}

export function loopbackOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) throw new RuntimeContractError("invalid_api_origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeContractError("invalid_api_origin");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.includes(hostname) ||
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
  if (typeof value !== "string" || !BACKEND_VERSION.test(value)) {
    throw new RuntimeContractError("invalid_backend_version");
  }
  return value;
}

export function sanitizeRuntimeMetadata(value: unknown): RuntimeMetadata {
  if (!isPlainRecord(value)) throw new RuntimeContractError("invalid_runtime_metadata");
  return Object.freeze({
    apiOrigin: loopbackOrigin(requiredValue(value, "apiOrigin")),
    backendVersion: backendVersion(optionalValue(value, "backendVersion")),
  });
}

export function sanitizeBackendStatus(value: unknown): BackendStatus {
  if (!isPlainRecord(value)) throw new RuntimeContractError("invalid_backend_status");
  const state = requiredValue(value, "state");
  if (!BACKEND_STATES.includes(state as BackendState)) throw new RuntimeContractError("invalid_backend_state");
  const code = optionalValue(value, "code");
  return Object.freeze({
    state: state as BackendState,
    code: BACKEND_STATUS_CODES.includes(code as BackendStatusCode) ? (code as BackendStatusCode) : null,
  });
}

/** 宿主给的本机路径只做最小检查：非空、无控制字符。 */
export function hostPath(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f]/.test(value)) return null;
  return value;
}
