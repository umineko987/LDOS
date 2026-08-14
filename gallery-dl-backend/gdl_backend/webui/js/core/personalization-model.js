// IDs are preference facts; desktop.css is the sole source for scene colors and light wells.
export const BUILT_IN_WALLPAPER_COLOR_IDS = Object.freeze([
  "graphite",
  "slate",
  "deep-ocean",
  "forest",
  "plum-gray",
  "warm-paper",
]);

export const PERSONALIZATION_OPTIONS = Object.freeze({
  animations: Object.freeze(["on", "off"]),
  wallpaperColor: BUILT_IN_WALLPAPER_COLOR_IDS,
});

export const PERSONALIZATION_PREFERENCE_KEYS = Object.freeze([
  "animations",
  "wallpaperColor",
]);

export const PERSONALIZATION_DEFAULTS = Object.freeze({
  animations: "on",
  wallpaperColor: "graphite",
});

const OPTION_SETS = Object.freeze(Object.fromEntries(
  Object.entries(PERSONALIZATION_OPTIONS).map(([key, values]) => [key, new Set(values)]),
));
const PREFERENCE_KEY_SET = new Set(PERSONALIZATION_PREFERENCE_KEYS);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SCENE_LABELS = Object.freeze({
  graphite: "夜航石墨",
  slate: "月岩",
  "deep-ocean": "深海",
  forest: "深林",
  "plum-gray": "雾褐",
  "warm-paper": "暖夜",
});

function recordDescriptors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function sourceDescriptor(descriptors, key) {
  return descriptors
    ? Object.getOwnPropertyDescriptor(descriptors, key)?.value
    : undefined;
}

function ownDataValue(descriptors, key) {
  const descriptor = sourceDescriptor(descriptors, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function validPreference(key, value) {
  return OPTION_SETS[key].has(value);
}

/**
 * Read/migration projection. Unknown legacy fields are deliberately ignored and
 * accessors are never evaluated. A legacy custom source always returns to the
 * default graphite scene, while an independently valid motion choice survives.
 */
export function normalizePersonalizationPreferences(value) {
  const descriptors = recordDescriptors(value);
  if (!descriptors) return Object.freeze({ ...PERSONALIZATION_DEFAULTS });
  if (Reflect.ownKeys(descriptors).some((key) => (
    typeof key !== "string" || DANGEROUS_KEYS.has(key)
  ))) {
    return Object.freeze({ ...PERSONALIZATION_DEFAULTS });
  }

  const animations = ownDataValue(descriptors, "animations");
  const wallpaperKind = ownDataValue(descriptors, "wallpaperKind");
  const wallpaperColor = ownDataValue(descriptors, "wallpaperColor");
  return Object.freeze({
    animations: validPreference("animations", animations)
      ? animations
      : PERSONALIZATION_DEFAULTS.animations,
    wallpaperColor: wallpaperKind === "custom"
      ? PERSONALIZATION_DEFAULTS.wallpaperColor
      : validPreference("wallpaperColor", wallpaperColor)
        ? wallpaperColor
        : PERSONALIZATION_DEFAULTS.wallpaperColor,
  });
}

/**
 * Strict write projection. Only the current two-field schema is accepted;
 * symbols, legacy fields, unknown keys and accessor properties are rejected.
 */
export function projectPersonalizationPreferences(value) {
  const descriptors = recordDescriptors(value);
  if (!descriptors) throw new TypeError("个性化偏好必须是普通对象");

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !PREFERENCE_KEY_SET.has(key)) {
      throw new TypeError("个性化偏好包含未知字段");
    }
    const descriptor = sourceDescriptor(descriptors, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError("个性化偏好字段必须是数据值");
    }
  }

  const projected = {};
  for (const key of PERSONALIZATION_PREFERENCE_KEYS) {
    const descriptor = sourceDescriptor(descriptors, key);
    const candidate = descriptor
      ? descriptor.value
      : PERSONALIZATION_DEFAULTS[key];
    if (!validPreference(key, candidate)) {
      throw new TypeError(`个性化偏好 ${key} 无效`);
    }
    projected[key] = candidate;
  }
  return Object.freeze(projected);
}

export function isValidPersonalizationPreferences(value) {
  try {
    projectPersonalizationPreferences(value);
    return true;
  } catch {
    return false;
  }
}

export function copyPersonalizationPreferences(value) {
  return { ...normalizePersonalizationPreferences(value) };
}

