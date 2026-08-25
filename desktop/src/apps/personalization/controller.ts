import type { MotionController, MotionState } from "../../core/motion/controller";
import type { UiPreferences } from "../../core/persistence/service";
import { PERSONALIZATION_DEFAULTS, projectPersonalizationPreferences } from "./model";
import type { PersonalizationService } from "./service";
import type { PersonalizationStore } from "./state";

export interface PersonalizationController {
  activate(): void;
  deactivate(): void;
  preview(changes: Partial<UiPreferences>, message?: string): boolean;
  commit(): Promise<boolean>;
  cancel(message?: string): boolean;
  destroy(): void;
}

export function createPersonalizationController({
  store,
  service,
  motion,
}: {
  readonly store: PersonalizationStore;
  readonly service: PersonalizationService;
  readonly motion: MotionController;
}): PersonalizationController {
  let active = false;
  let destroyed = false;
  let projecting = false;
  let lifecycle = 0;
  let commitPromise: Promise<boolean> | null = null;

  const apply = (preferences: UiPreferences): MotionState => {
    projecting = true;
    try {
      return motion.apply(preferences);
    } finally {
      projecting = false;
    }
  };
  const unsubscribeMotion = motion.subscribe((state) => {
    if (!destroyed && !projecting) store.setMotion(state);
  });
  const safeRead = (): UiPreferences => {
    try {
      return projectPersonalizationPreferences(service.read());
    } catch {
      return PERSONALIZATION_DEFAULTS;
    }
  };

  const controller: PersonalizationController = {
    activate() {
      if (active || destroyed) return;
      active = true;
      const preferences = safeRead();
      store.initialize(preferences, apply(preferences));
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      lifecycle += 1;
      commitPromise = null;
      if (store.getState().dirty || store.getState().busy) {
        const preferences = store.getState().committed;
        store.cancel(apply(preferences));
      }
    },
    preview(changes, message = "有未应用的更改。") {
      if (!active || destroyed || store.getState().busy) return false;
      try {
        const next = projectPersonalizationPreferences({
          ...store.getState().draft,
          ...changes,
        });
        return store.preview(next, apply(next), message);
      } catch {
        store.fail("设置值无效，当前预览已保留。", motion.getState());
        return false;
      }
    },
    commit() {
      if (!active || destroyed) return Promise.resolve(false);
      if (commitPromise) return commitPromise;
      if (!store.beginSave()) return Promise.resolve(false);

      const operation = ++lifecycle;
      const preferences = store.getState().draft;
      let promise!: Promise<boolean>;
      promise = (async () => {
        try {
          await Promise.resolve();
          if (!active || destroyed || operation !== lifecycle) return false;
          if (!service.write(preferences)) {
            store.fail("浏览器无法保存设置，原设置未改变。", motion.getState());
            return false;
          }
          store.commitSaved(preferences, apply(preferences), "外观设置已保存。");
          return true;
        } catch {
          if (active && !destroyed && operation === lifecycle) {
            store.fail("无法保存设置，原设置未改变。", motion.getState());
          }
          return false;
        } finally {
          if (commitPromise === promise) commitPromise = null;
        }
      })();
      commitPromise = promise;
      return promise;
    },
    cancel(message = "未应用的更改已取消，设置已恢复。") {
      if (!active || destroyed) return false;
      lifecycle += 1;
      const preferences = store.getState().committed;
      return store.cancel(apply(preferences), message);
    },
    destroy() {
      if (destroyed) return;
      controller.deactivate();
      destroyed = true;
      unsubscribeMotion();
      store.destroy();
      motion.destroy();
    },
  };
  return Object.freeze(controller);
}
