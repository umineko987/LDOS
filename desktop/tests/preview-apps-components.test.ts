import { readFileSync } from "node:fs";

import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

import Gallery from "../src/apps/gallery/Gallery.svelte";
import type { ApiClient } from "../src/core/api/client";
import { getApplicationDefinition } from "../src/core/applications/definitions";
import type { PersistenceService } from "../src/core/persistence/service";
import type { PollingService } from "../src/core/polling/service";
import AppWindow from "../src/shell/AppWindow.svelte";
import galleryControllerSource from "../src/apps/gallery/controller.ts?raw";
import galleryModelSource from "../src/apps/gallery/model.ts?raw";
import galleryServiceSource from "../src/apps/gallery/service.ts?raw";
import gallerySource from "../src/apps/gallery/Gallery.svelte?raw";
import galleryStateSource from "../src/apps/gallery/state.ts?raw";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";

const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;
const persistence = Object.freeze({}) as PersistenceService;
const galleryCss = readFileSync(
  new URL("../src/apps/gallery/gallery.css", import.meta.url),
  "utf8",
);

function props() {
  return {
    record: {
      appId: "gallery" as const,
      state: "normal" as const,
      rect: { x: 20, y: 20, w: 800, h: 560 },
    },
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

describe("Svelte Gallery live integration", () => {
  it("renders the live browse empty state without fake media", () => {
    const body = render(Gallery, { props: { api } }).body;
    for (const marker of [
      "data-gallery-app",
      'data-domain-owner="gallery"',
      'data-preview-availability="live"',
      "媒体浏览工作区",
      "来源与目录",
      "选择一个来源开始浏览",
      "左侧选择下载批次或导入目录",
      "导入目录…",
    ]) {
      expect(body).toContain(marker);
    }
    expect(body).not.toMatch(/<img|data:image|blob:/);
  });

  it("mounts only Gallery for browse and directory export", () => {
    expect(getApplicationDefinition("gallery")?.availability).toBe("ready");
    expect(getApplicationDefinition("export")).toBeNull();
    expect(render(AppWindow, { props: props() }).body).toContain("data-gallery-app");
    expect(appWindowSource).toContain('record.appId === "gallery"');
    expect(appWindowSource).not.toContain('record.appId === "export"');
    expect(appWindowSource).not.toContain("<Export");
    expect(appWindowSource).not.toContain("ApplicationPlaceholder");
  });

  it("keeps one domain owner and guarded IO surfaces", () => {
    expect(gallerySource.match(/createGalleryStore\s*\(/g)).toHaveLength(1);
    expect(galleryModelSource).toContain("galleryVisibleRange");
    expect(galleryModelSource).toContain("sanitizeGalleryDirectoryExportOperation");
    const gallerySurfaces = [
      gallerySource,
      galleryControllerSource,
      galleryModelSource,
      galleryStateSource,
    ].join("\n");
    expect(gallerySurfaces).not.toMatch(
      /\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|console\.|innerHTML|URL\.createObjectURL|new Blob/,
    );
    expect(gallerySource).not.toContain("/api/v1/");
    expect(galleryServiceSource).toContain("view=desktop");
    expect(galleryServiceSource).toContain("GALLERY_ENDPOINTS.directoryExports");
    expect(galleryCss).toContain("@media (forced-colors: active)");
    expect(galleryCss).toContain("@media (prefers-contrast: more)");
    expect(galleryCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(galleryCss).toContain(':root[data-motion="off"]');
    expect(galleryCss).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter\s*:/m);
    expect(galleryCss).not.toMatch(/^\s*filter\s*:/m);
  });
});
