import { describe, expect, it, vi } from "vitest";

import type { WindowPlacement } from "../state/shell";
import { BUILT_IN_SCENE_IDS } from "../personalization/scenes";
import { PERSISTENCE_KEYS, type PersistenceAdapter, type PersistenceKey } from "./adapter";
import {
  createPersistenceService,
  deserializeUiPreferences,
  deserializeWindowPlacements,
  migrateLegacyWindowLayout,
  parseStorageObject,
  serializeUiPreferences,
  serializeWindowPlacements,
  type UiPreferences,
} from "./service";

class RecordingAdapter implements PersistenceAdapter {
  readonly local = new Map<PersistenceKey, string>();
  readonly session = new Map<PersistenceKey, string>();
  readonly readLocal = vi.fn((key: PersistenceKey) => this.local.get(key) ?? null);
  readonly writeLocal = vi.fn((key: PersistenceKey, value: string) => {
    this.local.set(key, value);
    return true;
  });
  readonly removeLocal = vi.fn((key: PersistenceKey) => this.local.delete(key));
  readonly readSession = vi.fn((key: PersistenceKey) => this.session.get(key) ?? null);
  readonly writeSession = vi.fn((key: PersistenceKey, value: string) => {
    this.session.set(key, value);
    return true;
  });
  readonly removeSession = vi.fn((key: PersistenceKey) => this.session.delete(key));
}

const viewport = { width: 1_180, height: 720 };
const placements: readonly WindowPlacement[] = [
  { appId: "crawl", rect: { x: 48, y: 36, w: 720, h: 480 }, maximized: false },
  { appId: "review", rect: { x: 96, y: 52, w: 900, h: 600 }, maximized: true },
];

