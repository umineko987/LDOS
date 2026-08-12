import { STORAGE_KEYS } from "./storage-contract.js";

const SESSION_KEYS = new Set([STORAGE_KEYS.currentApp, STORAGE_KEYS.activeBatch]);
const LOCAL_KEYS = new Set([
  STORAGE_KEYS.windowLayout,
  STORAGE_KEYS.windowPlacements,
  STORAGE_KEYS.uiPreferences,
]);

function browserStorage(name) {
  try {
    return globalThis[name] || null;
  } catch {
    return null;
  }
}

function requireScopedKey(keys, key) {
  if (!keys.has(key)) throw new TypeError("存储键不属于请求的持久化作用域");
  return key;
}

function safeRead(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeWrite(storage, key, value) {
  try {
    storage?.setItem(key, value);
    return Boolean(storage);
  } catch {
    return false;
  }
}

function safeRemove(storage, key) {
  try {
    storage?.removeItem(key);
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function createStoragePersistenceAdapter({
  localStorage = browserStorage("localStorage"),
  sessionStorage = browserStorage("sessionStorage"),
} = {}) {
  return Object.freeze({
    readSession(key) {
      return safeRead(sessionStorage, requireScopedKey(SESSION_KEYS, key));
    },
    writeSession(key, value) {
      return safeWrite(sessionStorage, requireScopedKey(SESSION_KEYS, key), value);
    },
    removeSession(key) {
      return safeRemove(sessionStorage, requireScopedKey(SESSION_KEYS, key));
    },
    readLocal(key) {
      return safeRead(localStorage, requireScopedKey(LOCAL_KEYS, key));
    },
    writeLocal(key, value) {
      return safeWrite(localStorage, requireScopedKey(LOCAL_KEYS, key), value);
    },
    removeLocal(key) {
      return safeRemove(localStorage, requireScopedKey(LOCAL_KEYS, key));
    },
  });
}
