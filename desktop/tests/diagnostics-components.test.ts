import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import Diagnostics from "../src/apps/diagnostics/Diagnostics.svelte";
import AppWindow from "../src/shell/AppWindow.svelte";
import type { ApiClient } from "../src/core/api/client";
import type { PersistenceService } from "../src/core/persistence/service";
import type { PollingService } from "../src/core/polling/service";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";
import controllerSource from "../src/apps/diagnostics/controller.ts?raw";
import diagnosticsSource from "../src/apps/diagnostics/Diagnostics.svelte?raw";
import modelSource from "../src/apps/diagnostics/model.ts?raw";
import serviceSource from "../src/apps/diagnostics/service.ts?raw";
import stateSource from "../src/apps/diagnostics/state.ts?raw";

const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;
const persistence = Object.freeze({}) as PersistenceService;
const navigate = vi.fn();
const props = { api, polling, onNavigate: navigate };
const windowProps = { record: { appId: "diagnostics" as const, state: "normal" as const, rect: { x: 20, y: 20, w: 800, h: 560 } }, api, polling, persistence, focused: true, onNavigate: navigate, onFocus: vi.fn(), onMinimize: vi.fn(), onToggleMaximized: vi.fn(), onClose: vi.fn(), onBeginInteraction: vi.fn(), onKeyboardResize: vi.fn() };
const css = readFileSync(new URL("../src/apps/diagnostics/diagnostics.css", import.meta.url), "utf8");

describe("Svelte Diagnostics integration", () => {
  it("renders the real accessible three-column Diagnostics boundary", () => {
    const body = render(Diagnostics, { props }).body;
    for (const marker of ["data-diagnostics-app", 'data-domain-owner="diagnostics"', "01 · 摘要", "02 · 服务事实", "03 · 组件与恢复", "连接与检查", "安全配置与调度", "分领域诊断", "刷新诊断", "复制诊断摘要", "打开 API 文档", 'aria-label="系统诊断三栏工作区；普通窗口可横向滚动"', 'aria-live="polite"']) expect(body).toContain(marker);
    expect(body).not.toContain("应用迁移将在后续阶段接入");
  });

  it("routes Diagnostics through its only AppWindow branch", () => {
    const body = render(AppWindow, { props: windowProps }).body;
    expect(body).toContain("data-diagnostics-app");
    expect(appWindowSource).toContain('record.appId === "diagnostics"');
    expect(appWindowSource).toContain("<Diagnostics {api} {polling} onNavigate=");
    expect(appWindowSource.match(/<ApplicationPlaceholder/g)).toHaveLength(1);
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

  it("keeps application internals flat with horizontal and forced-colors fallbacks", () => {
    expect(css).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter\s*:(?!\s*none)/m);
    expect(css).not.toMatch(/^\s*filter\s*:/m);
    expect(css).toContain(".diagnostics-workspace-track");
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).not.toMatch(/@media\s*\(max-width\s*:/);
  });
});
