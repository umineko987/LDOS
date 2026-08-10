import {
  normalizePersonalizationPreferences,
  PERSONALIZATION_PREFERENCE_KEYS,
  projectPersonalizationPreferences,
} from "./personalization-model.js";
import { ownDataValue, parseStorageObject } from "./storage-snapshot.js";

const LEGACY_ANIMATION_MODES = new Map([
  ["system", "on"],
  ["reduced", "off"],
]);
const TASKBAR_DENSITIES = new Set(["comfortable", "compact"]);
const UI_PREFERENCE_KEYS = new Set([
  ...PERSONALIZATION_PREFERENCE_KEYS,
  "taskbarDensity",
]);

export function sanitizeUiPreferences(value) {
  const personalization = normalizePersonalizationPreferences(value);
  const legacyAnimation = LEGACY_ANIMATION_MODES.get(ownDataValue(value, "animations"));
  const result = {
    ...personalization,
    ...(legacyAnimation ? { animations: legacyAnimation } : {}),
  };
  const taskbarDensity = ownDataValue(value, "taskbarDensity");
  if (TASKBAR_DENSITIES.has(taskbarDensity)) result.taskbarDensity = taskbarDensity;
  return Object.freeze(result);
}

function strictUiPreferenceDescriptors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("UI 偏好必须是普通对象");
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TypeError("UI 偏好必须是普通对象");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("UI 偏好必须是普通对象");
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError("UI 偏好必须是普通对象");
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !UI_PREFERENCE_KEYS.has(key)) {
      throw new TypeError("UI 偏好包含未知字段");
    }
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value;
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError("UI 偏好字段必须是数据值");
    }
  }
  return descriptors;
}

export function projectUiPreferences(value) {
  const descriptors = strictUiPreferenceDescriptors(value);
  const personalizationInput = {};
  for (const key of PERSONALIZATION_PREFERENCE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value;
    if (descriptor) personalizationInput[key] = descriptor.value;
  }
  const result = { ...projectPersonalizationPreferences(personalizationInput) };
  const taskbarDescriptor = Object.getOwnPropertyDescriptor(
    descriptors,
    "taskbarDensity",
  )?.value;
  if (taskbarDescriptor) {
    if (!TASKBAR_DENSITIES.has(taskbarDescriptor.value)) {
      throw new TypeError("UI 偏好 taskbarDensity 无效");
    }
    result.taskbarDensity = taskbarDescriptor.value;
  }
  return result;
}

export function deserializeUiPreferences(serialized) {
  return sanitizeUiPreferences(parseStorageObject(serialized));
}

export function serializeUiPreferences(preferences) {
  return JSON.stringify(projectUiPreferences(preferences));
}

export function serializePersonalizationPreferences(preferences, storedSerialized) {
  const projected = { ...projectPersonalizationPreferences(preferences) };
  const stored = deserializeUiPreferences(storedSerialized);
  if (TASKBAR_DENSITIES.has(stored.taskbarDensity)) {
    projected.taskbarDensity = stored.taskbarDensity;
  }
  return JSON.stringify(projected);
}
