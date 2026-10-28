import { describe, expect, it, vi } from "vitest";
import type { UiPreferences } from "../../core/persistence/service";
import { createPersonalizationStore } from "./state";

const preferences: UiPreferences = { animations: "on", wallpaperColor: "graphite" };
const motion = { userMode: "on" as const, systemReduced: false, effective: true, limitedBySystem: false };

describe("Personalization state", () => {
  it("owns one committed/draft state and publishes transitions", () => {
    const store = createPersonalizationStore({ initial: preferences });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.getState().dirty).toBe(false);
    store.preview({ animations: "off", wallpaperColor: "graphite" }, { ...motion, userMode: "off", effective: false });
    expect(store.getState()).toMatchObject({ dirty: true, phase: "dirty", draft: { animations: "off" } });
    expect(store.beginSave()).toBe(true);
    expect(store.getState().busy).toBe(true);
    store.commitSaved({ animations: "off", wallpaperColor: "graphite" }, { ...motion, userMode: "off", effective: false });
    expect(store.getState()).toMatchObject({ dirty: false, busy: false, phase: "success", committed: { animations: "off" } });
    expect(listener).toHaveBeenCalled();
    unsubscribe(); store.destroy();
    expect(store.getState().committed).toEqual({ animations: "off", wallpaperColor: "graphite" });
  });
  it("restores the committed draft and drops updates after destroy", () => {
    const store = createPersonalizationStore({ initial: preferences });
    store.preview({ animations: "off", wallpaperColor: "graphite" }, { ...motion, userMode: "off", effective: false });
    store.cancel(motion, "已取消离开，未应用的更改继续保留。");
    expect(store.getState()).toMatchObject({ dirty: false, draft: preferences, message: "已取消离开，未应用的更改继续保留。" });
    store.destroy();
    expect(store.preview(preferences, motion)).toBe(false);
  });
});
