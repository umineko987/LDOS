export const BUILT_IN_WALLPAPER_COLORS = Object.freeze({
  graphite: "#20242A",
  slate: "#384554",
  "deep-ocean": "#20364A",
  forest: "#294039",
  "plum-gray": "#403341",
  "warm-paper": "#E7E1D6",
});

export const BUILT_IN_WALLPAPER_COLOR_IDS = Object.freeze(
  Object.keys(BUILT_IN_WALLPAPER_COLORS),
);

export const WALLPAPER_IMAGE_LIMITS = Object.freeze({
  inputExtensions: Object.freeze(["jpg", "jpeg", "png", "webp"]),
  inputMediaTypes: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
  outputMediaTypes: Object.freeze(["image/webp", "image/png"]),
  maxInputBytes: 15 * 1024 * 1024,
  maxEdge: 4096,
  suggestedMinWidth: 320,
  suggestedMinHeight: 180,
  webpQuality: 0.88,
  version: 1,
});

export const INTERFACE_THEME_DEFAULTS = Object.freeze({
  themeAccent: "#46515D",
  themeSurface: "#F4F1EA",
});

export const INTERFACE_THEME_PREFERENCE_KEYS = Object.freeze([
  "themeAccent",
  "themeSurface",
]);

// 黑色与白色前景对底色的对比度相等时：
// (L + 0.05) / 0.05 = 1.05 / (L + 0.05)。
export const INTERFACE_THEME_TONE_LUMINANCE_THRESHOLD =
  Math.sqrt(1.05 * 0.05) - 0.05;

export function normalizeThemeHex(value) {
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    return null;
  }
  return value.toUpperCase();
}

function requireThemeHex(value) {
  const normalized = normalizeThemeHex(value);
  if (!normalized) throw new TypeError("界面主题颜色必须是六位 HEX");
  return normalized;
}

export function calculateSrgbRelativeLuminance(value) {
  const normalized = requireThemeHex(value);
  const linearChannel = (offset) => {
    const channel = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linearChannel(1)
    + 0.7152 * linearChannel(3)
    + 0.0722 * linearChannel(5)
  );
}

export function calculateThemeContrastRatio(themeAccent, themeSurface) {
  const accentLuminance = calculateSrgbRelativeLuminance(themeAccent);
  const surfaceLuminance = calculateSrgbRelativeLuminance(themeSurface);
  return (
    (Math.max(accentLuminance, surfaceLuminance) + 0.05)
    / (Math.min(accentLuminance, surfaceLuminance) + 0.05)
  );
}

export function isValidInterfaceTheme(themeAccent, themeSurface) {
  return normalizeThemeHex(themeAccent) !== null
    && normalizeThemeHex(themeSurface) !== null;
}

export function deriveInterfaceThemeTone(themeSurface) {
  return calculateSrgbRelativeLuminance(themeSurface)
    >= INTERFACE_THEME_TONE_LUMINANCE_THRESHOLD
    ? "light"
    : "dark";
}

const MASK_STRENGTHS = Object.freeze(
  Array.from({ length: 17 }, (_, index) => index * 5),
);

export const PERSONALIZATION_OPTIONS = Object.freeze({
  animations: Object.freeze(["on", "off"]),
  wallpaperKind: Object.freeze(["color", "custom"]),
  wallpaperColor: BUILT_IN_WALLPAPER_COLOR_IDS,
  wallpaperFit: Object.freeze(["cover", "contain", "stretch", "tile"]),
  wallpaperPosition: Object.freeze([
    "top-left",
    "top",
    "top-right",
    "left",
    "center",
    "right",
    "bottom-left",
    "bottom",
    "bottom-right",
  ]),
  wallpaperMaskTone: Object.freeze(["dark", "light"]),
  wallpaperMaskStrength: MASK_STRENGTHS,
  wallpaperBlur: Object.freeze(["off", "soft", "medium"]),
  windowOpacity: Object.freeze(["solid", "subtle", "soft"]),
});

