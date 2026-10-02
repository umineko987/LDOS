import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

describe("compact workbench visual contract", () => {
  it("preserves six palette backgrounds and the wallpaper projection hooks without noise", () => {
    for (const scene of ["graphite", "slate", "deep-ocean", "forest", "plum-gray", "warm-paper"]) {
      expect(block(shellCss, `.wallpaper--${scene} {`)).toContain("background:");
    }
    expect(wallpaperSource).toContain("wallpaper--{scene}");
    expect(wallpaperSource).toContain("data-wallpaper data-scene={scene}");
    expect(wallpaperSource).not.toContain("data-global-noise");
    expect(shellCss).not.toMatch(/noise\.svg|wallpaper__noise/);
  });

  it("uses sans-serif, 140ms transitions, compact radii, and no decorative shadows", () => {
    expect(tokensCss).toContain("--ldos-accent: #e4b863");
    expect(block(tokensCss, ":root {")).toMatch(/font-family:[^;]*sans-serif;/);
    expect(tokensCss).toMatch(/--ldos-font-display:[^;]*sans-serif;/);
    expect(tokensCss).not.toMatch(/(?:^|[\s"',])serif["',;]|宋体|Songti|SimSun/);
    expect(tokensCss).toContain("--ldos-motion-duration: 140ms");
    expect(tokensCss).toContain("--ldos-radius-window: 12px");
    expect(tokensCss).toContain("--ldos-radius-card: 10px");
    expect(tokensCss).toContain("--ldos-radius-control: 6px");
    expect(tokensCss).toContain("--ldos-shadow-window: none");
    expect(tokensCss).toContain("--ldos-shadow-control: none");
    expect(tokensCss).toContain("color-scheme: dark");
    expect(globalCss).toContain("background: var(--ldos-background-deepest)");
  });

  it("keeps an adaptive sidebar and allows the content area to shrink", () => {
    expect(block(shellCss, ".workbench {")).toContain("grid-template-columns: 180px minmax(0, 1fr)");
    const narrow = shellCss.slice(shellCss.indexOf("@media (max-width: 1000px)"));
    expect(narrow).toContain("grid-template-columns: 80px minmax(0, 1fr)");
    expect(block(shellCss, ".workbench-main {")).toContain("min-width: 0");
    expect(block(shellCss, ".workbench-workspace {")).toContain("min-height: 0");
    expect(globalCss).not.toMatch(/desktop-size-blocker|max-width: 1179px|max-height: 719px/);
  });

  it("uses flat shell surfaces without the old window and Dock styling paths", () => {
    expect(shellCss).not.toMatch(/\.app-window|\.dock\b|data-window-interacting|data-maximized/);
    expect(shellCss).not.toMatch(/(?:-webkit-)?backdrop-filter\s*:/);
    expect(shellCss).not.toMatch(/box-shadow\s*:(?!\s*none)/);
    expect(shellCss).not.toContain("@keyframes");
    expect(shellCss).not.toMatch(/transition[^;]*(?:backdrop-filter|filter)/);
    expect(block(shellCss, ".workbench-page[hidden] {")).toContain("display: none");
    expect(block(shellCss, ".workbench-page {")).toContain("overflow: auto");
  });

  it("retains motion-off, reduced-motion, forced-colors, contrast, and keyboard focus support", () => {
    expect(globalCss).toContain(':root[data-motion="off"]');
    expect(globalCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(globalCss).toContain("transition: none !important");
    expect(globalCss).toContain("@media (forced-colors: active)");
    expect(shellCss).toContain("@media (forced-colors: active)");
    expect(tokensCss).toContain("@media (prefers-contrast: more)");
    expect(globalCss).toContain("button:focus-visible");
    expect(globalCss).toContain("outline: 3px solid Highlight !important");
  });
});