describe("persistence sanitizers and migrations", () => {
  it("parses only bounded plain JSON objects", () => {
    expect(parseStorageObject('{"ok":true}')).toEqual({ ok: true });
    for (const value of [null, 1, "", "[]", "null", "{broken", "x".repeat(4097)]) {
      expect(parseStorageObject(value)).toBeNull();
    }
  });

  it("migrates UI preferences to only six scenes and the motion switch", () => {
    expect(BUILT_IN_SCENE_IDS).toEqual([
      "graphite", "slate", "deep-ocean", "forest", "plum-gray", "warm-paper",
    ]);
    expect(deserializeUiPreferences(null)).toEqual({ animations: "on", wallpaperColor: "graphite" });
    expect(deserializeUiPreferences('{"animations":"system","wallpaperColor":"slate"}'))
      .toEqual({ animations: "on", wallpaperColor: "slate" });
    expect(deserializeUiPreferences('{"animations":"reduced","wallpaperColor":"forest","retired":true}'))
      .toEqual({ animations: "off", wallpaperColor: "forest" });
    expect(deserializeUiPreferences('{"animations":"off","wallpaperColor":"deep-ocean"}'))
      .toEqual({ animations: "off", wallpaperColor: "deep-ocean" });
    expect(deserializeUiPreferences('{"animations":"invalid","wallpaperColor":"warm-paper"}'))
      .toEqual({ animations: "on", wallpaperColor: "warm-paper" });
    expect(deserializeUiPreferences('{"wallpaperKind":"custom","wallpaperColor":"forest"}'))
      .toEqual({ animations: "on", wallpaperColor: "graphite" });
    expect(deserializeUiPreferences('{"constructor":{},"wallpaperColor":"forest"}'))
      .toEqual({ animations: "on", wallpaperColor: "graphite" });
    for (const scene of BUILT_IN_SCENE_IDS) {
      expect(deserializeUiPreferences(JSON.stringify({ wallpaperColor: scene })).wallpaperColor).toBe(scene);
    }

    expect(serializeUiPreferences({ animations: "off", wallpaperColor: "plum-gray" }))
      .toBe('{"animations":"off","wallpaperColor":"plum-gray"}');
    expect(serializeUiPreferences({} as UiPreferences))
      .toBe('{"animations":"on","wallpaperColor":"graphite"}');
    expect(() => serializeUiPreferences({ animations: "maybe", wallpaperColor: "graphite" } as never))
      .toThrow("invalid_ui_preferences");
    expect(() => serializeUiPreferences({ animations: "on", wallpaperColor: "unknown" } as never))
      .toThrow("invalid_ui_preferences");
    expect(() => serializeUiPreferences({ animations: "on", wallpaperColor: "graphite", extra: true } as never))
      .toThrow("invalid_ui_preferences");
    expect(() => serializeUiPreferences(null as never)).toThrow("invalid_ui_preferences");
    expect(() => serializeUiPreferences(new Date() as never)).toThrow("invalid_ui_preferences");
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error("blocked"); } });
    expect(() => serializeUiPreferences(hostile as never)).toThrow("invalid_ui_preferences");

    const accessor = Object.defineProperty({ wallpaperColor: "graphite" }, "animations", {
      enumerable: true,
      get: () => "on",
    });
    expect(() => serializeUiPreferences(accessor as UiPreferences)).toThrow("invalid_ui_preferences");
    const symbol = { animations: "on", wallpaperColor: "graphite", [Symbol("unsafe")]: true };
    expect(() => serializeUiPreferences(symbol as never)).toThrow("invalid_ui_preferences");
  });

  it("round-trips only normal rect and maximized preference", () => {
    const serialized = serializeWindowPlacements(placements);
    expect(JSON.parse(serialized)).toEqual({ placements });
    expect(deserializeWindowPlacements(serialized, viewport)).toEqual(placements);
    for (const forbidden of ["windowState", "running", "focused", "minimized"]) {
      expect(serialized).not.toContain(forbidden);
    }

    const invalid = [
      null,
      "{}",
      JSON.stringify({ placements, focusedAppId: "review" }),
      JSON.stringify({ placements: [placements[0], placements[0]] }),
      JSON.stringify({ placements: [{ ...placements[0], appId: "unknown" }] }),
      JSON.stringify({ placements: [{ ...placements[0], maximized: "yes" }] }),
      JSON.stringify({ placements: [{ ...placements[0], rect: { ...placements[0].rect, w: 359 } }] }),
      JSON.stringify({ placements: [{ ...placements[0], rect: { ...placements[0].rect, x: 9_999 } }] }),
      JSON.stringify({ placements: Array.from({ length: 129 }, (_, index) => ({
        ...placements[0], appId: index === 0 ? "crawl" : `unknown-${index}`,
      })) }),
    ];
    for (const value of invalid) expect(deserializeWindowPlacements(value, viewport)).toBeNull();

    expect(() => serializeWindowPlacements([{
      ...placements[0],
      rect: { ...placements[0].rect, x: Number.NaN },
    }])).toThrow("invalid_window_rect");
    expect(() => serializeWindowPlacements([{ ...placements[0], secret: true } as never]))
      .toThrow("invalid_window_placement");
    expect(() => serializeWindowPlacements([{ ...placements[0], rect: null } as never]))
      .toThrow("invalid_window_rect");
    expect(() => serializeWindowPlacements("bad" as never)).toThrow("invalid_window_placements");
    expect(deserializeWindowPlacements(serialized, { width: Number.NaN, height: 0 })).toEqual(placements);
  });

  it("migrates v1 in definition order without running, focused, or minimized state", () => {
    const legacy = JSON.stringify({ windows: [
      { appId: "review", windowState: "maximized", rect: placements[1].rect },
      { appId: "tasks", windowState: "minimized", rect: placements[0].rect },
      { appId: "crawl", windowState: "normal", rect: placements[0].rect },
    ] });
    expect(migrateLegacyWindowLayout(legacy, viewport)).toEqual([
      placements[0],
      { appId: "tasks", rect: placements[0].rect, maximized: false },
      placements[1],
    ]);
    expect(migrateLegacyWindowLayout(JSON.stringify({ windows: [
      { appId: "crawl", windowState: "normal", rect: { x: 2_000, y: 2_000, w: 720, h: 480 } },
    ] }), viewport)).toEqual([
      { appId: "crawl", windowState: undefined, rect: { x: 1_148, y: 240, w: 720, h: 480 }, maximized: false },
    ].map(({ appId, rect, maximized }) => ({ appId, rect, maximized })));

    for (const value of [
      null,
      "{}",
      JSON.stringify({ windows: [
        { appId: "crawl", windowState: "normal", rect: placements[0].rect, extra: true },
      ] }),
      JSON.stringify({ windows: [
        { appId: "unknown", windowState: "normal", rect: placements[0].rect },
      ] }),
      JSON.stringify({ windows: [
        { appId: "crawl", windowState: "hidden", rect: placements[0].rect },
      ] }),
      JSON.stringify({ windows: [
        { appId: "crawl", windowState: "normal", rect: placements[0].rect },
        { appId: "crawl", windowState: "maximized", rect: placements[0].rect },
      ] }),
    ]) expect(migrateLegacyWindowLayout(value, viewport)).toBeNull();
  });
});

