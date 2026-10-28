import { normalizeRequestId } from "./ids.ts";
import { boundedString, isPlainRecord, ownValue, sanitizeErrorDetails } from "./sanitize.ts";

/** 客户端自己产生的错误码；后端错误码原样透传。 */
export type ClientErrorCode =
  | "http_error"
  | "invalid_response"
  | "network_error"
  | "request_failed"
  | "response_read_failed"
  | "response_too_large";

export interface ApiErrorInit {
  readonly status?: number;
  readonly code: string;
  readonly message?: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly payload?: unknown;
}

/**
 * 所有 API 失败都归一成 ApiError。
 *
 * - `code`：后端信封里的 `error.code`，或 {@link ClientErrorCode}。
 * - `message`：后端给的说明；客户端错误只有错误码，界面文案由 `apiErrorMessage()` 按语言给出。
 * - `details`：信封里的 `error.details`，已去掉敏感字段。
 * - `payload`：没有错误信封的非 2xx 响应体（例如 503 的 /readyz），供需要它的查询自行消毒。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string;
  readonly payload: unknown;

  constructor({ status = 0, code, message, details = null, requestId = "", payload = null }: ApiErrorInit) {
    const normalizedCode = boundedString(code, "request_failed", 128);
    super(boundedString(message, normalizedCode));
    this.name = "ApiError";
    this.status = Number.isInteger(status) ? status : 0;
    this.code = normalizedCode;
    this.details = sanitizeErrorDetails(details);
    this.requestId = normalizeRequestId(requestId);
    this.payload = payload;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 后端错误信封 `{ "error": { code, message, details, request_id } }`。 */
export function backendErrorEnvelope(payload: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(payload)) return null;
  const error = ownValue(payload, "error");
  return isPlainRecord(error) ? error : null;
}

export function apiErrorFromPayload(status: number, payload: unknown, responseRequestId: string): ApiError {
  const envelope = backendErrorEnvelope(payload);
  if (envelope) {
    return new ApiError({
      status,
      code: boundedString(ownValue(envelope, "code"), "backend_error", 128),
      message: boundedString(ownValue(envelope, "message"), "backend_error"),
      details: ownValue(envelope, "details"),
      requestId: normalizeRequestId(ownValue(envelope, "request_id")) || responseRequestId,
    });
  }
  return new ApiError({ status, code: "http_error", requestId: responseRequestId, payload });
}
