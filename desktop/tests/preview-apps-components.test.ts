import { readFileSync } from "node:fs";

import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import Gallery from "../src/apps/gallery/Gallery.svelte";
import type { ApiClient } from "../src/core/api/client";
import { getApplicationDefinition } from "../src/core/applications/definitions";
import Desktop from "../src/shell/Desktop.svelte";
import { createDesktopRuntime } from "./fixtures/desktop";
import galleryControllerSource from "../src/apps/gallery/controller.ts?raw";
import galleryModelSource from "../src/apps/gallery/model.ts?raw";
import galleryServiceSource from "../src/apps/gallery/service.ts?raw";
import gallerySource from "../src/apps/gallery/Gallery.svelte?raw";
import galleryStateSource from "../src/apps/gallery/state.ts?raw";
import desktopSource from "../src/shell/Desktop.svelte?raw";

const api = Object.freeze({}) as ApiClient;
const galleryCss = readFileSync(
  new URL("../src/apps/gallery/gallery.css", import.meta.url),
  "utf8",
);


describe("Svelte Gallery live integration", () => {
  it("renders the live browse empty state without fake media", () => {
    const body = render(Gallery, { props: { api } }).body;
    for (const marker of [
      "data-gallery-app",
      'data-domain-owner="gallery"',
      'data-preview-availability="live"',
      'tabindex="-1">图库</h1>',
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
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("gallery");
    const body = render(Desktop, { props: runtime }).body;
    expect(body).toContain('data-app-page="" data-app-id="gallery"');
    expect(body).toContain("data-gallery-app");
    expect(desktopSource).toContain('appId === "gallery"');
    expect(desktopSource).not.toContain('appId === "export"');
    expect(desktopSource).not.toContain("<Export");
    expect(desktopSource).not.toContain("ApplicationPlaceholder");
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
    expect(galleryCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(galleryCss).toContain(':root[data-motion="off"]');
    // Only the small selection dock may blur; never the image canvas or grid.
    expect(galleryCss.match(/\bbackdrop-filter\s*:/g)).toHaveLength(1);
    expect(galleryCss).toMatch(/\.gallery-selection-bar\s*\{[^}]*backdrop-filter:\s*blur\(16px\)/);
    expect(galleryCss).not.toMatch(/^\s*filter\s*:/m);
  });
});
