import {
  copyPersonalizationPreferences,
  normalizePersonalizationPreferences,
  personalizationPreferencesEqual,
  projectPersonalizationPreferences,
} from "./personalization-model.js";

export const WALLPAPER_COLOR_CLASSES = Object.freeze({
  graphite: "desktop-wallpaper--graphite",
  slate: "desktop-wallpaper--slate",
  "deep-ocean": "desktop-wallpaper--deep-ocean",
  forest: "desktop-wallpaper--forest",
  "plum-gray": "desktop-wallpaper--plum-gray",
  "warm-paper": "desktop-wallpaper--warm-paper",
});

function readPreferences(storage) {
  try {
    return normalizePersonalizationPreferences(storage?.readUiPreferences?.());
  } catch {
    return normalizePersonalizationPreferences(null);
  }
}

function applyScene(wallpaper, sceneId) {
  const selectedClass = WALLPAPER_COLOR_CLASSES[sceneId];
  if (!selectedClass) throw new TypeError("桌面场景 ID 无效");
  try {
    for (const className of Object.values(WALLPAPER_COLOR_CLASSES)) {
      wallpaper?.classList?.toggle?.(className, className === selectedClass);
    }
  } catch {
    // The base graphite background remains the startup-safe fallback.
  }
}

function previewMotion(motion, mode) {
  try {
    motion?.previewUserMode?.(mode);
  } catch {
    // A motion adapter failure must not make the desktop unavailable.
  }
}

function readMotionState(motion, userMode) {
  let systemReduced = false;
  try {
    systemReduced = motion?.getState?.()?.systemReduced === true;
  } catch {
    systemReduced = false;
  }
  return Object.freeze({
    userMode,
    systemReduced,
    effective: userMode === "on" && !systemReduced,
    limitedBySystem: userMode === "on" && systemReduced,
  });
}

function operationResult(ok, code, message, state) {
  return Object.freeze({ ok, code, message, state });
}

export function createPersonalizationRuntime({
  wallpaper = globalThis.document?.querySelector?.("[data-desktop-wallpaper]") ?? null,
  storage = null,
  motion = null,
} = {}) {
  let committed = copyPersonalizationPreferences(readPreferences(storage));
  let draft = copyPersonalizationPreferences(committed);
  let busy = false;
  let destroyed = false;
  let lifecycleVersion = 0;
  const listeners = new Set();

  const getState = () => Object.freeze({
    committed: Object.freeze({ ...committed }),
    draft: Object.freeze({ ...draft }),
    dirty: !personalizationPreferencesEqual(committed, draft),
    busy,
    motion: readMotionState(motion, draft.animations),
  });

  const publish = () => {
    const state = getState();
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // A detached view listener cannot affect the global preference state.
      }
    }
    return state;
  };

  const applyDraft = () => {
    applyScene(wallpaper, draft.wallpaperColor);
    previewMotion(motion, draft.animations);
  };

  const requireActive = () => {
    if (destroyed) throw new Error("个性化运行时已销毁");
  };

  const persistPreferences = (preferences) => {
    try {
      return storage?.writePersonalizationPreferences?.(preferences) === true;
    } catch {
      return false;
    }
  };

  applyDraft();

  let unsubscribeMotion = () => {};
  try {
    if (typeof motion?.subscribe === "function") {
      unsubscribeMotion = motion.subscribe(() => {
        if (!destroyed) publish();
      });
      if (typeof unsubscribeMotion !== "function") unsubscribeMotion = () => {};
    }
  } catch {
    unsubscribeMotion = () => {};
  }

  return Object.freeze({
    getState,
    ready() {
      return Promise.resolve(getState());
    },
    preview(preferences) {
      requireActive();
      if (busy) throw new Error("外观设置正在保存");
      const next = copyPersonalizationPreferences(
        projectPersonalizationPreferences(preferences),
      );
      if (personalizationPreferencesEqual(next, draft)) return getState();
      draft = next;
      applyDraft();
      return publish();
    },
    async commit() {
      requireActive();
      const initial = getState();
      if (!initial.dirty) {
        return operationResult(true, "unchanged", "当前没有待应用更改。", initial);
      }
      if (busy) {
        return operationResult(false, "busy", "外观设置正在保存。", initial);
      }

      busy = true;
      lifecycleVersion += 1;
      const operationVersion = lifecycleVersion;
      const preferencesToCommit = copyPersonalizationPreferences(draft);
      publish();
      await Promise.resolve();

      if (destroyed || operationVersion !== lifecycleVersion) {
        busy = false;
        return operationResult(false, "cancelled", "保存已取消。", getState());
      }
      if (!persistPreferences(preferencesToCommit)) {
        busy = false;
        const state = publish();
        return operationResult(
          false,
          "preference_storage_unavailable",
          "浏览器无法保存设置，原设置未改变。",
          state,
        );
      }

      committed = copyPersonalizationPreferences(preferencesToCommit);
      draft = copyPersonalizationPreferences(preferencesToCommit);
      busy = false;
      applyDraft();
      const state = publish();
      return operationResult(true, "saved", "外观设置已保存。", state);
    },
    cancel() {
      requireActive();
      if (busy) lifecycleVersion += 1;
      busy = false;
      draft = copyPersonalizationPreferences(committed);
      applyDraft();
      return publish();
    },
    subscribe(listener) {
      requireActive();
      if (typeof listener !== "function") throw new TypeError("个性化监听器必须是函数");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      lifecycleVersion += 1;
      busy = false;
      draft = copyPersonalizationPreferences(committed);
      applyDraft();
      destroyed = true;
      try {
        unsubscribeMotion();
      } catch {
        // Page teardown remains best-effort.
      }
      listeners.clear();
    },
  });
}
