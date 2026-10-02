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
import Desktop from "../src/shell/Desktop.svelte";
import desktopSource from "../src/shell/Desktop.svelte?raw";
import { createDesktopRuntime } from "./fixtures/desktop";

const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;
const persistence = Object.freeze({ readActiveReviewId: () => null, writeActiveReviewId: () => true }) as unknown as PersistenceService;
const css = readFileSync(new URL("../src/apps/review/review.css", import.meta.url), "utf8");

describe("Svelte Review integration", () => {
  it("renders the real accessible Review workspace without projecting media paths", () => {
    const body = render(Review, { props: { api, polling, persistence, onNavigate: vi.fn() } }).body;
    for (const marker of [
      "data-review-app",
      'data-domain-owner="review"',
      '<h1 id="review-heading">去重</h1>',
      "已提交审核任务",
      "打开图库",
      "尚无审核任务",
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

  it("mounts Review in Desktop with navigation and its dirty boundary", () => {
    const runtime = createDesktopRuntime();
    runtime.shell.openApplication("review");
    const body = render(Desktop, { props: runtime }).body;
    expect(body).toContain('data-app-page="" data-app-id="review"');
    expect(body).toContain("data-review-app");
    expect(body).not.toContain('data-application-content="review"');
    expect(desktopSource).toContain('<Review {api} {polling} {persistence} active={snapshot.focusedAppId === "review"} reviewId={requestedReviewId} onNavigate={navigate}');
    expect(desktopSource).toContain('shell.registerUnsavedChanges("review", reader, discard, prepare)');
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
    expect(serviceSource.match(/view=desktop/g)).toHaveLength(2);
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
      "min-height: 0",
      "grid-template-rows: auto minmax(0, 1fr) auto",
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
