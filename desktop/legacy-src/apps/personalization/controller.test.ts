import { describe, expect, it, vi } from "vitest";
import type { MotionController, MotionState } from "../../core/motion/controller";
import type { UiPreferences } from "../../core/persistence/service";
import { createPersonalizationController } from "./controller";
import type { PersonalizationService } from "./service";
import { createPersonalizationStore } from "./state";

const initial: UiPreferences = { animations: "on", wallpaperColor: "graphite" };

function createMotion() {
  let state: MotionState = { userMode: "on", systemReduced: false, effective: true, limitedBySystem: false };
  const listeners = new Set<(value: MotionState) => void>();
  const apply = vi.fn((preferences: UiPreferences) => {
    state = Object.freeze({
      userMode: preferences.animations,
      systemReduced: state.systemReduced,
      effective: preferences.animations === "on" && !state.systemReduced,
      limitedBySystem: preferences.animations === "on" && state.systemReduced,
    });
    for (const listener of [...listeners]) listener(state);
    return state;
  });
  const controller: MotionController = {
    getState: () => state,
    previewUserMode: (mode) => apply({ animations: mode, wallpaperColor: "graphite" }),
    setUserMode: () => true,
    apply,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: vi.fn(() => { listeners.clear(); }),
  };
  return { controller, apply, emit: (value: MotionState) => { state = value; for (const listener of [...listeners]) listener(value); } };
}

function setup({
  writeResult = true,
  read = () => initial,
  write = () => writeResult,
}: {
  readonly writeResult?: boolean;
  readonly read?: () => UiPreferences;
  readonly write?: (value: UiPreferences) => boolean;
} = {}) {
  const service: PersonalizationService = {
    read: vi.fn(read),
    write: vi.fn(write),
  };
  const store = createPersonalizationStore({ initial });
  const motion = createMotion();
  const controller = createPersonalizationController({ store, service, motion: motion.controller });
  return { controller, store, service, motion };
}

describe("Personalization controller", () => {
  it("activates once, previews locally, and commits one exact preference write", async () => {
    const { controller, store, service, motion } = setup();
    controller.activate();
    controller.activate();
    expect(service.read).toHaveBeenCalledOnce();
    expect(controller.preview({ wallpaperColor: "forest" })).toBe(true);
    expect(service.write).not.toHaveBeenCalled();
    expect(motion.apply).toHaveBeenCalledWith({ animations: "on", wallpaperColor: "forest" });

    const first = controller.commit();
    const second = controller.commit();
    expect(second).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(service.write).toHaveBeenCalledOnce();
    expect(service.write).toHaveBeenCalledWith({ animations: "on", wallpaperColor: "forest" });
    expect(store.getState()).toMatchObject({ dirty: false, busy: false, phase: "success", committed: { wallpaperColor: "forest" } });
    controller.destroy();
  });

  it("retains the dirty draft on invalid preview or unavailable storage, then cancels to committed", async () => {
    const { controller, store, service } = setup({ writeResult: false });
    controller.activate();
    expect(controller.preview({ animations: "off" })).toBe(true);
    const before = store.getState().draft;
    expect(controller.preview({ wallpaperColor: "not-a-scene" as UiPreferences["wallpaperColor"] })).toBe(false);
    expect(store.getState().draft).toEqual(before);
    expect(store.getState().error).toContain("设置值无效");
    await expect(controller.commit()).resolves.toBe(false);
    expect(service.write).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({ dirty: true, phase: "error", draft: { animations: "off" } });
    expect(controller.cancel("已取消，草稿仍保留。")).toBe(true);
    expect(store.getState()).toMatchObject({ dirty: false, phase: "clean", draft: initial, message: "已取消，草稿仍保留。" });
    controller.destroy();
  });

  it("falls back to safe defaults when the preference read fails", () => {
    const { controller, store } = setup({ read: () => { throw new Error("read failed"); } });
    controller.activate();
    expect(store.getState()).toMatchObject({ committed: initial, draft: initial, dirty: false });
    controller.deactivate();
    expect(controller.preview({ wallpaperColor: "forest" })).toBe(false);
    controller.destroy();
  });

  it("drops queued commits on deactivate and releases motion/listener resources on destroy", async () => {
    const { controller, store, service, motion } = setup();
    controller.activate();
    controller.preview({ wallpaperColor: "slate" });
    const pending = controller.commit();
    controller.deactivate();
    await expect(pending).resolves.toBe(false);
    expect(service.write).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ dirty: false, busy: false, draft: initial });

    controller.activate();
    motion.emit({ userMode: "on", systemReduced: true, effective: false, limitedBySystem: true });
    expect(store.getState().motion).toMatchObject({ systemReduced: true, limitedBySystem: true });
    controller.destroy();
    controller.destroy();
    expect(motion.controller.destroy).toHaveBeenCalledOnce();
    expect(controller.preview({ wallpaperColor: "forest" })).toBe(false);
    expect(store.preview(initial, motion.controller.getState())).toBe(false);
  });
});
