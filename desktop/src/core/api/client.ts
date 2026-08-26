import {
  isPlainRecord,
  sanitizeErrorDetails,
  sanitizeRuntimeMetadata,
  type RuntimeMetadata,
} from "../runtime/sanitize";

const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
const MAX_RESPONSE_CHARS = 65_536;

type HttpMethod = typeof METHODS[number];
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ApiRequestOptions {
  readonly body?: unknown;
  readonly headers?: HeadersInit;
  readonly idempotencyKey?: boolean | string;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  request(path: string, method: HttpMethod, options?: ApiRequestOptions): Promise<unknown>;
  get(path: string, options?: Omit<ApiRequestOptions, "body">): Promise<unknown>;
  post(path: string, body?: unknown, options?: Omit<ApiRequestOptions, "body">): Promise<unknown>;
  put(path: string, body?: unknown, options?: Omit<ApiRequestOptions, "body">): Promise<unknown>;
  delete(path: string, options?: Omit<ApiRequestOptions, "body">): Promise<unknown>;
  resourceUrl(path: string): string;
  createIdempotencyKey(prefix?: string): string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string;

  constructor({ status = 0, code, message, details = null, requestId = "" }: {
    status?: number;
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  }) {
    super(message);
    this.name = "ApiError";
    this.status = Number.isInteger(status) ? status : 0;
    this.code = boundedString(code, "request_failed", 128);
    this.details = sanitizeErrorDetails(details);
    this.requestId = normalizeRequestId(requestId);
  }
}

function boundedString(value: unknown, fallback: string, maximum = 500): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

function normalizeRequestId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : "";
}

function opaqueIdentifier(prefix: string, {
  cryptoObject = globalThis.crypto,
  now = Date.now,
  random = Math.random,
}: {
  cryptoObject?: Pick<Crypto, "randomUUID"> | null;
  now?: () => number;
  random?: () => number;
} = {}): string {
  if (!/^[a-z][a-z0-9_-]{0,23}$/i.test(prefix)) throw new TypeError("invalid_identifier_prefix");
  try {
    if (typeof cryptoObject?.randomUUID === "function") return `${prefix}-${cryptoObject.randomUUID()}`;
  } catch {
    // Fall through to an opaque local identifier when the platform random source is unavailable.
  }
  const timestamp = Math.max(0, Number(now()) || 0).toString(36);
  const entropy = Math.floor(Math.max(0, Math.min(0.999999999999, Number(random()) || 0)) * 0x1_0000_0000)
    .toString(36)
    .padStart(7, "0");
  return `${prefix}-${timestamp}-${entropy}`;
}

export function createRequestId(options?: Parameters<typeof opaqueIdentifier>[1]): string {
  return opaqueIdentifier("desktop", options);
}

export function createIdempotencyKey(
  prefix = "desktop",
  options?: Parameters<typeof opaqueIdentifier>[1],
): string {
  return opaqueIdentifier(prefix, options);
}

function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("invalid_idempotency_key");
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) throw new TypeError("invalid_idempotency_key");
  return normalized;
}

