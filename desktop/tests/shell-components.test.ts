import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import About from "../src/shell/About.svelte";
import aboutSource from "../src/shell/About.svelte?raw";
import Desktop from "../src/shell/Desktop.svelte";
import desktopSource from "../src/shell/Desktop.svelte?raw";
import { createDesktopRuntime } from "./fixtures/desktop";

const componentSources = import.meta.glob<string>("../src/shell/*.svelte", {
  eager: true,
  import: "default",
  query: "?raw",
});

function pageTags(body: string): string[] {
  return body.match(/<section\b[^>]*\bdata-app-page\b[^>]*>/g) ?? [];
}

describe("single-content Svelte workbench", () => {
  it("renders four primary entries and Settings without OS nodes", () => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("crawl");
    const body = render(Desktop, { props: runtime }).body;
    const nav = body.match(/<nav[^>]*aria-label="主导航"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    expect(nav).toBeDefined();
    expect(nav?.match(/data-nav-app="([^"]+)"/g)).toEqual([
      'data-nav-app="crawl"', 'data-nav-app="tasks"', 'data-nav-app="gallery"', 'data-nav-app="review"',
    ]);
    for (const label of ["采集", "批次", "图库", "去重"]) expect(nav).toContain(`<span>${label}</span>`);
    expect(body).toContain("data-nav-settings");
    expect(body).toContain("<span>设置</span>");
    expect(body).toContain('data-nav-app="crawl" aria-current="page"');
    expect(body).toContain("data-desktop");
    expect(body).toContain("data-workbench");
    expect(body).toContain("data-wallpaper");
    expect(body.match(/\bdata-workspace\b/g)).toHaveLength(1);
    for (const marker of ["data-menu-bar", "data-window-layer", "data-app-window", "data-application-center", "data-dock", "data-shell-dialog", "data-maximized"]) {
      expect(body).not.toContain(marker);
    }
  });

  it.each(["crawl", "tasks", "gallery", "review"] as const)("keeps one main landmark when %s is open", (appId) => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication(appId);
    const body = render(Desktop, { props: runtime }).body;
    expect(body.match(/<main\b/g)).toHaveLength(1);
    expect(body.match(/\bdata-workspace\b/g)).toHaveLength(1);
  });
  it("does not rely on SSR to start the hash router or open the initial page", () => {
    const runtime = createDesktopRuntime();
    expect(pageTags(render(Desktop, { props: runtime }).body)).toEqual([]);
    runtime.shell.openApplication("gallery");
    expect(pageTags(render(Desktop, { props: runtime }).body)).toHaveLength(1);
  });

  it("shows settings subnavigation only for a focused settings page", () => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("policy");
    const settings = render(Desktop, { props: runtime }).body;
    const nav = settings.match(/<nav[^>]*aria-label="设置导航"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    expect(nav?.match(/data-nav-app="([^"]+)"/g)).toEqual([
      'data-nav-app="proxy"', 'data-nav-app="vault"', 'data-nav-app="policy"', 'data-nav-app="diagnostics"', 'data-nav-app="personalization"',
    ]);
    expect(nav).toContain('data-nav-app="policy" aria-current="page"');
    expect(settings).toContain('data-nav-settings="" aria-current="true"');
    runtime.shell.openApplication("gallery");
    expect(render(Desktop, { props: runtime }).body).not.toContain('aria-label="设置导航"');
  });

  it("retains visited business pages while exactly one page is visible and interactive", () => {
    const runtime = createDesktopRuntime();
    for (const appId of ["crawl", "tasks", "gallery"] as const) runtime.shell.openApplication(appId);
    for (const focused of ["gallery", "crawl"] as const) {
      runtime.shell.openApplication(focused);
      const body = render(Desktop, { props: runtime }).body;
      const pages = pageTags(body);
      expect(pages).toHaveLength(3);
      expect(pages.filter((page) => !/\bhidden\b/.test(page))).toHaveLength(1);
      for (const appId of ["crawl", "tasks", "gallery"] as const) {
        const page = pages.find((tag) => tag.includes(`data-app-id="${appId}"`));
        expect(page).toBeDefined();
        expect(/\bhidden\b/.test(page!)).toBe(appId !== focused);
        expect(/\binert\b/.test(page!)).toBe(appId !== focused);
        expect(body).toContain(`data-${appId}-app`);
      }
      expect(body).not.toContain("data-review-app");
    }
    // SSR checks the emitted pages; the keyed each block pins client-side retention.
    expect(desktopSource).toContain("{#each snapshot.openedAppIds as appId (appId)}");
    expect(desktopSource).toContain("hidden={snapshot.focusedAppId !== appId} inert={snapshot.focusedAppId !== appId}");
    expect(desktopSource).not.toContain("{#key snapshot.focusedAppId}");
  });

  it("preserves the unload dirty boundary after navigating away from a settings page", () => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("policy");
    const unregister = runtime.shell.registerUnsavedChanges("policy", () => true);
    runtime.shell.openApplication("gallery");
    expect(runtime.shell.hasUnsavedChanges()).toBe(true);
    expect(pageTags(render(Desktop, { props: runtime }).body).find((page) => page.includes('data-app-id="policy"'))).toMatch(/\bhidden\b.*\binert\b/);
    expect(desktopSource).toContain("if (!shell.hasUnsavedChanges()) return;");
    expect(desktopSource).toContain("event.preventDefault()");
    expect(desktopSource).toContain('event.returnValue = ""');
    expect(desktopSource).toContain('window.addEventListener("beforeunload", onBeforeUnload)');
    expect(desktopSource).toContain('window.removeEventListener("beforeunload", onBeforeUnload)');
    unregister();
    expect(runtime.shell.hasUnsavedChanges()).toBe(false);
  });

  it("renders About identity with a labelled modal and keeps focus trapping and return", () => {
    const body = render(About, { props: { open: true, onClose: () => {} } }).body;
    expect(body).toContain("data-about-dialog");
    expect(body).toContain('role="dialog" aria-modal="true"');
    expect(body).toContain('aria-labelledby="about-title"');
    expect(body).toContain('aria-describedby="about-full-name about-tagline"');
    expect(body).toContain("LoRA Dataset Operating System");
    expect(body).toContain("The operating workspace for LoRA datasets.");
    expect(render(About, { props: { open: false, onClose: () => {} } }).body).not.toContain("data-about-dialog");
    for (const marker of ["Escape", "onkeydown", "trappedTabIndex", "restoreFocus", "returnFocus"]) expect(aboutSource).toContain(marker);
    expect(desktopSource).toContain('class="workbench-sidebar" inert={aboutOpen}');
    expect(desktopSource).toContain('class="workbench-main" inert={aboutOpen}');
  });

  it("uses explicit application branches without storage or API access in shell views", () => {
    const joined = Object.values(componentSources).join("\n");
    expect(joined).not.toContain("ApplicationPlaceholder");
    expect(joined).not.toMatch(/\b(?:localStorage|sessionStorage|fetch|XMLHttpRequest)\b/);
    expect(joined).not.toContain("/api/v1");
    expect(desktopSource).toContain('appId === "gallery"');
    expect(desktopSource).not.toContain('appId === "export"');
  });
});
