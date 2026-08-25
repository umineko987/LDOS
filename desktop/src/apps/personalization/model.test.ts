import { describe, expect, it } from "vitest";
import { BUILT_IN_SCENES } from "../../core/personalization/scenes";
import { PERSONALIZATION_DEFAULTS, derivePersonalizationPresentation, derivePersonalizationPreview, normalizePersonalizationPreferences, personalizationPreferencesEqual, projectPersonalizationPreferences } from "./model";

const motion = { userMode: "on" as const, systemReduced: false, effective: true, limitedBySystem: false };
const state = (overrides: Record<string, unknown> = {}) => ({ committed: PERSONALIZATION_DEFAULTS, draft: PERSONALIZATION_DEFAULTS, dirty: false, busy: false, motion, ...overrides });

describe("Personalization model", () => {
  it("keeps exactly the six safe scenes and two preference fields", () => {
    expect(BUILT_IN_SCENES).toHaveLength(6);
    expect(normalizePersonalizationPreferences({ animations: "off", wallpaperColor: "forest", wallpaperKind: "custom" })).toEqual({ animations: "off", wallpaperColor: "graphite" });
    expect(normalizePersonalizationPreferences({ animations: "off", wallpaperColor: "forest", retired: true })).toEqual({ animations: "off", wallpaperColor: "forest" });
    expect(normalizePersonalizationPreferences(JSON.parse('{"animations":"off","wallpaperColor":"forest","__proto__":{}}'))).toEqual(PERSONALIZATION_DEFAULTS);
    expect(projectPersonalizationPreferences({ animations: "off", wallpaperColor: "forest" })).toEqual({ animations: "off", wallpaperColor: "forest" });
    expect(() => projectPersonalizationPreferences({ animations: "off", wallpaperColor: "forest", token: "secret" })).toThrow(TypeError);
  });
  it("never evaluates accessors and derives immutable preview facts", () => {
    let reads = 0;
    const accessor = {}; Object.defineProperty(accessor, "wallpaperColor", { enumerable: true, get: () => { reads += 1; return "forest"; } });
    expect(normalizePersonalizationPreferences(accessor)).toEqual(PERSONALIZATION_DEFAULTS);
    expect(reads).toBe(0);
    const preview = derivePersonalizationPreview(state({ draft: { animations: "off", wallpaperColor: "deep-ocean" }, dirty: true, motion: { userMode: "off", systemReduced: false, effective: false, limitedBySystem: false } }));
    expect(Object.isFrozen(preview)).toBe(true);
    expect(preview.scene.id).toBe("deep-ocean");
    expect(preview.appearance.toneLabel).toBe("深色夜航玻璃");
    expect(preview.motion.statusId).toBe("off");
    expect(JSON.stringify(preview)).not.toContain("blob:");
    expect(derivePersonalizationPreview(state({ motion: { userMode: "on", systemReduced: true, effective: false, limitedBySystem: true } })).motion.statusId).toBe("system-limited");
    expect(() => derivePersonalizationPreview({ ...state(), dirty: true })).toThrow(TypeError);
  });
  it("derives clean, dirty, saving, success and error presentation", () => {
    expect(personalizationPreferencesEqual(PERSONALIZATION_DEFAULTS, { ...PERSONALIZATION_DEFAULTS })).toBe(true);
    expect(derivePersonalizationPresentation({ dirty: false, busy: false, phase: "clean" }).state).toBe("clean");
    expect(derivePersonalizationPresentation({ dirty: true, busy: false, phase: "dirty" }).kind).toBe("warning");
    expect(derivePersonalizationPresentation({ dirty: true, busy: true, phase: "saving" }).kind).toBe("running");
    expect(derivePersonalizationPresentation({ dirty: false, busy: false, phase: "success" }).state).toBe("success");
    expect(derivePersonalizationPresentation({ dirty: false, busy: false, phase: "error" }).kind).toBe("error");
  });
});
