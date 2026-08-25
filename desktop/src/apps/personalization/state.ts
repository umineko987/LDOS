import type { MotionState } from "../../core/motion/controller";
import type { UiPreferences } from "../../core/persistence/service";
import {
  PERSONALIZATION_DEFAULTS,
  derivePersonalizationPresentation,
  personalizationPreferencesEqual,
  projectPersonalizationPreferences,
  type PersonalizationPhase,
} from "./model";

export interface PersonalizationState {
  readonly committed: UiPreferences;
  readonly draft: UiPreferences;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly phase: PersonalizationPhase;
  readonly motion: MotionState;
  readonly message: string;
  readonly error: string;
  readonly presentation: ReturnType<typeof derivePersonalizationPresentation>;
}

export interface PersonalizationStore {
  subscribe(listener: (state: PersonalizationState) => void): () => void;
  getState(): PersonalizationState;
  initialize(preferences: UiPreferences, motion: MotionState): boolean;
  preview(preferences: UiPreferences, motion: MotionState, message?: string): boolean;
  beginSave(): boolean;
  commitSaved(preferences: UiPreferences, motion: MotionState, message?: string): boolean;
  fail(message: string, motion: MotionState): boolean;
  cancel(motion: MotionState, message?: string): boolean;
  setMotion(motion: MotionState): boolean;
  destroy(): void;
}

type InternalState = Omit<PersonalizationState, "dirty" | "presentation">;

function freezeState(source: InternalState): PersonalizationState {
  const committed = projectPersonalizationPreferences(source.committed);
  const draft = projectPersonalizationPreferences(source.draft);
  const dirty = !personalizationPreferencesEqual(committed, draft);
  return Object.freeze({
    ...source,
    committed,
    draft,
    dirty,
    motion: Object.freeze({ ...source.motion }),
    presentation: derivePersonalizationPresentation({
      dirty,
      busy: source.busy,
      phase: source.phase,
    }),
  });
}

export function createPersonalizationStore({
  initial = PERSONALIZATION_DEFAULTS,
}: {
  readonly initial?: UiPreferences;
} = {}): PersonalizationStore {
  const preferences = projectPersonalizationPreferences(initial);
  let state = freezeState({
    committed: preferences,
    draft: preferences,
    busy: false,
    phase: "clean",
    motion: Object.freeze({
      userMode: preferences.animations,
      systemReduced: false,
      effective: preferences.animations === "on",
      limitedBySystem: false,
    }),
    message: "设置已保存。",
    error: "",
  });
  const listeners = new Set<(value: PersonalizationState) => void>();
  let destroyed = false;

  const internal = (): InternalState => ({
    committed: state.committed,
    draft: state.draft,
    busy: state.busy,
    phase: state.phase,
    motion: state.motion,
    message: state.message,
    error: state.error,
  });
  const publish = (next: InternalState): boolean => {
    if (destroyed) return false;
    state = freezeState(next);
    for (const listener of [...listeners]) listener(state);
    return true;
  };

  const store: PersonalizationStore = {
    subscribe(listener) {
      if (destroyed) return () => {};
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    initialize(next, motion) {
      const value = projectPersonalizationPreferences(next);
      return publish({
        ...internal(),
        committed: value,
        draft: value,
        busy: false,
        phase: "clean",
        motion,
        message: "设置已保存。",
        error: "",
      });
    },
    preview(next, motion, message = "有未应用的更改。") {
      const value = projectPersonalizationPreferences(next);
      const dirty = !personalizationPreferencesEqual(state.committed, value);
      return publish({
        ...internal(),
        draft: value,
        motion,
        phase: dirty ? "dirty" : "clean",
        message,
        error: "",
      });
    },
    beginSave() {
      return !state.busy && state.dirty && publish({
        ...internal(),
        busy: true,
        phase: "saving",
        message: "正在保存外观设置，请勿重复提交。",
        error: "",
      });
    },
    commitSaved(next, motion, message = "外观设置已保存。") {
      const value = projectPersonalizationPreferences(next);
      return publish({
        ...internal(),
        committed: value,
        draft: value,
        busy: false,
        phase: "success",
        motion,
        message,
        error: "",
      });
    },
    fail(message, motion) {
      return publish({
        ...internal(),
        busy: false,
        phase: "error",
        motion,
        message,
        error: message,
      });
    },
    cancel(motion, message = "未应用的更改已取消，设置已恢复。") {
      return publish({
        ...internal(),
        draft: state.committed,
        busy: false,
        phase: "clean",
        motion,
        message,
        error: "",
      });
    },
    setMotion(motion) {
      return publish({ ...internal(), motion });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
    },
  };

  return Object.freeze(store);
}
