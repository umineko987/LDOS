import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sanitizeExportPreviewState } from "../src/apps/export/model";
import { sanitizeGalleryPreviewState } from "../src/apps/gallery/model";
import { getApplicationDefinition } from "../src/core/applications/definitions";
import { resolveNavigationTarget } from "../src/core/routing/hash";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";
import exportSource from "../src/apps/export/Export.svelte?raw";
import gallerySource from "../src/apps/gallery/Gallery.svelte?raw";
import exportControllerSource from "../src/apps/export/controller.ts?raw";
import galleryControllerSource from "../src/apps/gallery/controller.ts?raw";

describe("P4 Gallery and Export preview targets", () => {
  it("keeps preview definitions explicit while rejecting unknown applications", () => {
    expect(getApplicationDefinition("gallery").availability).toBe("preview");
    expect(getApplicationDefinition("export").availability).toBe("preview");
    expect(getApplicationDefinition("unknown-application")).toBeNull();
    expect(resolveNavigationTarget("/unknown-application")).toBeNull();
    expect(appWindowSource).toContain('record.appId === "gallery"');
    expect(appWindowSource).toContain('record.appId === "export"');
  });

  it("permits only unavailable projections and never invents media, jobs or progress", () => {
    expect(sanitizeGalleryPreviewState({ phase: "unavailable", collection: "library", query: "", sort: "newest", mode: "grid", inspectorOpen: true }).phase).toBe("unavailable");
    expect(sanitizeExportPreviewState({ phase: "unavailable" }).phase).toBe("unavailable");
    expect(() => sanitizeGalleryPreviewState({ phase: "content", collection: "library", query: "", sort: "newest", mode: "grid", inspectorOpen: true })).toThrow(TypeError);
    expect(() => sanitizeExportPreviewState({ phase: "content", progress: 100 })).toThrow(TypeError);
    expect(gallerySource).toContain("后端能力接入前不会生成示例图片、路径、计数或批次记录");
    expect(exportSource).toContain("当前不会创建作业、虚构进度、结果文件或完成状态");
    expect(exportSource).not.toContain('role="progressbar"');
  });

  it("finishes the linear placeholder switchover with no backend or timer path", () => {
    const placeholderPath = new URL("../src/shell/ApplicationPlaceholder.svelte", import.meta.url);
    expect(existsSync(placeholderPath)).toBe(false);
    expect(appWindowSource).not.toContain("ApplicationPlaceholder");
    expect(readFileSync(new URL("../src/styles/shell.css", import.meta.url), "utf8")).not.toContain("application-placeholder");
    expect(gallerySource.match(/createGalleryStore\s*\(/g)).toHaveLength(1);
    expect(exportSource.match(/createExportStore\s*\(/g)).toHaveLength(1);
    const combined = [gallerySource, exportSource, galleryControllerSource, exportControllerSource].join("\n");
    expect(combined).not.toMatch(/ApiClient|PollingService|\bfetch\s*\(|XMLHttpRequest|\/api\/|\bsetInterval\s*\(|\bsetTimeout\s*\(|WebSocket|EventSource|localStorage|sessionStorage|indexedDB/);
  });
});
