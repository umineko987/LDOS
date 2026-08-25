import { describe, expect, it, vi } from "vitest";
import type { PersistenceService, UiPreferences } from "../../core/persistence/service";
import { createPersonalizationService } from "./service";

const preferences: UiPreferences = { animations: "off", wallpaperColor: "forest" };

describe("Personalization service", () => {
  it("uses only the existing persistence preference read/write path", () => {
    const readUiPreferences = vi.fn<() => UiPreferences>(() => preferences);
    const writeUiPreferences = vi.fn<(value: UiPreferences) => boolean>(() => true);
    const service = createPersonalizationService({ readUiPreferences, writeUiPreferences } as unknown as PersistenceService);
    expect(service.read()).toEqual(preferences);
    expect(service.write(preferences)).toBe(true);
    expect(writeUiPreferences).toHaveBeenCalledWith(preferences);
  });
});
