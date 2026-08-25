import { describe, expect, it } from "vitest";
import personalizationSource from "../src/apps/personalization/Personalization.svelte?raw";
import controllerSource from "../src/apps/personalization/controller.ts?raw";
import modelSource from "../src/apps/personalization/model.ts?raw";
import serviceSource from "../src/apps/personalization/service.ts?raw";
import stateSource from "../src/apps/personalization/state.ts?raw";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";

function count(value: string, pattern: RegExp): number { return value.match(pattern)?.length ?? 0; }

describe("P4 Personalization target contracts", () => {
  it("keeps one preference owner, six scenes, and one persistence write path", () => {
    expect(count(personalizationSource, /createPersonalizationStore\s*\(/g)).toBe(1);
    expect(count(stateSource, /export function createPersonalizationStore\s*\(/g)).toBe(1);
    expect(modelSource).toContain("PERSONALIZATION_PREFERENCE_KEYS");
    expect(modelSource).toContain("derivePersonalizationPreview");
    expect(controllerSource).not.toContain("/api/");
    expect(controllerSource).not.toContain("polling.start");
    expect(serviceSource).not.toContain("fetch(");
    expect(appWindowSource).toContain('record.appId === "personalization"');
  });
  it("keeps preview local, apply single-flight, and teardown boundaries explicit", () => {
    expect(controllerSource).toContain("commitPromise");
    expect(controllerSource).toContain("service.write(preferences)");
    expect(controllerSource).toContain("controller.deactivate()");
    expect(personalizationSource).toContain("registerUnsavedChanges");
    expect(personalizationSource).toContain("beforeunload");
    expect(personalizationSource).toContain("controller.destroy()");
    for (const source of [personalizationSource, controllerSource, modelSource, serviceSource, stateSource]) {
      expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\b(?:localStorage|sessionStorage|indexedDB)\b|\bsetInterval\s*\(|innerHTML|console\./);
    }
  });
});
