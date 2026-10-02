import { BUILT_IN_SCENES, BUILT_IN_SCENE_IDS, type SceneId } from "../../core/personalization/scenes";
import type { MotionPreference, UiPreferences } from "../../core/persistence/service";

export { BUILT_IN_SCENES, BUILT_IN_SCENE_IDS };
export const PERSONALIZATION_PREFERENCE_KEYS = Object.freeze(["animations", "wallpaperColor"] as const);
export const PERSONALIZATION_DEFAULTS: UiPreferences = Object.freeze({ animations: "on", wallpaperColor: "graphite" });
export const MOTION_LIMITATION_MESSAGE = "已开启动效，但系统“减少动态效果”正在限制部分效果。";
export type PersonalizationPhase = "clean" | "dirty" | "saving" | "success" | "error";

export interface PersonalizationPresentation {
  readonly state: PersonalizationPhase;
  readonly kind: "ready" | "running" | "warning" | "error";
  readonly label: string;
  readonly message: string;
}
export interface PersonalizationPreview {
  readonly scene: Readonly<{ id: SceneId; label: string; description: string }>;
  readonly appearance: Readonly<{ tone: "dark"; toneLabel: "深色夜航玻璃"; surfaceLabel: string }>;
  readonly motion: Readonly<{ mode: MotionPreference; systemReduced: boolean; effective: boolean; limitedBySystem: boolean; statusId: "on" | "off" | "system-limited"; message: string }>;
  readonly status: Readonly<{ id: "clean" | "dirty" | "saving"; message: string; dirty: boolean; busy: boolean; committedMatchesDraft: boolean }>;
}

function descriptors(value: unknown): PropertyDescriptorMap | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? Object.getOwnPropertyDescriptors(value) : null;
  } catch { return null; }
}
function descriptorValue(map: PropertyDescriptorMap, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(map, key)?.value as PropertyDescriptor | undefined;
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}
function validScene(value: unknown): value is SceneId { return typeof value === "string" && (BUILT_IN_SCENE_IDS as readonly string[]).includes(value); }
function hasDangerousKey(map: PropertyDescriptorMap): boolean { return Reflect.ownKeys(map).some((key) => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)); }

