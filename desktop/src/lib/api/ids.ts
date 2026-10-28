// 请求 ID 和幂等键都是不透明标识，不含任何业务数据。

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const PREFIX = /^[a-z][a-z0-9_-]{0,23}$/i;

export interface IdentifierSources {
  readonly cryptoObject?: Pick<Crypto, "randomUUID"> | null;
  readonly now?: () => number;
  readonly random?: () => number;
}

function opaqueIdentifier(
  prefix: string,
  { cryptoObject = globalThis.crypto, now = Date.now, random = Math.random }: IdentifierSources = {},
): string {
  if (!PREFIX.test(prefix)) throw new TypeError("invalid_identifier_prefix");
  try {
    if (typeof cryptoObject?.randomUUID === "function") return `${prefix}-${cryptoObject.randomUUID()}`;
  } catch {
    // 平台随机源不可用时退回本地不透明标识。
  }
  const timestamp = Math.max(0, Number(now()) || 0).toString(36);
  const entropy = Math.floor(Math.max(0, Math.min(0.999999999999, Number(random()) || 0)) * 0x1_0000_0000)
    .toString(36)
    .padStart(7, "0");
  return `${prefix}-${timestamp}-${entropy}`;
}

export function createRequestId(sources?: IdentifierSources): string {
  return opaqueIdentifier("desktop", sources);
}

/**
 * 一次逻辑操作生成一个幂等键，重试时复用同一个键。
 * 在 mutationFn 外面生成（例如点击时），不要在每次请求里重新生成。
 */
export function createIdempotencyKey(prefix = "desktop", sources?: IdentifierSources): string {
  return opaqueIdentifier(prefix, sources);
}

/** 合法返回去掉首尾空白的 ID，否则返回空串。 */
export function normalizeRequestId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return REQUEST_ID.test(normalized) ? normalized : "";
}

export function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("invalid_idempotency_key");
  const normalized = value.trim();
  if (!IDEMPOTENCY_KEY.test(normalized)) throw new TypeError("invalid_idempotency_key");
  return normalized;
}