const ENUM_PREFERENCE_KEYS = Object.freeze(
  Object.keys(PERSONALIZATION_OPTIONS),
);

export const PERSONALIZATION_PREFERENCE_KEYS = Object.freeze([
  ...ENUM_PREFERENCE_KEYS,
  ...INTERFACE_THEME_PREFERENCE_KEYS,
]);

export const PERSONALIZATION_DEFAULTS = Object.freeze({
  animations: "on",
  wallpaperKind: "color",
  wallpaperColor: "graphite",
  wallpaperFit: "cover",
  wallpaperPosition: "center",
  wallpaperMaskTone: "dark",
  wallpaperMaskStrength: 40,
  wallpaperBlur: "off",
  windowOpacity: "solid",
  ...INTERFACE_THEME_DEFAULTS,
});

const PREFERENCE_KEY_SET = new Set(PERSONALIZATION_PREFERENCE_KEYS);
const OPTION_SETS = Object.freeze(Object.fromEntries(
  Object.entries(PERSONALIZATION_OPTIONS).map(([key, values]) => [key, new Set(values)]),
));

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

function dataValue(descriptors, key) {
  const descriptor = sourceDescriptor(descriptors, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function validPreference(key, value) {
  return OPTION_SETS[key].has(value);
}

function freezeProjection(projected) {
  return Object.freeze(projected);
}

function normalizedThemeFromDescriptors(descriptors) {
  let invalid = false;
  const normalized = {};
  for (const key of INTERFACE_THEME_PREFERENCE_KEYS) {
    const descriptor = sourceDescriptor(descriptors, key);
    if (!descriptor) {
      normalized[key] = INTERFACE_THEME_DEFAULTS[key];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      invalid = true;
      continue;
    }
    const candidate = normalizeThemeHex(descriptor.value);
    if (!candidate) {
      invalid = true;
      continue;
    }
    normalized[key] = candidate;
  }
  if (invalid) return INTERFACE_THEME_DEFAULTS;
  return Object.freeze(normalized);
}

function projectedThemeFromDescriptors(descriptors) {
  const projected = {};
  for (const key of INTERFACE_THEME_PREFERENCE_KEYS) {
    const descriptor = sourceDescriptor(descriptors, key);
    const candidate = descriptor
      ? descriptor.value
      : INTERFACE_THEME_DEFAULTS[key];
    const normalized = normalizeThemeHex(candidate);
    if (!normalized) throw new TypeError(`个性化偏好 ${key} 无效`);
    projected[key] = normalized;
  }
  return Object.freeze(projected);
}

export function normalizePersonalizationPreferences(value) {
  const descriptors = recordDescriptors(value);
  const normalized = {};
  for (const key of ENUM_PREFERENCE_KEYS) {
    const candidate = dataValue(descriptors, key);
    normalized[key] = validPreference(key, candidate)
      ? candidate
      : PERSONALIZATION_DEFAULTS[key];
  }
  Object.assign(normalized, normalizedThemeFromDescriptors(descriptors));
  return freezeProjection(normalized);
}

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
  for (const key of ENUM_PREFERENCE_KEYS) {
    const descriptor = sourceDescriptor(descriptors, key);
    if (!descriptor) {
      projected[key] = PERSONALIZATION_DEFAULTS[key];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError("个性化偏好字段必须是数据值");
    }
    if (!validPreference(key, descriptor.value)) {
      throw new TypeError(`个性化偏好 ${key} 无效`);
    }
    projected[key] = descriptor.value;
  }
  Object.assign(projected, projectedThemeFromDescriptors(descriptors));
  return freezeProjection(projected);
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
  "customWallpaper",
  "motion",
]);

const PREVIEW_CUSTOM_KEYS = Object.freeze([
  "loading",
  "saved",
  "pending",
  "available",
  "selectedReady",
  "storageAvailable",
]);

