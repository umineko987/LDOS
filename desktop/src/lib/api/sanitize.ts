// 不信任的 JSON 只按自有数据属性读取，不触发 getter，不沿原型链取值。

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_DETAIL_KEY =
  /(?:authorization|cookie|credential|password|secret|token|traceback|stack|exception|(?:^|_)path(?:$|_))/i;
const SAFE_DETAIL_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 读取自有数据属性；访问器属性、继承属性和缺失的键都返回 undefined。 */
export function ownValue(record: Record<string, unknown> | null | undefined, key: string): unknown {
  if (!record) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function ownRecord(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = ownValue(record, key);
  return isPlainRecord(value) ? value : null;
}

export function boundedString(value: unknown, fallback: string, maximum = 500): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

export function boundedCount(value: unknown, maximum = 1_000_000_000): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

/** 错误详情只保留浅层、短小、键名安全的数据，去掉可能带秘密或主机路径的字段。 */
export function sanitizeErrorDetails(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, 500);
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeErrorDetails(item, depth + 1));
  if (!isPlainRecord(value)) return null;

  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).slice(0, 32)) {
    if (BLOCKED_KEYS.has(key) || SENSITIVE_DETAIL_KEY.test(key) || !SAFE_DETAIL_KEY.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    result[key] = sanitizeErrorDetails(descriptor.value, depth + 1);
  }
  return result;
}
