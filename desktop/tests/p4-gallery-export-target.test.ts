import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sanitizeExportPreviewState } from "../src/apps/export/model";
import { getApplicationDefinition } from "../src/core/applications/definitions";
import { resolveNavigationTarget } from "../src/core/routing/hash";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";
import exportSource from "../src/apps/export/Export.svelte?raw";
import gallerySource from "../src/apps/gallery/Gallery.svelte?raw";
import exportControllerSource from "../src/apps/export/controller.ts?raw";

describe("P4 Gallery and Export targets", () => {
  it("keeps gallery live, export preview and rejects unknown applications", () => {
    // G2-2 起图库是接入真实后端的正式应用；导出预览保持到 G6。
    expect(getApplicationDefinition("gallery").availability).toBe("ready");
    expect(getApplicationDefinition("export").availability).toBe("preview");
    expect(getApplicationDefinition("unknown-application")).toBeNull();
    expect(resolveNavigationTarget("/unknown-application")).toBeNull();
    expect(appWindowSource).toContain('record.appId === "gallery"');
    expect(appWindowSource).toContain('record.appId === "export"');
  });

  it("permits only unavailable export projections and never invents jobs or progress", () => {
    expect(sanitizeExportPreviewState({ phase: "unavailable" }).phase).toBe("unavailable");
    expect(() => sanitizeExportPreviewState({ phase: "content", progress: 100 })).toThrow(TypeError);
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
    // 预览面（Export）保持零传输、零定时器；Gallery 的传输只存在于 service 层。
    const exportSurfaces = [exportSource, exportControllerSource].join("\n");
    expect(exportSurfaces).not.toMatch(/ApiClient|PollingService|\bfetch\s*\(|XMLHttpRequest|\/api\/|\bsetInterval\s*\(|\bsetTimeout\s*\(|WebSocket|EventSource|localStorage|sessionStorage|indexedDB/);
    expect(gallerySource).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\bsetInterval\s*\(|localStorage|sessionStorage|indexedDB/);
  });
});