const PREVIEW_MOTION_KEYS = Object.freeze([
  "userMode",
  "systemReduced",
  "effective",
  "limitedBySystem",
]);

const PREVIEW_WALLPAPER_LABELS = Object.freeze({
  graphite: "石墨",
  slate: "岩灰",
  "deep-ocean": "深海",
  forest: "深林",
  "plum-gray": "灰梅",
  "warm-paper": "暖纸",
});

const PREVIEW_FIT_LABELS = Object.freeze({
  cover: "填充",
  contain: "适应",
  stretch: "拉伸",
  tile: "平铺",
});

const PREVIEW_POSITION_LABELS = Object.freeze({
  "top-left": "左上",
  top: "顶部",
  "top-right": "右上",
  left: "左侧",
  center: "居中",
  right: "右侧",
  "bottom-left": "左下",
  bottom: "底部",
  "bottom-right": "右下",
});

const PREVIEW_MASK_TONE_LABELS = Object.freeze({
  dark: "深色",
  light: "浅色",
});

const PREVIEW_BLUR_LABELS = Object.freeze({
  off: "关闭（0px）",
  soft: "轻微（4px）",
  medium: "中等（10px）",
});

const PREVIEW_OPACITY_LABELS = Object.freeze({
  solid: "实色（100%）",
  subtle: "轻微透明（96%）",
  soft: "柔和透明（92%）",
});

