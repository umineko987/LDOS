import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getApplicationDefinition } from "../src/core/applications/definitions";
import { resolveNavigationTarget } from "../src/core/routing/hash";
import gallerySource from "../src/apps/gallery/Gallery.svelte?raw";
import galleryServiceSource from "../src/apps/gallery/service.ts?raw";
import platformAdapterSource from "../src/core/platform/adapter.ts?raw";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";

describe("P4 single Gallery directory-export target", () => {
  it("keeps Gallery live while removing the independent Export route and mount", () => {
    expect(getApplicationDefinition("gallery")?.availability).toBe("ready");
    expect(getApplicationDefinition("export")).toBeNull();
    expect(resolveNavigationTarget("/export")).toBeNull();
    expect(resolveNavigationTarget("/unknown-application")).toBeNull();
    expect(appWindowSource).toContain('record.appId === "gallery"');
    expect(appWindowSource).not.toContain('record.appId === "export"');
    expect(appWindowSource).not.toContain("apps/export/Export.svelte");
  });

  it("owns selection, target, progress and cancellation inside Gallery", () => {
    expect(gallerySource).toContain("data-gallery-directory-export");
    expect(gallerySource).toContain("导出完整目录");
    expect(gallerySource).toContain("startDirectoryExport");
    expect(gallerySource).toContain("getDirectoryExport");
    expect(gallerySource).toContain("cancelDirectoryExport");
    expect(gallerySource).toContain('selectPlatformDirectory("export_target")');
    expect(gallerySource).toContain("revealInFileManager");
    expect(gallerySource).not.toContain("setPendingExportSource");
    expect(gallerySource).not.toContain("consumePendingExportSource");
  });

  it("routes the bounded operation transport only through the Gallery service", () => {
    expect(gallerySource).not.toContain("/api/v1/");
    expect(galleryServiceSource).toContain('directoryExports: "/api/v1/gallery/directory-exports"');
    expect(galleryServiceSource).toContain("view=desktop");
    expect(galleryServiceSource).toContain("idempotencyKey: true");
    expect(galleryServiceSource).not.toContain("/api/v1/dataset-exports");
    expect(platformAdapterSource).toContain('"gallery_import" | "gallery_relink" | "export_target"');
  });

  it("has no legacy Export source tree or pending-intent bridge", () => {
    expect(existsSync(new URL("../src/apps/export", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../src/apps/export/intent.ts", import.meta.url))).toBe(false);
  });
});
