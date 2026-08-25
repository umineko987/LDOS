import { BUILT_IN_SCENE_IDS, type SceneId } from "../personalization/scenes";
import type { MotionPreference, UiPreferences } from "../persistence/service";

export const MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";
export type MotionState = Readonly<{
  userMode: MotionPreference;
  systemReduced: boolean;
  effective: boolean;
  limitedBySystem: boolean;
}>;
export interface MotionController {
  getState(): MotionState;
  previewUserMode(mode: MotionPreference): MotionState;
  setUserMode(mode: MotionPreference): boolean;
  apply(preferences: UiPreferences): MotionState;
  subscribe(listener: (state: MotionState) => void): () => void;
  destroy(): void;
}
interface MediaQueryLike {
  readonly matches: boolean;
  readonly addEventListener?: (type: "change", listener: (event: { readonly matches: boolean }) => void) => void;
  readonly removeEventListener?: (type: "change", listener: (event: { readonly matches: boolean }) => void) => void;
  readonly addListener?: (listener: (event: { readonly matches: boolean }) => void) => void;
  readonly removeListener?: (listener: (event: { readonly matches: boolean }) => void) => void;
}
interface MotionStorage {
  readUiPreferences(): UiPreferences;
  writeUiPreferences(preferences: UiPreferences): boolean;
}

function readMediaQuery(factory: (() => MediaQueryLike) | null | undefined): MediaQueryLike | null {
  try {
    if (factory) return factory();
    if (typeof globalThis.matchMedia === "function") return globalThis.matchMedia(MOTION_MEDIA_QUERY);
  } catch {
    return null;
  }
  return null;
}
function makeState(userMode: MotionPreference, systemReduced: boolean): MotionState {
  return Object.freeze({
    userMode,
    systemReduced,
    effective: userMode === "on" && !systemReduced,
    limitedBySystem: userMode === "on" && systemReduced,
  });
}
function validScene(value: unknown): value is SceneId {
  return typeof value === "string" && (BUILT_IN_SCENE_IDS as readonly string[]).includes(value);
}

export function createMotionController({
  root = globalThis.document?.documentElement ?? null,
  storage = null,
  matchMedia = null,
}: {
  readonly root?: HTMLElement | null;
  readonly storage?: MotionStorage | null;
  readonly matchMedia?: (() => MediaQueryLike) | null;
} = {}): MotionController {
  let userMode: MotionPreference = "on";
  try {
    const stored = storage?.readUiPreferences().animations;
    if (stored === "on" || stored === "off") userMode = stored;
  } catch {
    userMode = "on";
  }
  const media = readMediaQuery(matchMedia);
  let systemReduced = media?.matches === true;
  let destroyed = false;
  const listeners = new Set<(state: MotionState) => void>();

  const current = (): MotionState => makeState(userMode, systemReduced);
  const publish = (): MotionState => {
    const next = current();
    try {
      root?.setAttribute("data-motion", next.userMode);
      root?.setAttribute("data-motion-effective", next.effective ? "on" : "off");
      root?.setAttribute("data-motion-limited", String(next.limitedBySystem));
    } catch {
      // Root projection is best effort; state remains authoritative.
    }
    for (const listener of [...listeners]) {
      try { listener(next); } catch { /* a detached consumer cannot break the shell */ }
    }
    return next;
  };
  const projectScene = (scene: SceneId): void => {
    try {
      const document = globalThis.document;
      const wallpaper = document?.querySelector<HTMLElement>("[data-wallpaper]");
      for (const id of BUILT_IN_SCENE_IDS) wallpaper?.classList.toggle(`wallpaper--${id}`, id === scene);
      wallpaper?.setAttribute("data-scene", scene);
      document?.querySelector<HTMLElement>("[data-desktop]")?.setAttribute("data-scene", scene);
    } catch {
      // A detached shell remains usable at its existing scene.
    }
  };
  const updateMode = (mode: MotionPreference): MotionState => {
    if (mode !== "on" && mode !== "off") throw new TypeError("invalid_motion_mode");
    userMode = mode;
    return publish();
  };
  const onMediaChange = (event: { readonly matches: boolean }): void => {
    if (destroyed) return;
    systemReduced = event.matches === true;
    publish();
  };
  let removeMediaListener = (): void => {};
  try {
    if (media?.addEventListener && media.removeEventListener) {
      media.addEventListener("change", onMediaChange);
      removeMediaListener = () => media.removeEventListener?.("change", onMediaChange);
    } else if (media?.addListener && media.removeListener) {
      media.addListener(onMediaChange);
      removeMediaListener = () => media.removeListener?.(onMediaChange);
    }
  } catch {
    removeMediaListener = () => {};
  }
  publish();

  const controller: MotionController = {
    getState: current,
    previewUserMode: updateMode,
    setUserMode(mode) {
      updateMode(mode);
      try {
        if (!storage) return false;
        const preferences = storage.readUiPreferences();
        return storage.writeUiPreferences({ ...preferences, animations: mode });
      } catch {
        return false;
      }
    },
    apply(preferences) {
      if (!validScene(preferences.wallpaperColor)) throw new TypeError("invalid_scene");
      const next = updateMode(preferences.animations);
      projectScene(preferences.wallpaperColor);
      return next;
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("invalid_motion_listener");
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeMediaListener();
      listeners.clear();
    },
  };
  return Object.freeze(controller);
}
