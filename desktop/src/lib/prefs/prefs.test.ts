import { describe, expect, it } from "vitest";

import { RENDERER_STORAGE_KEY } from "#lib/gfx/renderer.ts";

import {
  applyHtmlAttributes,
  DEFAULT_PREFERENCES,
  DENSITY_STORAGE_KEY,
  effectiveReducedMotion,
  htmlAttributes,
  MOTION_STORAGE_KEY,
  parseDensity,
  parseMotion,
  readPreferences,
  writePreferences,
  type PreferenceStorage,
} from "./prefs.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: PreferenceStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { storage, values };
}

const broken: PreferenceStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("quota");
  },
};

describe("preferences", () => {
  it("parses only known values and falls back to the defaults", () => {
    expect(parseMotion("on")).toBe("on");
    expect(parseMotion("off")).toBe("off");
    expect(parseMotion("reduce")).toBe("system");
    expect(parseMotion(null)).toBe("system");
    expect(parseDensity("comfortable")).toBe("comfortable");
    expect(parseDensity("spacious")).toBe("compact");
  });

  it("reads stored values, including the shared renderer key", () => {
    const { storage } = memoryStorage({
      [MOTION_STORAGE_KEY]: "on",
      [DENSITY_STORAGE_KEY]: "comfortable",
      [RENDERER_STORAGE_KEY]: "canvas2d",
    });
    expect(readPreferences(storage)).toEqual({ motion: "on", density: "comfortable", renderer: "canvas2d" });
  });

  it("returns the defaults when storage is missing or throws", () => {
    expect(readPreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(readPreferences(broken)).toEqual(DEFAULT_PREFERENCES);
    expect(() => writePreferences({ motion: "on", density: "comfortable", renderer: "webgl2" }, broken)).not.toThrow();
  });

  it("writes only the given fields and normalizes them", () => {
    const { storage, values } = memoryStorage();
    writePreferences({ density: "comfortable" }, storage);
    expect([...values]).toEqual([[DENSITY_STORAGE_KEY, "comfortable"]]);

    writePreferences({ motion: "bogus" as never, renderer: "webgl2" }, storage);
    expect(values.get(MOTION_STORAGE_KEY)).toBe("system");
    expect(values.get(RENDERER_STORAGE_KEY)).toBe("webgl2");
  });

  it("combines the explicit choice with the system setting", () => {
    expect(effectiveReducedMotion("system", true)).toBe(true);
    expect(effectiveReducedMotion("system", false)).toBe(false);
    expect(effectiveReducedMotion("on", false)).toBe(true);
    expect(effectiveReducedMotion("off", true)).toBe(false);
  });

  it("maps preferences to html data attributes", () => {
    expect(htmlAttributes({ motion: "system", density: "compact" })).toEqual({ "data-motion": null, "data-density": null });
    expect(htmlAttributes({ motion: "on", density: "comfortable" })).toEqual({
      "data-motion": "reduced",
      "data-density": "comfortable",
    });
    expect(htmlAttributes({ motion: "off", density: "compact" })["data-motion"]).toBe("full");
  });

  it("sets and removes the attributes on an element", () => {
    const attributes = new Map<string, string>([["data-density", "comfortable"]]);
    const element = {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
    };
    applyHtmlAttributes(element, { motion: "on", density: "compact" });
    expect([...attributes]).toEqual([["data-motion", "reduced"]]);
  });
});