export function personalizationPreferencesEqual(left, right) {
  try {
    const projectedLeft = projectPersonalizationPreferences(left);
    const projectedRight = projectPersonalizationPreferences(right);
    return PERSONALIZATION_PREFERENCE_KEYS.every(
      (key) => projectedLeft[key] === projectedRight[key],
    );
  } catch {
    return false;
  }
}

const PREVIEW_STATE_KEYS = Object.freeze([
  "committed",
  "draft",
  "dirty",
  "busy",
  "motion",
]);
const PREVIEW_MOTION_KEYS = Object.freeze([
  "userMode",
  "systemReduced",
  "effective",
  "limitedBySystem",
]);

function requireStrictRecord(value, allowedKeys, label) {
  const descriptors = recordDescriptors(value);
  if (!descriptors) throw new TypeError(`${label}必须是普通对象`);
  const allowed = new Set(allowedKeys);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== allowedKeys.length
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError(`${label}包含未知或缺失字段`);
  }
  for (const key of allowedKeys) {
    const descriptor = sourceDescriptor(descriptors, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError(`${label}字段必须是数据值`);
    }
  }
  return descriptors;
}

function requireBoolean(descriptors, key, label) {
  const value = ownDataValue(descriptors, key);
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

/**
 * Reduce runtime state to immutable, text-only view facts. No storage record,
 * local path, binary value or mutable theme token can enter this projection.
 */
export function derivePersonalizationPreview(value) {
  const state = requireStrictRecord(value, PREVIEW_STATE_KEYS, "个性化预览状态");
  const committed = projectPersonalizationPreferences(ownDataValue(state, "committed"));
  const draft = projectPersonalizationPreferences(ownDataValue(state, "draft"));
  const dirty = requireBoolean(state, "dirty", "个性化 dirty 状态");
  const busy = requireBoolean(state, "busy", "个性化 busy 状态");
  if (dirty !== !personalizationPreferencesEqual(committed, draft)) {
    throw new TypeError("个性化 dirty 状态不一致");
  }

  const motion = requireStrictRecord(
    ownDataValue(state, "motion"),
    PREVIEW_MOTION_KEYS,
    "动效预览状态",
  );
  const userMode = ownDataValue(motion, "userMode");
  if (!OPTION_SETS.animations.has(userMode)) throw new TypeError("动效预览模式无效");
  const systemReduced = requireBoolean(motion, "systemReduced", "系统减少动态效果状态");
  const effective = requireBoolean(motion, "effective", "动效生效状态");
  const limitedBySystem = requireBoolean(motion, "limitedBySystem", "动效系统限制状态");
  if (
    userMode !== draft.animations
    || effective !== (draft.animations === "on" && !systemReduced)
    || limitedBySystem !== (draft.animations === "on" && systemReduced)
  ) {
    throw new TypeError("动效预览状态不一致");
  }

  const statusId = busy ? "saving" : dirty ? "dirty" : "clean";
  const motionStatusId = limitedBySystem
    ? "system-limited"
    : draft.animations === "off"
      ? "off"
      : "on";
  const motionMessage = limitedBySystem
    ? "已开启动效，但系统“减少动态效果”正在限制部分效果。"
    : draft.animations === "off"
      ? "界面动效已关闭。"
      : "界面动效已开启并生效。";

  return Object.freeze({
    scene: Object.freeze({
      id: draft.wallpaperColor,
      label: SCENE_LABELS[draft.wallpaperColor],
      description: `${SCENE_LABELS[draft.wallpaperColor]}内置夜景`,
    }),
    appearance: Object.freeze({
      tone: "dark",
      toneLabel: "深色夜航玻璃",
      surfaceLabel: "窗口使用固定低透明玻璃表面。",
    }),
    motion: Object.freeze({
      mode: draft.animations,
      effective,
      systemReduced,
      limitedBySystem,
      statusId: motionStatusId,
      message: motionMessage,
    }),
    status: Object.freeze({
      id: statusId,
      message: busy
        ? "正在保存外观设置。"
        : dirty
          ? "有未应用的更改。"
          : "当前预览与已保存设置一致。",
      dirty,
      busy,
      committedMatchesDraft: !dirty,
    }),
  });
}

export function restoreDefaultPersonalizationPreferences() {
  return { ...PERSONALIZATION_DEFAULTS };
}
