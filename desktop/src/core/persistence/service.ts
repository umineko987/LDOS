import {
  APPLICATION_DEFINITIONS,
  getApplicationDefinition,
  type ApplicationId,
  type WindowRect,
} from "../applications/definitions";
import type { ShellPersistence, WindowPlacement } from "../state/shell";
import { clampWindowRect, sameWindowRect, type WindowViewport } from "../windowing/geometry";
import { PERSISTENCE_KEYS, type PersistenceAdapter } from "./adapter";

export const BUILT_IN_SCENE_IDS = Object.freeze([
  "graphite",
  "slate",
  "deep-ocean",
  "forest",
  "plum-gray",
  "warm-paper",
] as const);

export type SceneId = typeof BUILT_IN_SCENE_IDS[number];
export type MotionPreference = "on" | "off";

export interface UiPreferences {
  readonly animations: MotionPreference;
  readonly wallpaperColor: SceneId;
}

export interface PersistenceService extends ShellPersistence {
  readCurrentApp(): ApplicationId | null;
  readActiveBatchId(): string | null;
  writeActiveBatchId(batchId: string | null): boolean;
  readWindowPlacements(): readonly WindowPlacement[];
  readUiPreferences(): UiPreferences;
  writeUiPreferences(preferences: UiPreferences): boolean;
}

const DEFAULT_PREFERENCES = Object.freeze<UiPreferences>({
  animations: "on",
  wallpaperColor: "graphite",
});
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const RECT_KEYS = Object.freeze(["x", "y", "w", "h"] as const);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PLACEMENTS = 128;

