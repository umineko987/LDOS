import { describe, expect, it } from "vitest";

import budgetContract from "../../gallery-dl-backend/tests/fixtures/webui/p0-performance-budget.json";
import { readFileSync } from "node:fs";

import wallpaperSource from "../src/shell/Wallpaper.svelte?raw";

const globalCss = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");
const shellCss = readFileSync(new URL("../src/styles/shell.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

function block(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start < 0) throw new Error(`missing_selector:${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(start, close + 1);
}

describe("night-flight glass visual contract", () => {
  it("ports the six radial light-well scenes and one global noise layer", () => {
    for (const scene of ["graphite", "slate", "deep-ocean", "forest", "plum-gray", "warm-paper"]) {
      expect(shellCss).toContain(`.wallpaper--${scene} {`);
      expect(block(shellCss, `.wallpaper--${scene} {`)).toContain("radial-gradient(");
    }
    expect(wallpaperSource.match(/data-global-noise/g)).toHaveLength(1);
    expect(block(shellCss, ".wallpaper__noise {")).toContain("opacity: 0.025");
    expect(shellCss).toContain('url("../assets/noise.svg")');
  });

  it("keeps the champagne accent, radii, glass strength, and dark root tokens", () => {
    expect(tokensCss).toContain("--imageweave-accent: #e4b863");
    expect(tokensCss).toContain("--imageweave-radius-window: 24px");
    expect(tokensCss).toContain("--imageweave-radius-control: 16px");
    expect(tokensCss).toContain("--imageweave-glass-blur-environment: 40px");
    expect(tokensCss).toContain("--imageweave-glass-blur-window: 60px");
    expect(tokensCss).toContain("--imageweave-glass-saturation: 180%");
    expect(tokensCss).toContain("color-scheme: dark");
    expect(globalCss).toContain("background: var(--imageweave-background-deepest)");
  });

  it("uses one main backdrop per visible app window and none in app internals", () => {
    const supported = shellCss.slice(shellCss.indexOf("@supports ((-webkit-backdrop-filter"), shellCss.indexOf("@supports not"));
    expect(supported).toContain(".app-window,");
    expect(supported.match(/\.app-window,/g)).toHaveLength(1);
    expect(supported).not.toMatch(/\.app-window__|\.application-placeholder|\.menu-popover__item|\.dock__item/);
    expect(shellCss).not.toMatch(/(?:\.app-window__|\.application-placeholder)[^{]*\{[^}]*backdrop-filter/s);
    expect(budgetContract.budgets.composition_idle.main_backdrops_per_visible_window_max).toBe(1);
    expect(budgetContract.budgets.composition_idle.internal_backdrops_per_application_max).toBe(0);
  });

  it("takes over the P0 direct-manipulation glass fallback", () => {
    const interaction = block(shellCss, ".app-window[data-window-interacting] {");
    expect(interaction).toContain("background: var(--imageweave-interaction-surface) !important");
    expect(interaction).toContain("transition: none !important");
    expect(interaction).toContain("backdrop-filter: none !important");
    expect(interaction).toContain("box-shadow: none !important");
  });

  it("provides no-backdrop, reduced-motion, forced-colors, and contrast fallbacks", () => {
    expect(shellCss).toContain("@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))");
    expect(shellCss).toContain("@media (forced-colors: active)");
    expect(globalCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(tokensCss).toContain("@media (prefers-contrast: more)");
    expect(globalCss).toContain("@media (forced-colors: active)");
    expect(shellCss).not.toContain("@keyframes");
    expect(shellCss).not.toMatch(/transition[^;]*(?:backdrop-filter|filter)/);
  });

  it("removes hidden surfaces from layout and enforces the 1180 by 720 minimum", () => {
    const hidden = block(shellCss, ".app-window[hidden],");
    expect(hidden).toContain("display: none !important");
    expect(hidden).toContain("backdrop-filter: none !important");
    expect(globalCss).toContain("@media (max-width: 1179px), (max-height: 719px)");
    expect(globalCss).toContain(".desktop-size-blocker");
  });
});
