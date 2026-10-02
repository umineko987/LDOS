import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import Diagnostics from "../src/apps/diagnostics/Diagnostics.svelte";
import Desktop from "../src/shell/Desktop.svelte";
import { createDesktopRuntime } from "./fixtures/desktop";
import type { ApiClient } from "../src/core/api/client";
import type { PollingService } from "../src/core/polling/service";
import desktopSource from "../src/shell/Desktop.svelte?raw";
import controllerSource from "../src/apps/diagnostics/controller.ts?raw";
import diagnosticsSource from "../src/apps/diagnostics/Diagnostics.svelte?raw";
import modelSource from "../src/apps/diagnostics/model.ts?raw";
import serviceSource from "../src/apps/diagnostics/service.ts?raw";
import stateSource from "../src/apps/diagnostics/state.ts?raw";

const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;
const navigate = vi.fn();
const props = { api, polling, onNavigate: navigate };
const css = readFileSync(new URL("../src/apps/diagnostics/diagnostics.css", import.meta.url), "utf8");

describe("Svelte Diagnostics integration", () => {
  it("renders accessible Diagnostics settings and safe recovery actions", () => {
    const body = render(Diagnostics, { props }).body;
    for (const marker of ["data-diagnostics-app", 'data-domain-owner="diagnostics"', '<h1 id="diagnostics-heading">诊断</h1>', "连接与检查", "配置与调度", "组件状态", "刷新诊断", "复制诊断摘要", "打开 API 文档", 'aria-label="系统诊断；可纵向滚动"', 'aria-live="polite"']) expect(body).toContain(marker);
    expect(body).not.toContain("应用迁移将在后续阶段接入");
  });

  it("mounts Diagnostics in Desktop with business navigation", () => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("diagnostics");
    const body = render(Desktop, { props: runtime }).body;
    expect(body).toContain('data-app-page="" data-app-id="diagnostics"');
    expect(body).toContain("data-diagnostics-app");
    expect(desktopSource).toContain('<Diagnostics {api} {polling} onNavigate={navigate} />');
  });

  it("keeps one store, keyed components, the shared poller, safe API boundary, and cleanup", () => {
    expect(diagnosticsSource.match(/createDiagnosticsStore\s*\(/g)).toHaveLength(1);
    expect(diagnosticsSource).toContain("{#each snapshot.snapshot.readiness.components as component (component.id)}");
    expect(stateSource).toContain("snapshot: DiagnosticsSnapshot | null");
    expect(controllerSource).toContain('DIAGNOSTICS_POLL_KEY = "diagnostics.snapshot"');
    expect(controllerSource).toContain("intervalMs: DIAGNOSTICS_POLL_INTERVAL_MS");
    expect(controllerSource).toContain("polling.stopScope(DIAGNOSTICS_SCOPE)");
    expect(diagnosticsSource).toContain("controller.destroy()");
    expect(serviceSource).toContain("Promise.all([");
    expect((serviceSource.match(/"\/api\/v1\//g) ?? [])).toHaveLength(2);
    const combined = [diagnosticsSource, controllerSource, modelSource, serviceSource, stateSource].join("\n");
    for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /\b(?:localStorage|sessionStorage|indexedDB)\b/, /\bsetInterval\s*\(/, /innerHTML/, /console\./, /error\.details/]) expect(combined).not.toMatch(forbidden);
  });

  it("keeps vertically scrollable flat settings and forced-colors support", () => {
    expect(css).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter\s*:(?!\s*none)/m);
    expect(css).not.toMatch(/^\s*filter\s*:/m);
    expect(css).toContain(".diagnostics-workspace-track");
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("@container (max-width: 900px)");
  });
});