export function projectPersonalizationPreferences(value: unknown): UiPreferences {
  const map = descriptors(value);
  if (!map || hasDangerousKey(map) || Reflect.ownKeys(map).some((key) => typeof key !== "string" || !PERSONALIZATION_PREFERENCE_KEYS.includes(key as typeof PERSONALIZATION_PREFERENCE_KEYS[number]) || !Object.hasOwn(map[key], "value"))) throw new TypeError("invalid_personalization_preferences");
  const animations = Object.hasOwn(map, "animations") ? descriptorValue(map, "animations") : PERSONALIZATION_DEFAULTS.animations;
  const wallpaperColor = Object.hasOwn(map, "wallpaperColor") ? descriptorValue(map, "wallpaperColor") : PERSONALIZATION_DEFAULTS.wallpaperColor;
  if ((animations !== "on" && animations !== "off") || !validScene(wallpaperColor)) throw new TypeError("invalid_personalization_preferences");
  return Object.freeze({ animations, wallpaperColor });
}
export function normalizePersonalizationPreferences(value: unknown): UiPreferences {
  const map = descriptors(value);
  if (!map || hasDangerousKey(map)) return PERSONALIZATION_DEFAULTS;
  const animations = descriptorValue(map, "animations");
  const wallpaperKind = descriptorValue(map, "wallpaperKind");
  const wallpaperColor = descriptorValue(map, "wallpaperColor");
  return Object.freeze({ animations: animations === "on" || animations === "off" ? animations : PERSONALIZATION_DEFAULTS.animations, wallpaperColor: wallpaperKind !== "custom" && validScene(wallpaperColor) ? wallpaperColor : PERSONALIZATION_DEFAULTS.wallpaperColor });
}
export function personalizationPreferencesEqual(left: unknown, right: unknown): boolean {
  try { const a = projectPersonalizationPreferences(left); const b = projectPersonalizationPreferences(right); return a.animations === b.animations && a.wallpaperColor === b.wallpaperColor; } catch { return false; }
}
function strictRecord(value: unknown, keys: readonly string[]): PropertyDescriptorMap {
  const map = descriptors(value);
  if (!map) throw new TypeError("invalid_personalization_record");
  const ownKeys = Reflect.ownKeys(map);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key) || !Object.hasOwn(map[key], "value"))) throw new TypeError("invalid_personalization_record");
  return map;
}
export function derivePersonalizationPreview(value: unknown): PersonalizationPreview {
  const state = strictRecord(value, ["committed", "draft", "dirty", "busy", "motion"]);
  const committed = projectPersonalizationPreferences(descriptorValue(state, "committed"));
  const draft = projectPersonalizationPreferences(descriptorValue(state, "draft"));
  const dirty = descriptorValue(state, "dirty");
  const busy = descriptorValue(state, "busy");
  if (typeof dirty !== "boolean" || typeof busy !== "boolean" || dirty !== !personalizationPreferencesEqual(committed, draft)) throw new TypeError("invalid_personalization_state");
  const motion = strictRecord(descriptorValue(state, "motion"), ["userMode", "systemReduced", "effective", "limitedBySystem"]);
  const userMode = descriptorValue(motion, "userMode");
  const systemReduced = descriptorValue(motion, "systemReduced");
  const effective = descriptorValue(motion, "effective");
  const limitedBySystem = descriptorValue(motion, "limitedBySystem");
  if ((userMode !== "on" && userMode !== "off") || userMode !== draft.animations || typeof systemReduced !== "boolean" || effective !== (draft.animations === "on" && !systemReduced) || limitedBySystem !== (draft.animations === "on" && systemReduced)) throw new TypeError("invalid_motion_state");
  const sceneDefinition = BUILT_IN_SCENES.find(({ id }) => id === draft.wallpaperColor)!;
  const scene = Object.freeze({ id: sceneDefinition.id, label: sceneDefinition.label, description: `${sceneDefinition.label}内置夜景` });
  const statusId = busy ? "saving" : dirty ? "dirty" : "clean";
  const motionStatusId = limitedBySystem ? "system-limited" : draft.animations;
  return Object.freeze({
    scene,
    appearance: Object.freeze({ tone: "dark", toneLabel: "深色夜航玻璃", surfaceLabel: "窗口使用固定低透明玻璃表面。" }),
    motion: Object.freeze({ mode: draft.animations, systemReduced, effective: effective as boolean, limitedBySystem: limitedBySystem as boolean, statusId: motionStatusId, message: limitedBySystem ? MOTION_LIMITATION_MESSAGE : draft.animations === "on" ? "界面动效已开启并生效。" : "界面动效已关闭。" }),
    status: Object.freeze({ id: statusId, message: busy ? "正在保存外观设置。" : dirty ? "有未应用的更改。" : "当前预览与已保存设置一致。", dirty, busy, committedMatchesDraft: !dirty }),
  });
}
export function derivePersonalizationPresentation({ dirty, busy, phase }: { readonly dirty: boolean; readonly busy: boolean; readonly phase: PersonalizationPhase }): PersonalizationPresentation {
  if (busy || phase === "saving") return Object.freeze({ state: "saving", kind: "running", label: "正在保存", message: "正在保存外观设置，请勿重复提交。" });
  if (phase === "error") return Object.freeze({ state: "error", kind: "error", label: "保存失败", message: "原设置保持不变；草稿仍保留，可重试。" });
  if (dirty || phase === "dirty") return Object.freeze({ state: "dirty", kind: "warning", label: "有未应用的更改", message: "正在预览工作台配色，点击“应用”保存。" });
  if (phase === "success") return Object.freeze({ state: "success", kind: "ready", label: "已保存", message: "外观设置已保存并应用到工作台。" });
  return Object.freeze({ state: "clean", kind: "ready", label: "设置已保存", message: "当前预览与已保存设置一致。" });
}
