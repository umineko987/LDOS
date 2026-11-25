// 界面偏好：减少动效、密度、地图渲染器。只存在本机 localStorage，不进后端。
//
// 动效和密度通过 <html> 上的 data 属性生效（样式在 app.css）：
//   data-motion="reduced"  一律关掉动效；"full" 忽略系统的「减少动态效果」；没有属性时跟随系统。
//   data-density="comfortable"  40px 行高；没有属性时是默认的紧凑密度（32px）。
// 渲染器偏好沿用 gfx/renderer.ts 的存储键，所有画布视图共用。

import {
  parsePreference as parseRendererPreference,
  readPreference as readRendererPreference,
  RENDERER_PREFERENCES,
  writePreference as writeRendererPreference,
  type RendererPreference,
} from "#lib/gfx/renderer.ts";

/** 减少动效：system 跟随系统设置，on 总是减少，off 总是完整动效。 */
export type MotionPreference = "system" | "on" | "off";

export type Density = "compact" | "comfortable";

export interface Preferences {
  readonly motion: MotionPreference;
  readonly density: Density;
  readonly renderer: RendererPreference;
}

export const MOTION_PREFERENCES: readonly MotionPreference[] = ["system", "on", "off"];
export const DENSITIES: readonly Density[] = ["compact", "comfortable"];
export { RENDERER_PREFERENCES };

export type CollectSite = "danbooru" | "pixiv" | "twitter" | "exhentai" | "pawchive";
export const COLLECT_SITES: readonly CollectSite[] = ["danbooru", "pixiv", "twitter", "exhentai", "pawchive"];
export const COLLECT_SITES_STORAGE_KEY = "ldos.collect.sites";
export const DEFAULT_COLLECT_SITES: readonly CollectSite[] = ["danbooru"];

export const MOTION_STORAGE_KEY = "ldos.motion";
export const DENSITY_STORAGE_KEY = "ldos.density";

export const DEFAULT_PREFERENCES: Preferences = Object.freeze({ motion: "system", density: "compact", renderer: "auto" });

export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function browserStorage(): PreferenceStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function parseMotion(value: unknown): MotionPreference {
  return MOTION_PREFERENCES.find((option) => option === value) ?? DEFAULT_PREFERENCES.motion;
}

export function parseDensity(value: unknown): Density {
  return DENSITIES.find((option) => option === value) ?? DEFAULT_PREFERENCES.density;
}

function read(storage: PreferenceStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: PreferenceStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // 存储不可用（配额、隐私模式）时只在本次会话生效。
  }
}

export function readPreferences(storage: PreferenceStorage | null = browserStorage()): Preferences {
  return Object.freeze({
    motion: parseMotion(read(storage, MOTION_STORAGE_KEY)),
    density: parseDensity(read(storage, DENSITY_STORAGE_KEY)),
    renderer: readRendererPreference(storage),
  });
}

/** 只写传入的字段；值先规范化，非法值按默认值存。 */
export function writePreferences(changes: Partial<Preferences>, storage: PreferenceStorage | null = browserStorage()): void {
  if (changes.motion !== undefined) write(storage, MOTION_STORAGE_KEY, parseMotion(changes.motion));
  if (changes.density !== undefined) write(storage, DENSITY_STORAGE_KEY, parseDensity(changes.density));
  if (changes.renderer !== undefined) writeRendererPreference(parseRendererPreference(changes.renderer), storage);
}

/** 实际是否减少动效：显式选择优先，system 时看系统的 prefers-reduced-motion。 */
export function effectiveReducedMotion(motion: MotionPreference, systemReduced: boolean): boolean {
  return motion === "system" ? systemReduced : motion === "on";
}

export interface HtmlAttributes {
  readonly "data-motion": "reduced" | "full" | null;
  readonly "data-density": "comfortable" | null;
}

export function htmlAttributes(preferences: Pick<Preferences, "motion" | "density">): HtmlAttributes {
  return {
    "data-motion": preferences.motion === "on" ? "reduced" : preferences.motion === "off" ? "full" : null,
    "data-density": preferences.density === "comfortable" ? "comfortable" : null,
  };
}

/** 把偏好写到 <html> 上；值为 null 的属性移除。 */
export function applyHtmlAttributes(
  element: Pick<Element, "setAttribute" | "removeAttribute">,
  preferences: Pick<Preferences, "motion" | "density">,
): void {
  for (const [name, value] of Object.entries(htmlAttributes(preferences))) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }
}

export function normalizeCollectSites(values: unknown): CollectSite[] {
  if (!Array.isArray(values)) return [...DEFAULT_COLLECT_SITES];
  const wanted = new Set<CollectSite>();
  for (const item of values) {
    if (typeof item === "string" && (COLLECT_SITES as readonly string[]).includes(item)) {
      wanted.add(item as CollectSite);
    }
  }
  const ordered = COLLECT_SITES.filter((site) => wanted.has(site));
  return ordered.length > 0 ? ordered : [...DEFAULT_COLLECT_SITES];
}

export function parseCollectSites(raw: string | null): CollectSite[] {
  if (!raw) return [...DEFAULT_COLLECT_SITES];
  try {
    return normalizeCollectSites(JSON.parse(raw));
  } catch {
    return [...DEFAULT_COLLECT_SITES];
  }
}

export function readCollectSites(storage: PreferenceStorage | null = browserStorage()): CollectSite[] {
  return parseCollectSites(read(storage, COLLECT_SITES_STORAGE_KEY));
}

export function writeCollectSites(
  sites: readonly CollectSite[],
  storage: PreferenceStorage | null = browserStorage(),
): CollectSite[] {
  const normalized = normalizeCollectSites(sites);
  write(storage, COLLECT_SITES_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}
