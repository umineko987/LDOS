import { describe, expect, it } from "vitest";

import {
  createPersistenceAdapter,
  PERSISTENCE_KEYS,
  type PersistenceKey,
  type StorageLike,
} from "./adapter";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  fail: "get" | "set" | "remove" | null = null;

  getItem(key: string): string | null {
    if (this.fail === "get") throw new Error("blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.fail === "set") throw new Error("blocked");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.fail === "remove") throw new Error("blocked");
    this.values.delete(key);
  }
}

describe("the one persistence adapter", () => {
  it("keeps the five legacy keys in their exact session/local scopes", () => {
    expect(PERSISTENCE_KEYS).toEqual({
      currentApp: "ldos.ui:current-app",
      activeBatch: "ldos.ui:active-batch",
      windowLayout: "ldos.window-layout.v1",
      windowPlacements: "ldos.window-placements.v2",
      uiPreferences: "ldos.ui:ui-preferences",
    });
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const adapter = createPersistenceAdapter({ localStorage: local, sessionStorage: session });

    expect(adapter.writeSession(PERSISTENCE_KEYS.currentApp, "crawl")).toBe(true);
    expect(adapter.writeSession(PERSISTENCE_KEYS.activeBatch, "batch:1")).toBe(true);
    expect(adapter.writeLocal(PERSISTENCE_KEYS.windowPlacements, "{}")) .toBe(true);
    expect(adapter.writeLocal(PERSISTENCE_KEYS.windowLayout, "{}")) .toBe(true);
    expect(adapter.writeLocal(PERSISTENCE_KEYS.uiPreferences, "{}")) .toBe(true);
    expect(adapter.readSession(PERSISTENCE_KEYS.currentApp)).toBe("crawl");
    expect(adapter.readLocal(PERSISTENCE_KEYS.windowPlacements)).toBe("{}");
    expect(adapter.removeSession(PERSISTENCE_KEYS.currentApp)).toBe(true);
    expect(adapter.removeLocal(PERSISTENCE_KEYS.windowPlacements)).toBe(true);

    expect(() => adapter.readSession(PERSISTENCE_KEYS.uiPreferences)).toThrow("persistence_scope_mismatch");
    expect(() => adapter.readLocal(PERSISTENCE_KEYS.currentApp)).toThrow("persistence_scope_mismatch");
    expect(() => adapter.writeSession("unknown" as PersistenceKey, "x")).toThrow("persistence_scope_mismatch");
  });

  it("fails safely when Web Storage is absent or rejects access", () => {
    const missing = createPersistenceAdapter({ localStorage: null, sessionStorage: null });
    expect(missing.readLocal(PERSISTENCE_KEYS.uiPreferences)).toBeNull();
    expect(missing.writeLocal(PERSISTENCE_KEYS.uiPreferences, "{}")).toBe(false);
    expect(missing.removeLocal(PERSISTENCE_KEYS.uiPreferences)).toBe(false);
    expect(missing.readSession(PERSISTENCE_KEYS.currentApp)).toBeNull();
    expect(missing.writeSession(PERSISTENCE_KEYS.currentApp, "crawl")).toBe(false);
    expect(missing.removeSession(PERSISTENCE_KEYS.currentApp)).toBe(false);

    const storage = new MemoryStorage();
    const adapter = createPersistenceAdapter({ localStorage: storage, sessionStorage: storage });
    storage.fail = "get";
    expect(adapter.readLocal(PERSISTENCE_KEYS.windowLayout)).toBeNull();
    storage.fail = "set";
    expect(adapter.writeSession(PERSISTENCE_KEYS.activeBatch, "batch:1")).toBe(false);
    storage.fail = "remove";
    expect(adapter.removeLocal(PERSISTENCE_KEYS.windowLayout)).toBe(false);
  });

  it("uses stable WebView storage without coupling keys to the API origin", () => {
    const descriptors = ["localStorage", "sessionStorage"].map((name) => (
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
    ));
    for (const [name] of descriptors) {
      Object.defineProperty(globalThis, name, { configurable: true, get: () => { throw new Error("denied"); } });
    }
    try {
      const denied = createPersistenceAdapter();
      expect(denied.readLocal(PERSISTENCE_KEYS.uiPreferences)).toBeNull();
      expect(denied.readSession(PERSISTENCE_KEYS.currentApp)).toBeNull();

      for (const [name] of descriptors) {
        Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
      }
      expect(createPersistenceAdapter().readLocal(PERSISTENCE_KEYS.uiPreferences)).toBeNull();

      const availableStorage = new MemoryStorage();
      for (const [name] of descriptors) {
        Object.defineProperty(globalThis, name, { configurable: true, value: availableStorage });
      }
      const available = createPersistenceAdapter();
      expect(available.writeLocal(PERSISTENCE_KEYS.uiPreferences, "{}")).toBe(true);
      expect(available.readLocal(PERSISTENCE_KEYS.uiPreferences)).toBe("{}");
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }

    expect(Object.values(PERSISTENCE_KEYS).some((key) => key.includes("8787"))).toBe(false);
  });
});
