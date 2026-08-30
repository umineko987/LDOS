import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

import Review from "../src/apps/review/Review.svelte";
import reviewSource from "../src/apps/review/Review.svelte?raw";
import controllerSource from "../src/apps/review/controller.ts?raw";
import engineSource from "../src/apps/review/engine.ts?raw";
import modelSource from "../src/apps/review/model.ts?raw";
import serviceSource from "../src/apps/review/service.ts?raw";
import stateSource from "../src/apps/review/state.ts?raw";
import type { ApiClient } from "../src/core/api/client";
import type { PersistenceService } from "../src/core/persistence/service";
import type { PollingService } from "../src/core/polling/service";
import AppWindow from "../src/shell/AppWindow.svelte";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";

const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;
const persistence = Object.freeze({ readActiveBatchId: () => null, writeActiveBatchId: () => true }) as unknown as PersistenceService;
const css = readFileSync(new URL("../src/apps/review/review.css", import.meta.url), "utf8");
const props = {
  record: { appId: "review" as const, state: "maximized" as const, rect: { x: 0, y: 0, w: 1280, h: 720 } },
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

describe("Svelte Review integration", () => {
  it("renders the real accessible Review workspace without projecting media paths", () => {
    const body = render(Review, { props: { api, polling, persistence, onNavigate: vi.fn() } }).body;
    for (const marker of [
      "data-review-app",
      'data-domain-owner="review"',
      "去重审核",
      "已结束批次",
      "打开批次管理",
      "尚未打开审核批次",
      'aria-live="polite"',
    ]) expect(body).toContain(marker);
    expect(reviewSource).toContain('aria-label="审核工具栏"');
    for (const forbidden of ["relative_path", "private.invalid", "应用迁移将在后续阶段接入", "P2 Shell"]) expect(body).not.toContain(forbidden);
  });

  it("keeps the model download dialog opaque with a visible validated proxy field", () => {
    expect(reviewSource).toContain('type="text"');
    expect(reviewSource).not.toContain('type="password"');
    expect(reviewSource).toContain("代理地址格式不正确");
    expect(reviewSource).toContain("normalizeModelProxyUrl(modelProxy)");
    expect(reviewSource).toContain("aria-invalid={Boolean(modelProxyError)}");
    expect(css).toContain(".review-model-confirmation { background: var(--ldos-fallback-elevated-solid); }");
    expect(css).toContain(".review-model-confirmation::backdrop { background: rgb(3 7 18 / 0.68); }");
  });

  it("routes Review through its only AppWindow branch", () => {
    const body = render(AppWindow, { props }).body;
    expect(body).toContain("data-review-app");
    expect(body).not.toContain('data-application-content="review"');
    expect(appWindowSource).toContain('record.appId === "review"');
    expect(appWindowSource).toContain("<Review {api} {polling} {persistence} {onNavigate}");
  });

  it("keeps stable keyed groups and images under one domain state owner", () => {
    expect(reviewSource.match(/createReviewStore\s*\(/g)).toHaveLength(1);
    expect(stateSource).toContain("snapshot: ReviewSnapshot | null");
    expect(modelSource).toContain("groups: Readonly<Record<string, ReviewGroup>>");
    expect(reviewSource).toContain("{#each groups as group (group.id)}");
    expect(reviewSource).toContain("{#each images as image (image.id)}");
    expect(reviewSource).toContain('data-review-group-select');
    expect(reviewSource).toContain('data-review-engine-card={image.id}');
    expect(reviewSource).toContain("review-image-active-marker");
    expect(reviewSource).not.toContain("replaceChildren(");
  });

  it("mounts one imperative Canvas engine and releases every owned resource", () => {
    for (const marker of [
      "createReviewEngine({ host: engineHost",
      "engine.update(frame)",
      "engine.release()",
      "engine?.destroy()",
      'crossorigin="anonymous"',
      'decoding="async"',
      "new globalThis.ResizeObserver",
      "REVIEW_MAX_CANVAS_DPR = 2",
      "context.imageSmoothingEnabled = false",
      "element.removeAttribute(\"src\")",
      "canvas.width = 1",
    ]) expect(`${reviewSource}\n${engineSource}`).toContain(marker);
    expect(stateSource).not.toMatch(/canvas|pixel|magnification|objectUrl|mediaUrl|imageUrl/i);
    expect(engineSource).not.toMatch(/URL\.createObjectURL|new Blob|localStorage|sessionStorage|\bfetch\s*\(/);
    expect(reviewSource).toContain("registerUnsavedChanges");
    expect(reviewSource).toContain("controller.beforeLeave");
    expect(reviewSource).toContain("beforeunload");
  });

  it("uses shared API and polling paths without unsafe DOM or component scheduling", () => {
    const combined = [reviewSource, controllerSource, modelSource, serviceSource, stateSource].join("\n");
    for (const forbidden of [
      /\bfetch\s*\(/,
      /globalThis\.fetch/,
      /XMLHttpRequest/,
      /\b(?:localStorage|sessionStorage|indexedDB)\b/,
      /\bsetInterval\s*\(/,
      /innerHTML/,
      /console\./,
      /URL\.createObjectURL/,
      /new Blob/,
      /data:image/,
    ]) expect(combined).not.toMatch(forbidden);
    expect(serviceSource.match(/"\/api\/v1\//g)).toHaveLength(2);
    expect(serviceSource.match(/view=desktop/g)).toHaveLength(4);
    expect(serviceSource).toContain("REVIEW_PAGE_LIMIT = 50");
    expect(serviceSource).not.toContain("all=true");
    expect(controllerSource).toContain('REVIEW_POLL_KEY = "review.active"');
    expect(controllerSource).toContain("intervalMs: REVIEW_POLL_INTERVAL_MS");
    expect(controllerSource).toContain("polling.stopScope(REVIEW_SCOPE)");
  });

  it("keeps the full-height sorting deck flat and accessible under system modes", () => {
    for (const marker of [
      ".review-deck-header",
      ".review-deck-stage",
      ".review-deck-statusbar",
      "max-height: 230px",
      "min-height: 0",
      "overflow: hidden",
      '.review-operation-live[data-review-dirty="true"]',
      'content: "△ 未保存 · "',
      ".review-tab--active::before",
      ".review-image-card[data-selected=\"true\"]",
      ".review-image-card[data-active=\"true\"]",
      "image-rendering: pixelated",
      "@supports not",
      "@media (prefers-contrast: more)",
      "@media (forced-colors: active)",
      "ButtonFace",
      "Highlight",
    ]) expect(css).toContain(marker);
    expect(css).not.toMatch(/^\s*(?:-webkit-)?backdrop-filter\s*:(?!\s*none)/m);
    expect(css).not.toMatch(/^\s*filter\s*:(?!\s*none)/m);
    expect(css).not.toMatch(/--ldos-state-[a-z-]+-surface/);
    expect(css).not.toMatch(/border(?:-style)?\s*:\s*(?:double|dashed|dotted)/);
    expect(css).not.toMatch(/transition\s*:\s*(?:100|120|150|180)ms/);
  });
});