describe("persistence service", () => {
  it("sanitizes session snapshots and never uses current-app as a startup workspace", () => {
    const adapter = new RecordingAdapter();
    const service = createPersistenceService(adapter, { viewport: () => viewport });
    expect(service.readCurrentApp()).toBeNull();
    adapter.session.set(PERSISTENCE_KEYS.currentApp, "crawl");
    expect(service.readCurrentApp()).toBe("crawl");
    adapter.session.set(PERSISTENCE_KEYS.currentApp, "../crawl");
    expect(service.readCurrentApp()).toBeNull();
    expect(adapter.removeSession).toHaveBeenCalledWith(PERSISTENCE_KEYS.currentApp);
    expect(service.writeCurrentApp("review")).toBe(true);
    expect(service.writeCurrentApp(null)).toBe(true);

    expect(service.readActiveBatchId()).toBeNull();
    adapter.session.set(PERSISTENCE_KEYS.activeBatch, "batch:p2.1");
    expect(service.readActiveBatchId()).toBe("batch:p2.1");
    adapter.session.set(PERSISTENCE_KEYS.activeBatch, "../batch");
    expect(service.readActiveBatchId()).toBeNull();
    expect(service.writeActiveBatchId("batch:next")).toBe(true);
    expect(service.writeActiveBatchId(null)).toBe(true);
    expect(() => service.writeActiveBatchId("batch/child")).toThrow("invalid_batch_id");
  });

  it("treats v2 as authoritative, repairs canonical JSON, and removes damaged data", () => {
    const adapter = new RecordingAdapter();
    adapter.local.set(PERSISTENCE_KEYS.windowPlacements, ` ${serializeWindowPlacements(placements)} `);
    adapter.local.set(PERSISTENCE_KEYS.windowLayout, "legacy-must-not-run");
    const service = createPersistenceService(adapter, { viewport: () => viewport });
    expect(service.readWindowPlacements()).toEqual(placements);
    expect(adapter.writeLocal).toHaveBeenCalledWith(
      PERSISTENCE_KEYS.windowPlacements,
      serializeWindowPlacements(placements),
    );
    expect(adapter.removeLocal).toHaveBeenCalledWith(PERSISTENCE_KEYS.windowLayout);
    expect(service.readWindowPlacement("review")).toEqual(placements[1]);

    const canonical = new RecordingAdapter();
    canonical.local.set(PERSISTENCE_KEYS.windowPlacements, serializeWindowPlacements(placements));
    expect(createPersistenceService(canonical, { viewport: () => viewport }).readWindowPlacements()).toEqual(placements);
    expect(canonical.writeLocal).not.toHaveBeenCalled();

    const damaged = new RecordingAdapter();
    damaged.local.set(PERSISTENCE_KEYS.windowPlacements, "{broken");
    const damagedService = createPersistenceService(damaged, { viewport: () => viewport });
    expect(damagedService.readWindowPlacements()).toEqual([]);
    expect(damaged.removeLocal).toHaveBeenCalledWith(PERSISTENCE_KEYS.windowPlacements);
  });

  it("performs a one-shot v1 migration and persists placements in definition order", () => {
    const adapter = new RecordingAdapter();
    adapter.local.set(PERSISTENCE_KEYS.windowLayout, JSON.stringify({ windows: [
      { appId: "review", windowState: "maximized", rect: placements[1].rect },
      { appId: "crawl", windowState: "normal", rect: placements[0].rect },
    ] }));
    const service = createPersistenceService(adapter, { viewport: () => viewport });
    expect(service.readWindowPlacements()).toEqual(placements);
    expect(adapter.writeLocal).toHaveBeenCalledWith(
      PERSISTENCE_KEYS.windowPlacements,
      serializeWindowPlacements(placements),
    );
    expect(adapter.removeLocal).toHaveBeenCalledWith(PERSISTENCE_KEYS.windowLayout);

    expect(service.writeWindowPlacement({
      appId: "tasks",
      rect: { x: 60, y: 40, w: 700, h: 460 },
      maximized: false,
    })).toBe(true);
    expect(JSON.parse(adapter.local.get(PERSISTENCE_KEYS.windowPlacements)!)).toEqual({
      placements: [placements[0], {
        appId: "tasks", rect: { x: 60, y: 40, w: 700, h: 460 }, maximized: false,
      }, placements[1]],
    });
  });

  it("falls back safely when no layout exists or persistence writes fail", () => {
    const adapter = new RecordingAdapter();
    adapter.writeLocal.mockImplementation(() => false);
    const service = createPersistenceService(adapter, { viewport: () => ({ width: Number.NaN, height: 0 }) });
    expect(service.readWindowPlacements()).toEqual([]);
    expect(service.writeWindowPlacement(placements[0])).toBe(false);
    expect(service.readWindowPlacement("crawl")).toBeNull();

    const freshRead = createPersistenceService(new RecordingAdapter(), { viewport: () => viewport });
    expect(freshRead.readWindowPlacement("crawl")).toBeNull();

    const freshWriteAdapter = new RecordingAdapter();
    const freshWrite = createPersistenceService(freshWriteAdapter, { viewport: () => viewport });
    expect(freshWrite.writeWindowPlacement(placements[0])).toBe(true);
    expect(freshWrite.readWindowPlacement("crawl")).toEqual(placements[0]);

    for (const legacy of ["{broken", '{"windows":[]}']) {
      const legacyAdapter = new RecordingAdapter();
      legacyAdapter.local.set(PERSISTENCE_KEYS.windowLayout, legacy);
      expect(createPersistenceService(legacyAdapter, { viewport: () => viewport }).readWindowPlacements()).toEqual([]);
      expect(legacyAdapter.removeLocal).toHaveBeenCalledWith(PERSISTENCE_KEYS.windowLayout);
    }

    const defaults = createPersistenceService(new RecordingAdapter());
    expect(defaults.readWindowPlacements()).toEqual([]);
  });

  it("repairs and writes only the current preference whitelist", () => {
    const adapter = new RecordingAdapter();
    adapter.local.set(PERSISTENCE_KEYS.uiPreferences, '{"animations":"reduced","wallpaperColor":"forest","old":true}');
    const service = createPersistenceService(adapter, { viewport: () => viewport });
    expect(service.readUiPreferences()).toEqual({ animations: "off", wallpaperColor: "forest" });
    expect(adapter.writeLocal).toHaveBeenCalledWith(
      PERSISTENCE_KEYS.uiPreferences,
      '{"animations":"off","wallpaperColor":"forest"}',
    );
    expect(service.writeUiPreferences({ animations: "on", wallpaperColor: "slate" })).toBe(true);

    const clean = new RecordingAdapter();
    clean.local.set(PERSISTENCE_KEYS.uiPreferences, '{"animations":"on","wallpaperColor":"graphite"}');
    const cleanService = createPersistenceService(clean, { viewport: () => viewport });
    expect(cleanService.readUiPreferences()).toEqual({ animations: "on", wallpaperColor: "graphite" });
    expect(clean.writeLocal).not.toHaveBeenCalled();

    const empty = createPersistenceService(new RecordingAdapter(), { viewport: () => viewport });
    expect(empty.readUiPreferences()).toEqual({ animations: "on", wallpaperColor: "graphite" });
  });
});
