import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

import Export from "../src/apps/export/Export.svelte";
import Gallery from "../src/apps/gallery/Gallery.svelte";
import type { ApiClient } from "../src/core/api/client";
import { getApplicationDefinition } from "../src/core/applications/definitions";
import type { PersistenceService } from "../src/core/persistence/service";
import type { PollingService } from "../src/core/polling/service";
import AppWindow from "../src/shell/AppWindow.svelte";
import exportControllerSource from "../src/apps/export/controller.ts?raw";
import exportModelSource from "../src/apps/export/model.ts?raw";
import exportSource from "../src/apps/export/Export.svelte?raw";
import exportStateSource from "../src/apps/export/state.ts?raw";
import galleryControllerSource from "../src/apps/gallery/controller.ts?raw";
import galleryModelSource from "../src/apps/gallery/model.ts?raw";
import gallerySource from "../src/apps/gallery/Gallery.svelte?raw";
import galleryStateSource from "../src/apps/gallery/state.ts?raw";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";

const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;
const persistence = Object.freeze({}) as PersistenceService;
const galleryCss = readFileSync(new URL("../src/apps/gallery/gallery.css", import.meta.url), "utf8");
const exportCss = readFileSync(new URL("../src/apps/export/export.css", import.meta.url), "utf8");

function props(appId: "gallery" | "export") {
  return {
    record: { appId, state: "normal" as const, rect: { x: 20, y: 20, w: 800, h: 560 } },
    api,
    polling,
    persistence,
    focused: true,
    onNavigate: vi.fn(),
    onFocus: vi.fn(),
    onMinimize: vi.fn(),
    onToggleMaximized: vi.fn(),
    onClose: vi.fn(),
    onBeginInteraction: vi.fn(),
    onKeyboardResize: vi.fn(),
  };
}

describe("Svelte Gallery and Export preview integration", () => {
  it("renders Gallery's live browse empty state without fake media", () => {
    const body = render(Gallery, { props: { api } }).body;
    for (const marker of [
      "data-gallery-app",
      'data-domain-owner="gallery"',
      'data-preview-availability="live"',
      "媒体浏览工作区",
      "来源与目录",
      "选择一个来源开始浏览",
      "左侧选择下载批次或导入目录",
    ]) expect(body).toContain(marker);
    expect(body).not.toMatch(/<img|role="progressbar"|data:image|blob:/);
  });

  it("renders Export's disabled three-column structure without fake jobs or progress", () => {
    const body = render(Export).body;
    for (const marker of [
      "data-export-app",
      'data-domain-owner="export"',
      'data-preview-availability="unavailable"',
      "01 · 来源",
      "02 · 配置",
      "03 · 进度与结果",
      "Manifest",
      "COCO",
      "WebDataset",
      "开始导出",
      "暂无进度事实",
      "不会自行启动导出",
      'aria-label="数据集导出三栏预览工作区；普通窗口可横向滚动"',
    ]) expect(body).toContain(marker);
    expect(body).toContain("disabled");
    expect(body).not.toMatch(/role="progressbar"|\b[0-9]{1,3}%\b|data:image|blob:/);
  });

  it("routes both preview definitions without a placeholder or generic app fallback", () => {
    expect(getApplicationDefinition("gallery").availability).toBe("ready");
    expect(getApplicationDefinition("export").availability).toBe("preview");
    expect(render(AppWindow, { props: props("gallery") }).body).toContain("data-gallery-app");
    expect(render(AppWindow, { props: props("export") }).body).toContain("data-export-app");
    expect(appWindowSource).toContain('record.appId === "gallery"');
    expect(appWindowSource).toContain('record.appId === "export"');
    expect(appWindowSource).not.toContain("ApplicationPlaceholder");
  });

  it("keeps one domain owner, guarded IO surfaces and accessible fallbacks", () => {
    expect(gallerySource.match(/createGalleryStore\s*\(/g)).toHaveLength(1);
    expect(exportSource.match(/createExportStore\s*\(/g)).toHaveLength(1);
    expect(galleryModelSource).toContain("galleryVisibleRange");
    expect(exportModelSource).toContain('phase: "unavailable"');
    const exportOnly = [exportSource, exportControllerSource, exportModelSource, exportStateSource].join("\n");
    expect(exportOnly).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\/api\/|\bsetInterval\s*\(|\bsetTimeout\s*\(|localStorage|sessionStorage|indexedDB|console\.|innerHTML|URL\.createObjectURL|new Blob/);
    // Gallery 已接入真实后端：传输只经过 service 的 api 客户端，组件与状态层保持零 IO。
    const gallerySurfaces = [gallerySource, galleryControllerSource, galleryModelSource, galleryStateSource].join("\n");
    expect(gallerySurfaces).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\bsetInterval\s*\(|localStorage|sessionStorage|indexedDB|console\.|innerHTML|URL\.createObjectURL|new Blob/);
    // Export 预览仍保持窄窗横向滚动；Gallery 已是响应式正式应用，不再钉最小宽度。
    for (const css of [galleryCss, exportCss]) {
      expect(css).toContain("@media (forced-colors: active)");
      expect(css).toContain("@media (prefers-contrast: more)");
      expect(css).toContain("@media (prefers-reduced-motion: reduce)");
      expect(css).toContain(':root[data-motion="off"]');
      expect(css).toContain(css === galleryCss ? "LinkText" : "ButtonFace");
      expect(css).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter\s*:/m);
      expect(css).not.toMatch(/^\s*filter\s*:/m);
      expect(css).not.toMatch(/@media\s*\(max-width\s*:/);
    }
    expect(exportCss).toContain("min-width: 1100px");
    expect(exportCss).toContain("overflow-x: auto");
  });
});
