import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import Personalization from "../src/apps/personalization/Personalization.svelte";
import AppWindow from "../src/shell/AppWindow.svelte";
import type { PersistenceService } from "../src/core/persistence/service";
import type { ApiClient } from "../src/core/api/client";
import type { PollingService } from "../src/core/polling/service";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";
import personalizationSource from "../src/apps/personalization/Personalization.svelte?raw";
import controllerSource from "../src/apps/personalization/controller.ts?raw";
import modelSource from "../src/apps/personalization/model.ts?raw";
import stateSource from "../src/apps/personalization/state.ts?raw";
import serviceSource from "../src/apps/personalization/service.ts?raw";

const persistence = { readUiPreferences: () => ({ animations: "on" as const, wallpaperColor: "graphite" as const }), writeUiPreferences: () => true } as unknown as PersistenceService;
const props = { record: { appId: "personalization" as const, state: "normal" as const, rect: { x: 20, y: 20, w: 800, h: 560 } }, api: Object.freeze({}) as ApiClient, polling: Object.freeze({}) as PollingService, persistence, focused: true, onNavigate: vi.fn(), onFocus: vi.fn(), onMinimize: vi.fn(), onToggleMaximized: vi.fn(), onClose: vi.fn(), onBeginInteraction: vi.fn(), onKeyboardResize: vi.fn() };
const css = readFileSync(new URL("../src/apps/personalization/personalization.css", import.meta.url), "utf8");

describe("Svelte Personalization integration", () => {
  it("renders the real accessible three-column workspace", () => {
    const body = render(Personalization, { props: { persistence } }).body;
    for (const marker of ["data-personalization-app", 'data-domain-owner="personalization"', "01 · 场景", "02 · 动效", "03 · 应用", "内置夜景场景", "开启动效", "深色夜航玻璃", "恢复默认", 'aria-live="polite"', 'aria-label="外观设置三栏工作区，可横向滚动查看场景、动效与应用预览"', "desktop-wallpaper--graphite"]) expect(body).toContain(marker);
    expect((body.match(/type="radio"/g) ?? [])).toHaveLength(8);
    expect(body).not.toContain('type="color"');
    expect(body).not.toContain('type="file"');
    expect(body).not.toContain("应用迁移将在后续阶段接入");
  });
  it("routes Personalization through the one AppWindow branch", () => {
    const body = render(AppWindow, { props }).body;
    expect(body).toContain("data-personalization-app");
    expect(appWindowSource).toContain('record.appId === "personalization"');
    expect(appWindowSource).toContain("<Personalization {persistence} registerUnsavedChanges=");
    expect(appWindowSource.match(/<ApplicationPlaceholder/g)).toHaveLength(1);
  });
  it("keeps the two-field preference path, dirty lifecycle and flat CSS boundary", () => {
    expect(personalizationSource).toContain("registerUnsavedChanges");
    expect(personalizationSource).toContain("beforeunload");
    expect(personalizationSource).toContain("sceneCanvasClass");
    expect(personalizationSource).toContain("scrollWorkspace");
    expect(personalizationSource).toContain("snapshot.dirty || snapshot.busy");
    expect(personalizationSource.match(/createPersonalizationStore\s*\(/g)).toHaveLength(1);
    expect(modelSource).toContain("PERSONALIZATION_PREFERENCE_KEYS");
    expect(stateSource).toContain("committed: UiPreferences");
    expect(controllerSource).not.toMatch(/fetch\s*\(|setInterval\s*\(|localStorage|sessionStorage|indexedDB|console\./);
    expect(serviceSource).not.toMatch(/\/api\//);
    expect(css).toContain("min-width: 1120px");
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("@media (prefers-contrast: more)");
    expect(css).toContain("ButtonFace");
    expect(css).toContain(':root[data-motion="off"]');
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect((css.match(/transition: none !important/g) ?? [])).toHaveLength(3);
    expect(css).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter\s*:/m);
    expect(css).not.toMatch(/^\s*filter\s*:/m);
    expect(css).not.toMatch(/@media\s*\(max-width\s*:/);
  });
});
