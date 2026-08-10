import { STORAGE_KEYS } from "./storage-contract.js";
import {
  normalizeViewport,
  restoreWindowLayout,
  serializeWindowLayout,
} from "./storage-layout.js";
import { createStoragePersistenceAdapter } from "./storage-persistence.js";
import {
  deserializeUiPreferences,
  serializePersonalizationPreferences,
  serializeUiPreferences,
} from "./storage-preferences.js";
import {
  projectApplicationId,
  projectBatchId,
  readApplicationIdSnapshot,
  readBatchIdSnapshot,
} from "./storage-snapshot.js";

const PERSISTENCE_METHODS = Object.freeze([
  "readSession",
  "writeSession",
  "removeSession",
  "readLocal",
  "writeLocal",
]);

function requirePersistenceAdapter(persistence) {
  if (
    !persistence
    || PERSISTENCE_METHODS.some((method) => typeof persistence[method] !== "function")
  ) {
    throw new TypeError("storage service 需要显式持久化适配器");
  }
  return persistence;
}

export function createStorageServiceFromAdapter(persistenceAdapter) {
  const persistence = requirePersistenceAdapter(persistenceAdapter);
  return Object.freeze({
    readCurrentApp() {
      const stored = persistence.readSession(STORAGE_KEYS.currentApp);
      if (stored === null) return null;
      const appId = readApplicationIdSnapshot(stored);
      if (appId !== null) return appId;
      persistence.removeSession(STORAGE_KEYS.currentApp);
      return null;
    },
    writeCurrentApp(appId) {
      return persistence.writeSession(
        STORAGE_KEYS.currentApp,
        projectApplicationId(appId),
      );
    },
    readActiveBatchId() {
      const stored = persistence.readSession(STORAGE_KEYS.activeBatch);
      if (stored === null) return null;
      const batchId = readBatchIdSnapshot(stored);
      if (batchId !== null) return batchId;
      persistence.removeSession(STORAGE_KEYS.activeBatch);
      return null;
    },
    writeActiveBatchId(batchId) {
      return persistence.writeSession(STORAGE_KEYS.activeBatch, projectBatchId(batchId));
    },
    clearActiveBatchId() {
      return persistence.removeSession(STORAGE_KEYS.activeBatch);
    },
    readWindowLayout(viewport = undefined, geometryOptions = {}) {
      const normalizedViewport = normalizeViewport(viewport);
      const serialized = persistence.readLocal(STORAGE_KEYS.windowLayout);
      const windows = restoreWindowLayout(serialized, normalizedViewport, geometryOptions);
      if (serialized !== null) {
        const repaired = serializeWindowLayout(windows);
        if (serialized !== repaired) {
          persistence.writeLocal(STORAGE_KEYS.windowLayout, repaired);
        }
      }
      return windows;
    },
    writeWindowLayout(windows) {
      return persistence.writeLocal(
        STORAGE_KEYS.windowLayout,
        serializeWindowLayout(windows),
      );
    },
    readUiPreferences() {
      const serialized = persistence.readLocal(STORAGE_KEYS.uiPreferences);
      const preferences = deserializeUiPreferences(serialized);
      if (serialized !== null) {
        const migrated = JSON.stringify(preferences);
        if (serialized !== migrated) {
          persistence.writeLocal(STORAGE_KEYS.uiPreferences, migrated);
        }
      }
      return preferences;
    },
    writeUiPreferences(preferences) {
      return persistence.writeLocal(
        STORAGE_KEYS.uiPreferences,
        serializeUiPreferences(preferences),
      );
    },
    writePersonalizationPreferences(preferences) {
      const stored = persistence.readLocal(STORAGE_KEYS.uiPreferences);
      return persistence.writeLocal(
        STORAGE_KEYS.uiPreferences,
        serializePersonalizationPreferences(preferences, stored),
      );
    },
  });
}

export function createStorageService(options = {}) {
  return createStorageServiceFromAdapter(createStoragePersistenceAdapter(options));
}
