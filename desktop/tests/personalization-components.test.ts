import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import Personalization from "../src/apps/personalization/Personalization.svelte";
import Desktop from "../src/shell/Desktop.svelte";
import { createDesktopRuntime } from "./fixtures/desktop";
import type { PersistenceService } from "../src/core/persistence/service";
import desktopSource from "../src/shell/Desktop.svelte?raw";
import personalizationSource from "../src/apps/personalization/Personalization.svelte?raw";
import controllerSource from "../src/apps/personalization/controller.ts?raw";
import modelSource from "../src/apps/personalization/model.ts?raw";
import stateSource from "../src/apps/personalization/state.ts?raw";
import serviceSource from "../src/apps/personalization/service.ts?raw";

const persistence = { readUiPreferences: () => ({ animations: "on" as const, wallpaperColor: "graphite" as const }), writeUiPreferences: () => true } as unknown as PersistenceService;
const css = readFileSync(new URL("../src/apps/personalization/personalization.css", import.meta.url), "utf8");

describe("Svelte Personalization integration", () => {
  it("renders six palettes, motion controls, workbench preview, and apply actions", () => {
    const body = render(Personalization, { props: { persistence } }).body;
    for (const marker of ["data-personalization-app", 'data-domain-owner="personalization"', '<h1 id="personalization-heading">外观</h1>', "工作台配色", "界面动效", "开启动效", "关闭动效", "工作台预览", "恢复默认", "应用", "取消", 'aria-live="polite"', 'aria-label="外观设置；可纵向滚动"', "wallpaper--graphite", "personalization-preview-sidebar", "personalization-preview-content"]) expect(body).toContain(marker);
    expect((body.match(/type="radio"/g) ?? [])).toHaveLength(8);
    expect(body).not.toContain('type="color"');
    expect(body).not.toContain('type="file"');
    expect(body).not.toContain("应用迁移将在后续阶段接入");
  });
  it("mounts Personalization in Desktop and registers its dirty boundary", () => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("personalization");
    const body = render(Desktop, { props: runtime }).body;
    expect(body).toContain('data-app-page="" data-app-id="personalization"');
    expect(body).toContain("data-personalization-app");
    expect(desktopSource).toContain('<Personalization {persistence} registerUnsavedChanges=');
    expect(desktopSource).toContain('shell.registerUnsavedChanges("personalization", reader, discard)');
  });
  it.each(["graphite", "slate", "deep-ocean", "forest", "plum-gray", "warm-paper"] as const)("projects %s to the workbench, wallpaper, and appearance preview", (scene) => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("personalization");
    const themedPersistence = {
      ...runtime.persistence,
      readUiPreferences: () => ({ animations: "on" as const, wallpaperColor: scene }),
    };
    const body = render(Desktop, { props: { ...runtime, persistence: themedPersistence } }).body;
    const workbench = body.match(/<div\b[^>]*\bdata-desktop\b[^>]*>/)?.[0];
    const wallpaper = body.match(/<div\b[^>]*\bdata-wallpaper\b[^>]*>/)?.[0];
    expect(workbench).toContain(`data-scene="${scene}"`);
    expect(wallpaper).toContain(`wallpaper--${scene}`);
    expect(wallpaper).toContain(`data-scene="${scene}"`);
    expect(body).toContain(`class="personalization-preview-desktop wallpaper--${scene}"`);
    const choices = body.match(/<label\b[^>]*\bdata-personalization-scene="[^"]+"[^>]*>/g) ?? [];
    expect(choices).toHaveLength(6);
    const selected = choices.filter((choice) => choice.includes('data-personalization-selected="true"'));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain(`data-personalization-scene="${scene}"`);
  });
  it("keeps the two-field preference path, dirty lifecycle and flat CSS boundary", () => {
    expect(personalizationSource).toContain("registerUnsavedChanges");
    expect(personalizationSource).toContain("beforeunload");
    expect(personalizationSource).toContain("sceneCanvasClass");
    expect(personalizationSource).not.toMatch(/preview-window|preview-dock|scrollWorkspace/);
    expect(personalizationSource).toContain("snapshot.dirty || snapshot.busy");
    expect(personalizationSource.match(/createPersonalizationStore\s*\(/g)).toHaveLength(1);
    expect(modelSource).toContain("PERSONALIZATION_PREFERENCE_KEYS");
    expect(stateSource).toContain("committed: UiPreferences");
    expect(controllerSource).not.toMatch(/fetch\s*\(|setInterval\s*\(|localStorage|sessionStorage|indexedDB|console\./);
    expect(serviceSource).not.toMatch(/\/api\//);
    expect(css).toContain("min-width: 0");
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("CanvasText");
    expect(css).toContain("Highlight");
    expect(css).toContain(':root[data-motion="off"]');
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("transition: none !important");
    expect(css).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter\s*:/m);
    expect(css).not.toMatch(/^\s*filter\s*:/m);
    expect(css).toContain("@container (max-width: 900px)");
  });
});
