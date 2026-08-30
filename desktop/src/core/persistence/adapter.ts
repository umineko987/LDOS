export const PERSISTENCE_KEYS = Object.freeze({
  currentApp: "ldos.ui:current-app",
  activeBatch: "ldos.ui:active-batch",
  windowLayout: "ldos.window-layout.v1",
  windowPlacements: "ldos.window-placements.v2",
  uiPreferences: "ldos.ui:ui-preferences",
} as const);

export type PersistenceKey = typeof PERSISTENCE_KEYS[keyof typeof PERSISTENCE_KEYS];

const SESSION_KEYS = new Set<PersistenceKey>([
  PERSISTENCE_KEYS.currentApp,
  PERSISTENCE_KEYS.activeBatch,
]);
const LOCAL_KEYS = new Set<PersistenceKey>([
  PERSISTENCE_KEYS.windowLayout,
  PERSISTENCE_KEYS.windowPlacements,
  PERSISTENCE_KEYS.uiPreferences,
]);

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistenceAdapter {
  readSession(key: PersistenceKey): string | null;
  writeSession(key: PersistenceKey, value: string): boolean;
  removeSession(key: PersistenceKey): boolean;
  readLocal(key: PersistenceKey): string | null;
  writeLocal(key: PersistenceKey, value: string): boolean;
  removeLocal(key: PersistenceKey): boolean;
}

function browserStorage(name: "localStorage" | "sessionStorage"): StorageLike | null {
  try {
    return globalThis[name] ?? null;
  } catch {
    return null;
  }
}

function scopedKey(keys: ReadonlySet<PersistenceKey>, key: PersistenceKey): PersistenceKey {
  if (!keys.has(key)) throw new TypeError("persistence_scope_mismatch");
  return key;
}

function safeRead(storage: StorageLike | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeWrite(storage: StorageLike | null, key: string, value: string): boolean {
  try {
    storage?.setItem(key, value);
    return storage !== null;
  } catch {
    return false;
  }
}

function safeRemove(storage: StorageLike | null, key: string): boolean {
  try {
    storage?.removeItem(key);
    return storage !== null;
  } catch {
    return false;
  }
}

export function createPersistenceAdapter({
  localStorage = browserStorage("localStorage"),
  sessionStorage = browserStorage("sessionStorage"),
}: {
  readonly localStorage?: StorageLike | null;
  readonly sessionStorage?: StorageLike | null;
} = {}): PersistenceAdapter {
  return Object.freeze({
    readSession: (key) => safeRead(sessionStorage, scopedKey(SESSION_KEYS, key)),
    writeSession: (key, value) => safeWrite(sessionStorage, scopedKey(SESSION_KEYS, key), value),
    removeSession: (key) => safeRemove(sessionStorage, scopedKey(SESSION_KEYS, key)),
    readLocal: (key) => safeRead(localStorage, scopedKey(LOCAL_KEYS, key)),
    writeLocal: (key, value) => safeWrite(localStorage, scopedKey(LOCAL_KEYS, key), value),
    removeLocal: (key) => safeRemove(localStorage, scopedKey(LOCAL_KEYS, key)),
  } satisfies PersistenceAdapter);
}