function descriptorsFor(value: unknown): PropertyDescriptorMap | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function dataValue(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value as PropertyDescriptor | undefined;
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function hasExactDataKeys(value: unknown, expected: readonly string[]): boolean {
  const descriptors = descriptorsFor(value);
  if (!descriptors) return false;
  const keys = Reflect.ownKeys(descriptors);
  return keys.length === expected.length && keys.every((key) => (
    typeof key === "string"
    && expected.includes(key)
    && Object.hasOwn(descriptors[key], "value")
  ));
}

export function parseStorageObject(serialized: unknown): Record<string, unknown> | null {
  if (typeof serialized !== "string" || serialized.length > 4096) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    return descriptorsFor(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function applicationId(value: unknown): ApplicationId | null {
  return typeof value === "string" && value.length <= 32 && getApplicationDefinition(value)
    ? value as ApplicationId
    : null;
}

function projectRect(value: unknown): WindowRect {
  if (!hasExactDataKeys(value, RECT_KEYS)) throw new TypeError("invalid_window_rect");
  const descriptors = descriptorsFor(value)!;
  const fields = RECT_KEYS.map((key) => dataValue(descriptors, key));
  if (fields.some((field) => typeof field !== "number" || !Number.isFinite(field))) {
    throw new TypeError("invalid_window_rect");
  }
  const [x, y, w, h] = fields as [number, number, number, number];
  if (w < 360 || h < 240) throw new TypeError("invalid_window_rect");
  return Object.freeze({ x, y, w, h });
}

function normalizeViewport(value: WindowViewport): WindowViewport {
  return Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0
    ? value
    : DEFAULT_VIEWPORT;
}

function projectPlacement(value: unknown, viewport: WindowViewport | null): WindowPlacement {
  if (!hasExactDataKeys(value, ["appId", "rect", "maximized"])) {
    throw new TypeError("invalid_window_placement");
  }
  const descriptors = descriptorsFor(value)!;
  const appId = applicationId(dataValue(descriptors, "appId"));
  const maximized = dataValue(descriptors, "maximized");
  if (!appId || typeof maximized !== "boolean") throw new TypeError("invalid_window_placement");
  const storedRect = projectRect(dataValue(descriptors, "rect"));
  const rect = viewport ? clampWindowRect(storedRect, normalizeViewport(viewport)) : storedRect;
  if (viewport && !sameWindowRect(storedRect, rect)) throw new TypeError("invalid_window_placement");
  return Object.freeze({ appId, rect, maximized });
}

function uniquePlacements(
  values: unknown,
  projector: (value: unknown) => WindowPlacement,
): readonly WindowPlacement[] {
  if (!Array.isArray(values) || values.length > MAX_PLACEMENTS) {
    throw new TypeError("invalid_window_placements");
  }
  const seen = new Set<ApplicationId>();
  const placements = values.map((value) => {
    const placement = projector(value);
    if (seen.has(placement.appId)) throw new TypeError("duplicate_window_placement");
    seen.add(placement.appId);
    return placement;
  });
  return Object.freeze(placements);
}

export function deserializeWindowPlacements(
  serialized: unknown,
  viewport: WindowViewport,
): readonly WindowPlacement[] | null {
  const root = parseStorageObject(serialized);
  if (!root || !hasExactDataKeys(root, ["placements"])) return null;
  try {
    const descriptors = descriptorsFor(root)!;
    return uniquePlacements(
      dataValue(descriptors, "placements"),
      (value) => projectPlacement(value, viewport),
    );
  } catch {
    return null;
  }
}

export function serializeWindowPlacements(placements: readonly WindowPlacement[]): string {
  const projected = uniquePlacements(placements, (value) => projectPlacement(value, null));
  return JSON.stringify({ placements: projected });
}

export function migrateLegacyWindowLayout(
  serialized: unknown,
  viewport: WindowViewport,
): readonly WindowPlacement[] | null {
  const root = parseStorageObject(serialized);
  if (!root || !hasExactDataKeys(root, ["windows"])) return null;
  try {
    const rootDescriptors = descriptorsFor(root)!;
    const migrated = uniquePlacements(dataValue(rootDescriptors, "windows"), (value) => {
      if (!hasExactDataKeys(value, ["appId", "windowState", "rect"])) {
        throw new TypeError("invalid_legacy_window");
      }
      const descriptors = descriptorsFor(value)!;
      const appId = applicationId(dataValue(descriptors, "appId"));
      const state = dataValue(descriptors, "windowState");
      if (!appId || !["normal", "maximized", "minimized"].includes(String(state))) {
        throw new TypeError("invalid_legacy_window");
      }
      return Object.freeze({
        appId,
        rect: clampWindowRect(projectRect(dataValue(descriptors, "rect")), normalizeViewport(viewport)),
        maximized: state === "maximized",
      });
    });
    const byId = new Map(migrated.map((placement) => [placement.appId, placement]));
    return Object.freeze(APPLICATION_DEFINITIONS
      .filter(({ id }) => byId.has(id))
      .map(({ id }) => byId.get(id)!));
  } catch {
    return null;
  }
}

function normalizeUiPreferences(value: unknown): UiPreferences {
  const descriptors = descriptorsFor(value);
  if (!descriptors || Reflect.ownKeys(descriptors).some((key) => (
    typeof key !== "string" || DANGEROUS_KEYS.has(key)
  ))) return DEFAULT_PREFERENCES;

  const rawAnimations = dataValue(descriptors, "animations");
  const animations = rawAnimations === "system"
    ? "on"
    : rawAnimations === "reduced"
      ? "off"
      : rawAnimations === "on" || rawAnimations === "off"
        ? rawAnimations
        : DEFAULT_PREFERENCES.animations;
  const wallpaperKind = dataValue(descriptors, "wallpaperKind");
  const rawScene = dataValue(descriptors, "wallpaperColor");
  const wallpaperColor = wallpaperKind !== "custom" && BUILT_IN_SCENE_IDS.includes(rawScene as SceneId)
    ? rawScene as SceneId
    : DEFAULT_PREFERENCES.wallpaperColor;
  return Object.freeze({ animations, wallpaperColor });
}

function projectUiPreferences(value: unknown): UiPreferences {
  const descriptors = descriptorsFor(value);
  if (!descriptors) throw new TypeError("invalid_ui_preferences");
  const allowed = ["animations", "wallpaperColor"];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key) || !Object.hasOwn(descriptors[key], "value")) {
      throw new TypeError("invalid_ui_preferences");
    }
  }
  const animations = dataValue(descriptors, "animations") ?? DEFAULT_PREFERENCES.animations;
  const wallpaperColor = dataValue(descriptors, "wallpaperColor") ?? DEFAULT_PREFERENCES.wallpaperColor;
  if ((animations !== "on" && animations !== "off") || !BUILT_IN_SCENE_IDS.includes(wallpaperColor as SceneId)) {
    throw new TypeError("invalid_ui_preferences");
  }
  return Object.freeze({ animations, wallpaperColor: wallpaperColor as SceneId });
}

export function deserializeUiPreferences(serialized: unknown): UiPreferences {
  return normalizeUiPreferences(parseStorageObject(serialized));
}

export function serializeUiPreferences(preferences: UiPreferences): string {
  return JSON.stringify(projectUiPreferences(preferences));
}

function copyPlacement(placement: WindowPlacement): WindowPlacement {
  return Object.freeze({ ...placement, rect: Object.freeze({ ...placement.rect }) });
}