function requireStrictBoolean(descriptors, key, label) {
  const value = dataValue(descriptors, key);
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function requireStrictRecord(value, allowedKeys, label) {
  const descriptors = recordDescriptors(value);
  if (!descriptors) throw new TypeError(`${label}必须是普通对象`);
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${label}包含未知字段`);
    }
    const descriptor = sourceDescriptor(descriptors, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError(`${label}字段必须是数据值`);
    }
  }
  for (const key of allowedKeys) {
    if (!sourceDescriptor(descriptors, key)) throw new TypeError(`${label}缺少字段`);
  }
  return descriptors;
}

function previewCustomStatus(custom) {
  if (custom.loading) {
    return Object.freeze({
      statusId: "loading",
      message: "正在检查浏览器中已保存的本地壁纸。",
    });
  }
  if (custom.pending) {
    return Object.freeze({
      statusId: "pending",
      message: "本地图片正在桌面预览；点击“应用”后保存。",
    });
  }
  if (custom.saved) {
    return Object.freeze({
      statusId: "saved",
      message: "已保存的本地图片正在桌面预览。",
    });
  }
  if (!custom.storageAvailable) {
    return Object.freeze({
      statusId: "unavailable",
      message: "本地壁纸存储不可用；可以临时预览新图片。",
    });
  }
  return Object.freeze({
    statusId: "empty",
    message: "尚无可显示的本地图片。",
  });
}

/**
 * 将运行时状态压缩为视图可消费的严格事实。此投影不接受也不返回
 * Blob、Object URL、文件名、路径、EXIF 或任意错误正文。
 */
export function derivePersonalizationPreview(value) {
  const state = requireStrictRecord(value, PREVIEW_STATE_KEYS, "个性化预览状态");
  const committed = projectPersonalizationPreferences(dataValue(state, "committed"));
  const draft = projectPersonalizationPreferences(dataValue(state, "draft"));
  const dirty = requireStrictBoolean(state, "dirty", "个性化 dirty 状态");
  const busy = requireStrictBoolean(state, "busy", "个性化 busy 状态");

  const customDescriptors = requireStrictRecord(
    dataValue(state, "customWallpaper"),
    PREVIEW_CUSTOM_KEYS,
    "本地壁纸预览状态",
  );
  const custom = Object.freeze(Object.fromEntries(
    PREVIEW_CUSTOM_KEYS.map((key) => [
      key,
      requireStrictBoolean(customDescriptors, key, `本地壁纸 ${key} 状态`),
    ]),
  ));
  if (custom.selectedReady && !custom.pending && !custom.saved) {
    throw new TypeError("本地壁纸预览状态不一致");
  }

  const motionDescriptors = requireStrictRecord(
    dataValue(state, "motion"),
    PREVIEW_MOTION_KEYS,
    "动效预览状态",
  );
  const motionUserMode = dataValue(motionDescriptors, "userMode");
  if (!PERSONALIZATION_OPTIONS.animations.includes(motionUserMode)) {
    throw new TypeError("动效预览模式无效");
  }
  for (const key of PREVIEW_MOTION_KEYS.slice(1)) {
    requireStrictBoolean(motionDescriptors, key, `动效 ${key} 状态`);
  }
  const systemReduced = dataValue(motionDescriptors, "systemReduced");
  const effective = dataValue(motionDescriptors, "effective");
  const limitedBySystem = dataValue(motionDescriptors, "limitedBySystem");
  if (limitedBySystem !== (draft.animations === "on" && systemReduced)) {
    throw new TypeError("动效系统限制状态不一致");
  }

  const customStatus = previewCustomStatus(custom);
  const wallpaperLabel = draft.wallpaperKind === "custom"
    ? "本地图片"
    : PREVIEW_WALLPAPER_LABELS[draft.wallpaperColor];
  const tone = deriveInterfaceThemeTone(draft.themeSurface);
  const statusId = busy ? "saving" : dirty ? "dirty" : "clean";
  const statusMessage = busy
    ? "正在处理外观设置。"
    : dirty
      ? "有未应用的更改。"
      : "当前预览与已保存设置一致。";
  const motionStatusId = limitedBySystem
    ? "system-limited"
    : draft.animations === "off"
      ? "off"
      : "on";
  const motionMessage = limitedBySystem
    ? "已开启动效，但系统“减少动态效果”正在限制部分效果。"
    : draft.animations === "off"
      ? "界面动效已关闭。"
      : effective
        ? "界面动效已开启并生效。"
        : "界面动效已开启，当前效果不可用。";

  return Object.freeze({
    theme: Object.freeze({
      accentHex: draft.themeAccent,
      surfaceHex: draft.themeSurface,
      tone,
      toneLabel: tone === "dark" ? "深色界面" : "浅色界面",
    }),
    wallpaper: Object.freeze({
      kind: draft.wallpaperKind,
      colorId: draft.wallpaperColor,
      label: wallpaperLabel,
      fitId: draft.wallpaperFit,
      fitLabel: PREVIEW_FIT_LABELS[draft.wallpaperFit],
      positionId: draft.wallpaperPosition,
      positionLabel: PREVIEW_POSITION_LABELS[draft.wallpaperPosition],
      maskToneId: draft.wallpaperMaskTone,
      maskToneLabel: PREVIEW_MASK_TONE_LABELS[draft.wallpaperMaskTone],
      maskStrength: draft.wallpaperMaskStrength,
      blurId: draft.wallpaperBlur,
      blurLabel: PREVIEW_BLUR_LABELS[draft.wallpaperBlur],
    }),
    window: Object.freeze({
      opacityId: draft.windowOpacity,
      opacityLabel: PREVIEW_OPACITY_LABELS[draft.windowOpacity],
      readabilityLabel: draft.windowOpacity === "solid"
        ? "窗口使用实色表面，文字可读性最高。"
        : "窗口保持受控透明度，强制颜色模式会自动使用实色。",
    }),
    motion: Object.freeze({
      mode: draft.animations,
      effective,
      systemReduced,
      limitedBySystem,
      statusId: motionStatusId,
      message: motionMessage,
    }),
    custom: customStatus,
    status: Object.freeze({
      id: statusId,
      message: statusMessage,
      dirty,
      busy,
      committedMatchesDraft: personalizationPreferencesEqual(committed, draft),
    }),
  });
}

export function restoreDefaultPersonalizationPreferences() {
  return { ...PERSONALIZATION_DEFAULTS };
}