export function buildRequestOptions(method: HttpMethod, options: ApiRequestOptions = {}): RequestInit {
  if (!METHODS.includes(method)) throw new TypeError("unsupported_http_method");
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("invalid_request_options");
  }
  const headers = new Headers(options.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  const suppliedRequestId = headers.get("X-Request-ID") ?? options.requestId;
  const requestId = suppliedRequestId === undefined ? createRequestId() : normalizeRequestId(suppliedRequestId);
  if (!requestId) throw new TypeError("invalid_request_id");
  headers.set("X-Request-ID", requestId);

  const hasBody = Object.hasOwn(options, "body") && options.body !== undefined;
  if (hasBody && method === "GET") throw new TypeError("get_body_not_allowed");

  let body: string | undefined;
  if (hasBody) {
    try {
      body = JSON.stringify(options.body);
    } catch {
      throw new ApiError({ code: "invalid_request_body", message: "请求体无法序列化为 JSON" });
    }
    if (body === undefined) {
      throw new ApiError({ code: "invalid_request_body", message: "请求体无法序列化为 JSON" });
    }
    headers.set("Content-Type", "application/json");
  } else {
    headers.delete("Content-Type");
  }

  if (options.idempotencyKey) {
    const key = options.idempotencyKey === true
      ? createIdempotencyKey()
      : normalizeIdempotencyKey(options.idempotencyKey);
    if (!headers.has("Idempotency-Key")) headers.set("Idempotency-Key", key);
  }

  return {
    method,
    cache: "no-store",
    headers,
    ...(body === undefined ? {} : { body }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function apiUrl(origin: string, path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
    throw new TypeError("invalid_api_path");
  }
  const url = new URL(path, `${origin}/`);
  if (url.origin !== origin) throw new TypeError("invalid_api_path");
  return url.href;
}

function parseResponseText(text: string): { kind: "empty" | "invalid" | "json" | "too_large"; value: unknown } {
  if (!text.trim()) return { kind: "empty", value: null };
  if (text.length > MAX_RESPONSE_CHARS) return { kind: "too_large", value: null };
  try {
    return { kind: "json", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid", value: null };
  }
}

function backendError(payload: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(payload)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(payload, "error");
  return descriptor && "value" in descriptor && isPlainRecord(descriptor.value)
    ? descriptor.value
    : null;
}

function errorValue(error: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function normalizedApiError(status: number, payload: unknown, responseRequestId: string): ApiError {
  const error = backendError(payload);
  if (error) {
    return new ApiError({
      status,
      code: boundedString(errorValue(error, "code"), "backend_error", 128),
      message: boundedString(errorValue(error, "message"), "服务拒绝了该请求"),
      details: errorValue(error, "details"),
      requestId: normalizeRequestId(errorValue(error, "request_id")) || responseRequestId,
    });
  }
  return new ApiError({
    status,
    code: "http_error",
    message: status ? `请求失败（HTTP ${status}）` : "请求失败",
    details: null,
    requestId: responseRequestId,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function createApiClient(
  runtime: RuntimeMetadata,
  { fetchImpl = globalThis.fetch.bind(globalThis) }: { fetchImpl?: FetchImplementation } = {},
): ApiClient {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch_unavailable");
  const origin = sanitizeRuntimeMetadata(runtime).apiOrigin;

  const request = async (path: string, method: HttpMethod, options: ApiRequestOptions = {}): Promise<unknown> => {
    const init = buildRequestOptions(method, options);
    const url = apiUrl(origin, path);
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiError({ code: "network_error", message: "无法连接到 ImageWeave 服务" });
    }

    const responseRequestId = normalizeRequestId(response.headers.get("X-Request-ID"));
    let parsed: ReturnType<typeof parseResponseText>;
    try {
      parsed = response.status === 204
        ? { kind: "empty", value: null }
        : parseResponseText(await response.text());
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiError({
        status: response.status,
        code: "network_error",
        message: "读取服务响应失败",
        requestId: responseRequestId,
      });
    }

    if (!response.ok) throw normalizedApiError(response.status, parsed.value, responseRequestId);
    if (parsed.kind === "too_large") {
      throw new ApiError({
        status: response.status,
        code: "response_too_large",
        message: "服务响应超出安全大小限制",
        requestId: responseRequestId,
      });
    }
    if (parsed.kind === "invalid") {
      throw new ApiError({
        status: response.status,
        code: "invalid_response",
        message: "服务返回的数据格式无效",
        requestId: responseRequestId,
      });
    }
    if (backendError(parsed.value)) throw normalizedApiError(response.status, parsed.value, responseRequestId);
    return parsed.value;
  };

  const client: ApiClient = {
    request,
    get: (path, options = {}) => request(path, "GET", options),
    post: (path, body, options = {}) => request(path, "POST", { ...options, ...(body === undefined ? {} : { body }) }),
    put: (path, body, options = {}) => request(path, "PUT", { ...options, ...(body === undefined ? {} : { body }) }),
    delete: (path, options = {}) => request(path, "DELETE", options),
    resourceUrl: (path) => apiUrl(origin, path),
    createIdempotencyKey,
  };
  return Object.freeze(client);
}
