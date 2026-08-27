import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import type { ApiClient } from "../src/core/api/client";
import { createPersistenceAdapter } from "../src/core/persistence/adapter";
import { createPersistenceService } from "../src/core/persistence/service";
import type { PollingService } from "../src/core/polling/service";
import { createShellStore } from "../src/core/state/shell";
import Desktop from "../src/shell/Desktop.svelte";

const componentSources = import.meta.glob<string>("../src/shell/*.svelte", {
  eager: true,
  import: "default",
  query: "?raw",
});

const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;

function runtime(options: Parameters<typeof createShellStore>[0] = {}) {
  const persistence = createPersistenceService(createPersistenceAdapter({
    localStorage: null,
    sessionStorage: null,
  }));
  const shell = createShellStore({ persistence, ...options });
  return { shell, persistence };
}

function renderDesktop(shell: ReturnType<typeof createShellStore>, persistence: ReturnType<typeof createPersistenceService>): string {
  return render(Desktop, { props: { shell, persistence, polling, api } }).body;
}

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

describe("five-layer Svelte OS shell", () => {
  it("renders Wallpaper, MenuBar, WindowLayer, ApplicationCenter, and Dock in order", () => {
    const { shell, persistence } = runtime();
    shell.openApplication("crawl");
    shell.setApplicationCenter(true);
    const body = renderDesktop(shell, persistence);
    const markers = [
      "data-wallpaper", "data-menu-bar", "data-window-layer", "data-application-center-host", "data-dock",
    ];
    expect(markers.map((marker) => body.indexOf(marker))).toEqual(
      [...markers.map((marker) => body.indexOf(marker))].toSorted((left, right) => left - right),
    );
    expect(body).toContain('data-product-contract="nocturne-glass-desktop"');
    expect(body).toContain('role="dialog" aria-modal="true"');
    expect(body).toContain("data-application-center-backdrop");
    expect(occurrences(body, "data-application-center-app=")).toBe(10);
    expect(body).toContain('data-availability="ready"');
  });

  it("does not render minimized or closed windows into the DOM", async () => {
    const { shell, persistence } = runtime();
    shell.openApplication("crawl");
    shell.openApplication("tasks");
    await shell.requestMinimize("tasks");
    const minimized = renderDesktop(shell, persistence);
    expect(minimized).toContain('data-app-id="crawl"');
    expect(minimized).not.toContain('data-app-id="tasks"');
    expect(minimized).toContain('data-dock-item="app:tasks"');
    expect(minimized).toContain('data-dock-state="minimized"');

    await shell.requestClose("crawl");
    const closed = renderDesktop(shell, persistence);
    expect(closed).not.toContain("data-app-window");
    expect(closed).toContain('data-dock-state="closed"');
  });

  it("hides Dock only for the focused visible maximized window", () => {
    const { shell, persistence } = runtime();
    shell.openApplication("review");
    const focusedMaximized = renderDesktop(shell, persistence);
    expect(focusedMaximized).toContain('data-window-workspace="maximized"');
    expect(focusedMaximized).not.toContain('data-dock=""');

    shell.openApplication("crawl");
    const backgroundMaximized = renderDesktop(shell, persistence);
    expect(backgroundMaximized).toContain('data-window-workspace="normal"');
    expect(backgroundMaximized).toContain('data-dock="" aria-label="ImageWeave Dock"');
  });

  it("uses one ARIA dialog for the unified unsaved boundary", async () => {
    const { shell, persistence } = runtime({ hasUnsavedChanges: (appId) => appId === "policy" });
    shell.openApplication("policy");
    const close = shell.requestClose("policy");
    const body = renderDesktop(shell, persistence);
    expect(body).toContain("data-shell-dialog");
    expect(body).toContain('aria-labelledby="shell-dialog-title"');
    expect(body).toContain('aria-describedby="shell-dialog-description shell-dialog-warning"');
    expect(body).toContain("放弃并关闭");
    shell.resolveConfirmation(false);
    await expect(close).resolves.toBe(false);
  });

  it("keeps keyboard, focus-return, and listener cleanup paths in the components", () => {
    const menu = componentSources["../src/shell/MenuBar.svelte"];
    const center = componentSources["../src/shell/ApplicationCenter.svelte"];
    const dock = componentSources["../src/shell/Dock.svelte"];
    const dialog = componentSources["../src/shell/Dialog.svelte"];
    const layer = componentSources["../src/shell/WindowLayer.svelte"];
    const appWindow = componentSources["../src/shell/AppWindow.svelte"];
    for (const source of [menu, center, dock, dialog]) {
      expect(source).toContain("Escape");
      expect(source).toContain("onkeydown");
      expect(source).toContain("restoreFocus");
    }
    expect(menu).toContain("ArrowDown");
    expect(menu).toContain("isActivationKey");
    expect(center).toContain("trappedTabIndex");
    expect(dialog).toContain("trappedTabIndex");
    expect(dock).toContain("ArrowLeft");
    expect(menu).toContain('removeEventListener("keydown"');
    expect(dock).toContain('removeEventListener("pointerdown"');
    expect(layer).toContain("observer?.disconnect()");
    expect(layer).toContain('removeEventListener("resize"');
    expect(appWindow).toContain('role="document"');
    expect(appWindow).not.toContain("<main");
    expect(appWindow).toContain('role="group" aria-label="窗口操作"');
  });

  it("uses explicit application branches and never accesses storage or APIs from shell views", () => {
    const joined = Object.values(componentSources).join("\n");
    expect(joined).not.toContain("ApplicationPlaceholder");
    expect(joined).not.toMatch(/\b(?:localStorage|sessionStorage|fetch|XMLHttpRequest)\b/);
    expect(joined).not.toContain("/api/v1");
    expect(joined).toContain('record.appId === "gallery"');
    expect(joined).toContain('record.appId === "export"');
  });
});
