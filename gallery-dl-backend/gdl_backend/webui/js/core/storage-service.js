import { STORAGE_KEYS } from "./storage-contract.js";
import {
  deserializeWindowPlacements,
  migrateLegacyWindowLayout,
  normalizeViewport,
  placementsFromWindowStack,
  serializeWindowPlacements,
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
  const removeLocal = typeof persistence.removeLocal === "function"
    ? (key) => persistence.removeLocal(key)
    : () => false;
  let placementCache = null;

  const readWindowPlacements = (viewport = undefined, geometryOptions = {}) => {
    const normalizedViewport = normalizeViewport(viewport);
    const serialized = persistence.readLocal(STORAGE_KEYS.windowPlacements);
    let placements = deserializeWindowPlacements(
      serialized,
      normalizedViewport,
      geometryOptions,
    );

    if (serialized !== null) {
      if (placements === null) {
        removeLocal(STORAGE_KEYS.windowPlacements);
        placements = [];
      } else {
        const repaired = serializeWindowPlacements(placements);
        if (serialized !== repaired) {
          persistence.writeLocal(STORAGE_KEYS.windowPlacements, repaired);
        }
      }
      // A v2 value, valid or damaged, is authoritative. The legacy workspace is one-shot only.
      removeLocal(STORAGE_KEYS.windowLayout);
    } else {
      const legacy = persistence.readLocal(STORAGE_KEYS.windowLayout);
      placements = legacy === null
        ? []
        : migrateLegacyWindowLayout(legacy, normalizedViewport, geometryOptions) ?? [];
      if (legacy !== null) {
        if (placements.length > 0) {
          persistence.writeLocal(
            STORAGE_KEYS.windowPlacements,
            serializeWindowPlacements(placements),
          );
        }
        removeLocal(STORAGE_KEYS.windowLayout);
      }
    }
    placementCache = placements;
    return placements.map((placement) => ({
      ...placement,
      rect: { ...placement.rect },
    }));
  };

  const writeWindowPlacements = (placements) => {
    const serialized = serializeWindowPlacements(placements);
    const projected = JSON.parse(serialized).placements;
    const written = persistence.writeLocal(STORAGE_KEYS.windowPlacements, serialized);
    if (written) placementCache = projected;
    return written;
  };

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
    clearCurrentApp() {
      return persistence.removeSession(STORAGE_KEYS.currentApp);
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
    readWindowPlacements,
    readWindowPlacement(appId) {
      if (typeof appId !== "string") return null;
      const placements = placementCache ?? readWindowPlacements();
      const placement = placements.find((item) => item.appId === appId);
      return placement
        ? { rect: { ...placement.rect }, maximized: placement.maximized }
        : null;
    },
    writeWindowPlacements,
    writeWindowPlacementsFromStack(windows) {
      const previous = placementCache ?? readWindowPlacements();
      return writeWindowPlacements(placementsFromWindowStack(windows, previous));
    },
    // Compatibility names now expose placement preferences, never a restorable workspace.
    readWindowLayout(viewport = undefined, geometryOptions = {}) {
      return readWindowPlacements(viewport, geometryOptions);
    },
    writeWindowLayout(windows) {
      return this.writeWindowPlacementsFromStack(windows);
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