export function createPersistenceService(
  adapter: PersistenceAdapter,
  {
    viewport = () => ({
      width: Math.max(DEFAULT_VIEWPORT.width, globalThis.document?.documentElement?.clientWidth ?? 0),
      height: Math.max(DEFAULT_VIEWPORT.height, globalThis.document?.documentElement?.clientHeight ?? 0),
    }),
  }: { readonly viewport?: () => WindowViewport } = {},
): PersistenceService {
  let placementCache: readonly WindowPlacement[] | null = null;

  const readWindowPlacements = (): readonly WindowPlacement[] => {
    const serialized = adapter.readLocal(PERSISTENCE_KEYS.windowPlacements);
    let placements = deserializeWindowPlacements(serialized, viewport());
    if (serialized !== null) {
      if (placements === null) {
        adapter.removeLocal(PERSISTENCE_KEYS.windowPlacements);
        placements = [];
      } else {
        const repaired = serializeWindowPlacements(placements);
        if (repaired !== serialized) adapter.writeLocal(PERSISTENCE_KEYS.windowPlacements, repaired);
      }
      adapter.removeLocal(PERSISTENCE_KEYS.windowLayout);
    } else {
      const legacy = adapter.readLocal(PERSISTENCE_KEYS.windowLayout);
      placements = legacy === null ? [] : migrateLegacyWindowLayout(legacy, viewport()) ?? [];
      if (legacy !== null) {
        if (placements.length > 0) {
          adapter.writeLocal(PERSISTENCE_KEYS.windowPlacements, serializeWindowPlacements(placements));
        }
        adapter.removeLocal(PERSISTENCE_KEYS.windowLayout);
      }
    }
    placementCache = Object.freeze(placements.map(copyPlacement));
    return placementCache;
  };

  const service: PersistenceService = {
    readCurrentApp() {
      const stored = adapter.readSession(PERSISTENCE_KEYS.currentApp);
      const appId = applicationId(stored);
      if (stored !== null && appId === null) adapter.removeSession(PERSISTENCE_KEYS.currentApp);
      return appId;
    },
    writeCurrentApp(appId) {
      return appId === null
        ? adapter.removeSession(PERSISTENCE_KEYS.currentApp)
        : adapter.writeSession(PERSISTENCE_KEYS.currentApp, appId);
    },
    readActiveBatchId() {
      const stored = adapter.readSession(PERSISTENCE_KEYS.activeBatch);
      if (stored === null || BATCH_ID_PATTERN.test(stored)) return stored;
      adapter.removeSession(PERSISTENCE_KEYS.activeBatch);
      return null;
    },
    writeActiveBatchId(batchId) {
      if (batchId === null) return adapter.removeSession(PERSISTENCE_KEYS.activeBatch);
      if (!BATCH_ID_PATTERN.test(batchId)) throw new TypeError("invalid_batch_id");
      return adapter.writeSession(PERSISTENCE_KEYS.activeBatch, batchId);
    },
    readWindowPlacements,
    readWindowPlacement(appId) {
      const placements = placementCache ?? readWindowPlacements();
      const placement = placements.find((item) => item.appId === appId);
      return placement ? copyPlacement(placement) : null;
    },
    writeWindowPlacement(placement) {
      const projected = projectPlacement(placement, null);
      const placements = placementCache ?? readWindowPlacements();
      const byId = new Map(placements.map((item) => [item.appId, item]));
      byId.set(projected.appId, projected);
      const ordered = APPLICATION_DEFINITIONS
        .filter(({ id }) => byId.has(id))
        .map(({ id }) => byId.get(id)!);
      const written = adapter.writeLocal(
        PERSISTENCE_KEYS.windowPlacements,
        serializeWindowPlacements(ordered),
      );
      if (written) placementCache = Object.freeze(ordered.map(copyPlacement));
      return written;
    },
    readUiPreferences() {
      const serialized = adapter.readLocal(PERSISTENCE_KEYS.uiPreferences);
      const preferences = deserializeUiPreferences(serialized);
      if (serialized !== null) {
        const migrated = serializeUiPreferences(preferences);
        if (migrated !== serialized) adapter.writeLocal(PERSISTENCE_KEYS.uiPreferences, migrated);
      }
      return preferences;
    },
    writeUiPreferences(preferences) {
      return adapter.writeLocal(PERSISTENCE_KEYS.uiPreferences, serializeUiPreferences(preferences));
    },
  };
  return Object.freeze(service);
}
