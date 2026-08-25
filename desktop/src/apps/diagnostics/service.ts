import type { ApiClient } from "../../core/api/client";
import type { DiagnosticsOutcome } from "./model";

export const DIAGNOSTICS_ENDPOINTS = Object.freeze({
  health: "/healthz",
  readiness: "/readyz",
  config: "/api/v1/config?view=diagnostics",
  scheduler: "/api/v1/scheduler/status?view=diagnostics",
} as const);

export interface DiagnosticsReadout {
  readonly health: DiagnosticsOutcome;
  readonly readiness: DiagnosticsOutcome;
  readonly config: DiagnosticsOutcome;
  readonly scheduler: DiagnosticsOutcome;
}

export interface DiagnosticsService {
  readAll(signal: AbortSignal): Promise<DiagnosticsReadout>;
}

function field(error: unknown, key: string): unknown {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && field(error, "name") === "AbortError") return true;
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Object.hasOwn(descriptor, "value")) result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function safeError(error: unknown): Readonly<{ status: number; code: string; requestId: string }> {
  const status = field(error, "status");
  const code = field(error, "code");
  const requestId = field(error, "requestId");
  return Object.freeze({
    status: typeof status === "number" && Number.isInteger(status) ? status : 0,
    code: typeof code === "string" ? code : "request_failed",
    requestId: typeof requestId === "string" ? requestId : "",
  });
}

async function readOutcome(api: ApiClient, path: string, signal: AbortSignal): Promise<DiagnosticsOutcome> {
  try {
    return Object.freeze({ connected: true, data: await api.get(path, { signal }), error: null });
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw error;
    const status = field(error, "status");
    const details = safeRecord(field(error, "details"));
    return Object.freeze({
      connected: typeof status === "number" && status > 0,
      data: null,
      response: status === 0 || (typeof status === "number" && status >= 500) ? details : null,
      error: safeError(error),
    });
  }
}

export function createDiagnosticsService(api: ApiClient): DiagnosticsService {
  const service: DiagnosticsService = {
    async readAll(signal) {
      const [health, readiness, config, scheduler] = await Promise.all([
        readOutcome(api, DIAGNOSTICS_ENDPOINTS.health, signal),
        readOutcome(api, DIAGNOSTICS_ENDPOINTS.readiness, signal),
        readOutcome(api, DIAGNOSTICS_ENDPOINTS.config, signal),
        readOutcome(api, DIAGNOSTICS_ENDPOINTS.scheduler, signal),
      ]);
      return Object.freeze({ health, readiness, config, scheduler });
    },
  };
  return Object.freeze(service);
}
