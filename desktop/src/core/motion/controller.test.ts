import { describe, expect, it, vi } from "vitest";
import {
  createMotionController,
  MOTION_MEDIA_QUERY,
  type MotionController,
  type MotionState,
} from "../../core/motion/controller";
import type { PersistenceService, UiPreferences } from "../persistence/service";

const preferences: UiPreferences = { animations: "on", wallpaperColor: "graphite" };

type MediaEvent = { readonly matches: boolean };
type MediaMock = {
  matches: boolean;
  addEventListener?: (type: "change", listener: (event: MediaEvent) => void) => void;
  removeEventListener?: (type: "change", listener: (event: MediaEvent) => void) => void;
  addListener?: (listener: (event: MediaEvent) => void) => void;
  removeListener?: (listener: (event: MediaEvent) => void) => void;
};

function storage(overrides: Partial<PersistenceService> = {}): PersistenceService {
  return {
    readUiPreferences: () => preferences,
    writeUiPreferences: () => true,
    ...overrides,
  } as PersistenceService;
}

function root(setAttribute: (name: string, value: string) => void = () => {}): HTMLElement {
  return { setAttribute } as unknown as HTMLElement;
}

function motionState(overrides: Partial<MotionState> = {}): MotionState {
  return Object.freeze({
    userMode: "on",
    systemReduced: false,
    effective: true,
    limitedBySystem: false,
    ...overrides,
  });
}

function restoreGlobal(name: "document" | "matchMedia", previous: PropertyDescriptor | undefined): void {
  if (previous) Object.defineProperty(globalThis, name, previous);
  else delete (globalThis as Record<string, unknown>)[name];
}

describe("Motion controller", () => {
  it("projects mode, scene, storage writes, listeners, and modern media changes", () => {
    const events: { change?: (event: MediaEvent) => void } = {};
    const remove = vi.fn();
    const attributes = new Map<string, string>();
    const media: MediaMock = {
      matches: false,
      addEventListener: (_type, listener) => { events.change = listener; },
      removeEventListener: (_type, listener) => { remove(listener); },
    };
    const wallpaperClasses = new Set<string>();
    const wallpaper = {
      classList: { toggle: (name: string, enabled: boolean) => { if (enabled) wallpaperClasses.add(name); else wallpaperClasses.delete(name); } },
      setAttribute: (name: string, value: string) => attributes.set(`wallpaper:${name}`, value),
    };
    const desktop = { setAttribute: (name: string, value: string) => attributes.set(`desktop:${name}`, value) };
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { querySelector: (selector: string) => selector === "[data-wallpaper]" ? wallpaper : desktop },
    });
    try {
      const writes: UiPreferences[] = [];
      const controller = createMotionController({
        root: root((name, value) => attributes.set(`root:${name}`, value)),
        storage: storage({ writeUiPreferences: (value) => { writes.push(value); return true; } }),
        matchMedia: () => media,
      });
      const listener = vi.fn<(state: MotionState) => void>();
      const unsubscribe = controller.subscribe(listener);
      expect(controller.getState()).toMatchObject({ userMode: "on", effective: true, limitedBySystem: false });
      expect(controller.apply({ animations: "off", wallpaperColor: "forest" })).toMatchObject({ userMode: "off", effective: false });
      expect(wallpaperClasses).toEqual(new Set(["wallpaper--forest"]));
      expect(attributes.get("wallpaper:data-scene")).toBe("forest");
      expect(attributes.get("desktop:data-scene")).toBe("forest");
      expect(attributes.get("root:data-motion")).toBe("off");
      expect(controller.previewUserMode("on").userMode).toBe("on");
      expect(controller.setUserMode("off")).toBe(true);
      expect(writes).toEqual([{ animations: "off", wallpaperColor: "graphite" }]);
      events.change?.({ matches: true });
      expect(controller.getState()).toEqual(motionState({ userMode: "off", systemReduced: true, effective: false }));
      expect(listener).toHaveBeenCalled();
      unsubscribe();
      controller.destroy();
      expect(remove).toHaveBeenCalledTimes(1);
      events.change?.({ matches: false });
      expect(controller.getState().systemReduced).toBe(true);
      controller.destroy();
    } finally {
      restoreGlobal("document", previousDocument);
    }
  });

  it("supports the legacy media listener API and safely handles detached roots/listeners", () => {
    const events: { change?: (event: MediaEvent) => void } = {};
    const remove = vi.fn();
    const media: MediaMock = {
      matches: true,
      addListener: (listener) => { events.change = listener; },
      removeListener: (listener) => { remove(listener); },
    };
    const throwingRoot = root(() => { throw new Error("detached"); });
    const controller = createMotionController({
      root: throwingRoot,
      storage: storage({ readUiPreferences: () => { throw new Error("unavailable"); } }),
      matchMedia: () => media,
    });
    const unsubscribe = controller.subscribe(() => { throw new Error("detached listener"); });
    expect(controller.getState()).toMatchObject({ userMode: "on", systemReduced: true, limitedBySystem: true });
    events.change?.({ matches: false });
    expect(controller.getState()).toMatchObject({ systemReduced: false, effective: true });
    unsubscribe();
    controller.destroy();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("covers media and storage failures without making the state unusable", () => {
    const registrationFailure: MediaMock = {
      matches: false,
      addEventListener: () => { throw new Error("registration failed"); },
      removeEventListener: () => {},
    };
    const registrationController = createMotionController({ matchMedia: () => registrationFailure });
    registrationController.destroy();

    const writeFailure = createMotionController({
      storage: storage({ writeUiPreferences: () => { throw new Error("write failed"); } }),
    });
    expect(writeFailure.setUserMode("off")).toBe(false);
    expect(writeFailure.getState().userMode).toBe("off");
    writeFailure.destroy();

    const readFailure = createMotionController({
      storage: storage({ readUiPreferences: () => { throw new Error("read failed"); } }),
    });
    expect(readFailure.setUserMode("off")).toBe(false);
    readFailure.destroy();

    const falseWrite = createMotionController({ storage: storage({ writeUiPreferences: () => false }) });
    expect(falseWrite.setUserMode("off")).toBe(false);
    falseWrite.destroy();

    const factoryFailure = createMotionController({ matchMedia: () => { throw new Error("matchMedia failed"); } });
    factoryFailure.destroy();
  });

  it("uses the global matchMedia fallback and validates public operations", () => {
    const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
    const calls: string[] = [];
    const media: MediaMock = { matches: true };
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (query: string) => { calls.push(query); return media; },
    });
    try {
      const controller = createMotionController({ root: null });
      expect(calls).toEqual([MOTION_MEDIA_QUERY]);
      expect(controller.getState().limitedBySystem).toBe(true);
      expect(() => controller.previewUserMode("invalid" as "on")).toThrow("invalid_motion_mode");
      expect(() => controller.apply({ animations: "on", wallpaperColor: "invalid" as UiPreferences["wallpaperColor"] })).toThrow("invalid_scene");
      expect(() => controller.subscribe(null as unknown as (state: MotionState) => void)).toThrow("invalid_motion_listener");
      controller.destroy();
      const noopUnsubscribe = controller.subscribe(() => {});
      noopUnsubscribe();
    } finally {
      restoreGlobal("matchMedia", previousMatchMedia);
    }
  });

  it("keeps operation calls safe when no browser adapters exist", () => {
    const controller: MotionController = createMotionController({ root: null });
    expect(controller.setUserMode("off")).toBe(false);
    expect(controller.getState()).toMatchObject({ userMode: "off", effective: false });
    controller.destroy();
  });
});
