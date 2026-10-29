import {
  applyHtmlAttributes,
  browserStorage,
  effectiveReducedMotion,
  readPreferences,
  writePreferences,
  type Density,
  type MotionPreference,
} from "./prefs.ts";
import type { RendererPreference } from "#lib/gfx/renderer.ts";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 界面偏好，作为响应式状态。根布局调用一次 `prefs.sync()`，之后每次 set 都会
 * 写 localStorage 并更新 <html> 上的 data 属性。
 *
 * 其他代码这样读：`prefs.reducedMotion`（已合并系统设置）、`prefs.density`、`prefs.renderer`。
 */
class PreferencesState {
  motion = $state<MotionPreference>("system");
  density = $state<Density>("compact");
  renderer = $state<RendererPreference>("auto");
  systemReducedMotion = $state(false);

  #media: MediaQueryList | null = null;

  constructor() {
    this.#load();
  }

  /** 实际是否减少动效：画布动画、滚动定位这类 JS 动效看它。 */
  get reducedMotion(): boolean {
    return effectiveReducedMotion(this.motion, this.systemReducedMotion);
  }

  /** 重新读存储、应用到 <html>，并开始跟随系统的减少动效设置。可重复调用。 */
  sync(): void {
    this.#load();
    this.#apply();
    if (this.#media || typeof globalThis.matchMedia !== "function") return;
    this.#media = globalThis.matchMedia(REDUCED_MOTION_QUERY);
    this.systemReducedMotion = this.#media.matches;
    this.#media.addEventListener("change", (event) => {
      this.systemReducedMotion = event.matches;
    });
  }

  setMotion(next: MotionPreference): void {
    this.motion = next;
    writePreferences({ motion: next }, browserStorage());
    this.#apply();
  }

  setDensity(next: Density): void {
    this.density = next;
    writePreferences({ density: next }, browserStorage());
    this.#apply();
  }

  setRenderer(next: RendererPreference): void {
    this.renderer = next;
    writePreferences({ renderer: next }, browserStorage());
  }

  #load(): void {
    const stored = readPreferences(browserStorage());
    this.motion = stored.motion;
    this.density = stored.density;
    this.renderer = stored.renderer;
  }

  #apply(): void {
    if (typeof document === "undefined") return;
    applyHtmlAttributes(document.documentElement, { motion: this.motion, density: this.density });
  }
}

export const prefs = new PreferencesState();
