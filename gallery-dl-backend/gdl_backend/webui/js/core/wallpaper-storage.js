export const WALLPAPER_STORAGE_SCHEMA = Object.freeze({
  databaseName: "imageweave-ui",
  storeName: "wallpapers",
  customKey: "custom",
});

function browserIndexedDb() {
  try {
    return globalThis.indexedDB;
  } catch {
    return null;
  }
}

function closeConnection(database) {
  try {
    database?.close?.();
  } catch {
    // Compatibility cleanup is best-effort, including connection release.
  }
}

/**
 * Delete only the one legacy custom-wallpaper record. The seam never reads a
 * record, creates a store, upgrades a schema, iterates keys, or deletes the DB.
 * Every environment/storage failure resolves false so desktop startup continues.
 */
export async function cleanupLegacyCustomWallpaper({
  indexedDB = browserIndexedDb(),
} = {}) {
  if (!indexedDB || typeof indexedDB.open !== "function") return false;

  let openRequest;
  try {
    openRequest = indexedDB.open(WALLPAPER_STORAGE_SCHEMA.databaseName);
  } catch {
    return false;
  }
  if (!openRequest || typeof openRequest !== "object") return false;

  return new Promise((resolve) => {
    let connection = null;
    let settled = false;

    const finish = (result) => {
      closeConnection(connection);
      connection = null;
      if (settled) return;
      settled = true;
      resolve(result === true);
    };

    openRequest.onblocked = () => finish(false);
    openRequest.onerror = () => finish(false);
    openRequest.onsuccess = () => {
      let database;
      try {
        database = openRequest.result;
      } catch {
        finish(false);
        return;
      }
      if (settled) {
        closeConnection(database);
        return;
      }
      connection = database;

      try {
        if (!database.objectStoreNames?.contains?.(WALLPAPER_STORAGE_SCHEMA.storeName)) {
          finish(true);
          return;
        }
        const transaction = database.transaction(
          WALLPAPER_STORAGE_SCHEMA.storeName,
          "readwrite",
        );
        const store = transaction.objectStore(WALLPAPER_STORAGE_SCHEMA.storeName);
        const deleteRequest = store.delete(WALLPAPER_STORAGE_SCHEMA.customKey);
        deleteRequest.onerror = () => finish(false);
        transaction.oncomplete = () => finish(true);
        transaction.onerror = () => finish(false);
        transaction.onabort = () => finish(false);
      } catch {
        finish(false);
      }
    };
  });
}
