import {
  normalizePersonalizationPreferences,
  projectPersonalizationPreferences,
} from "./personalization-model.js";
import { ownDataValue, parseStorageObject } from "./storage-snapshot.js";

const LEGACY_ANIMATION_MODES = new Map([
  ["system", "on"],
  ["reduced", "off"],
]);

export function sanitizeUiPreferences(value) {
  const personalization = normalizePersonalizationPreferences(value);
  const legacyAnimation = LEGACY_ANIMATION_MODES.get(ownDataValue(value, "animations"));
  return Object.freeze({
    ...personalization,
    ...(legacyAnimation ? { animations: legacyAnimation } : {}),
  });
}

export function projectUiPreferences(value) {
  return { ...projectPersonalizationPreferences(value) };
}

export function deserializeUiPreferences(serialized) {
  return sanitizeUiPreferences(parseStorageObject(serialized));
}

export function serializeUiPreferences(preferences) {
  return JSON.stringify(projectUiPreferences(preferences));
}

export function serializePersonalizationPreferences(preferences, _storedSerialized) {
  return JSON.stringify(projectPersonalizationPreferences(preferences));
}
