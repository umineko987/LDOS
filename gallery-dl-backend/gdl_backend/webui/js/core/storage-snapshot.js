import { getApplicationDefinitionById } from "./app-definitions.js";

const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseStorageObject(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function ownDataValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function hasExactDataKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(descriptors[key], "value"));
  } catch {
    return false;
  }
}

export function isValidBatchId(value) {
  return typeof value === "string" && BATCH_ID_PATTERN.test(value);
}

export function readApplicationIdSnapshot(value) {
  return typeof value === "string"
    && value.length <= 32
    && getApplicationDefinitionById(value)
    ? value
    : null;
}

export function projectApplicationId(appId) {
  if (typeof appId !== "string" || !getApplicationDefinitionById(appId)) {
    throw new TypeError("应用 ID 无效");
  }
  return appId;
}

export function readBatchIdSnapshot(value) {
  return isValidBatchId(value) ? value : null;
}

export function projectBatchId(batchId) {
  if (!isValidBatchId(batchId)) throw new TypeError("批次 ID 格式无效");
  return batchId;
}
