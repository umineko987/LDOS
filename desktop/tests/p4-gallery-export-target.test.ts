import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getApplicationDefinition } from "../src/core/applications/definitions";
import { resolveNavigationTarget } from "../src/core/routing/hash";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";
import exportSource from "../src/apps/export/Export.svelte?raw";
import exportServiceSource from "../src/apps/export/service.ts?raw";
import exportIntentSource from "../src/apps/export/intent.ts?raw";
import gallerySource from "../src/apps/gallery/Gallery.svelte?raw";
import galleryServiceSource from "../src/apps/gallery/service.ts?raw";

describe("P4 Gallery and Export targets", () => {
  it("keeps both gallery and export live and rejects unknown applications", () => {
    // G2-2 起图库、G6 起数据集导出均为接入真实后端的正式应用。
    expect(getApplicationDefinition("gallery").availability).toBe("ready");
    expect(getApplicationDefinition("export").availability).toBe("ready");
    expect(getApplicationDefinition("unknown-application")).toBeNull();
    expect(resolveNavigationTarget("/unknown-application")).toBeNull();
    expect(appWindowSource).toContain('record.appId === "gallery"');
    expect(appWindowSource).toContain('record.appId === "export"');
  });

  it("wires the export app to the api client instead of a preview placeholder", () => {
    expect(appWindowSource).toContain("<Export {api}");
    expect(exportSource).toContain("data-preview-availability=\"live\"");
    // 权威进度只能来自后端计数；不虚构进度条或百分比。
    expect(exportSource).not.toContain('role="progressbar"');
    expect(exportSource).not.toMatch(/\b[0-9]{1,3}%\b/);
    // 旧三栏占位的 COCO/WebDataset/分片能力不再出现。
    expect(exportSource).not.toContain("COCO");
    expect(exportSource).not.toContain("WebDataset");
    expect(exportSource).toContain("导出来源");
    expect(exportSource).toContain("创建并预检");
  });

  it("routes export transport only through the service layer with bounded views", () => {
    expect(exportServiceSource).toContain("view=desktop");
    // 组件与意图层不内联 API 路径；传输全部收敛在 service。
    expect(exportSource).not.toContain("/api/v1/");
    expect(exportIntentSource).not.toContain("/api/v1/");
  });

  it("keeps the gallery-to-export handoff as a typed pending intent", () => {
    expect(gallerySource).toContain("setPendingExportSource");
    expect(exportSource).toContain("consumePendingExportSource");
    expect(exportIntentSource).toContain("ExportSourceIntent");
  });

  it("finishes the linear placeholder switchover with no backend or timer path in views", () => {
    const placeholderPath = new URL("../src/shell/ApplicationPlaceholder.svelte", import.meta.url);
    expect(existsSync(placeholderPath)).toBe(false);
    expect(appWindowSource).not.toContain("ApplicationPlaceholder");
    expect(readFileSync(new URL("../src/styles/shell.css", import.meta.url), "utf8")).not.toContain("application-placeholder");
    expect(gallerySource.match(/createGalleryStore\s*\(/g)).toHaveLength(1);
    expect(exportSource.match(/createExportStore\s*\(/g)).toHaveLength(1);
    // 视图层保持零传输、零定时器；Gallery 与 Export 的传输只存在于 service 层。
    const viewSurfaces = [gallerySource, exportSource].join("\n");
    expect(viewSurfaces).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\/api\/v1\/|\bsetInterval\s*\(|\bsetTimeout\s*\(|WebSocket|EventSource|localStorage|sessionStorage|indexedDB/);
    expect(galleryServiceSource).toContain("GALLERY_ENDPOINTS.imports");
  });
});
