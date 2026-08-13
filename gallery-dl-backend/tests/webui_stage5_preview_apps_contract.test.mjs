import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import galleryApplication, { createGalleryController } from "../gdl_backend/webui/js/apps/gallery.js";
import scheduleApplication, { createScheduleController } from "../gdl_backend/webui/js/apps/schedule.js";
import exportApplication, { createExportController } from "../gdl_backend/webui/js/apps/export.js";
import { createPlaceholderApplication } from "../gdl_backend/webui/js/apps/placeholder.js";
import {
  createGalleryUiState,
  galleryPresentation,
  projectGalleryState,
  toggleGallerySelection,
  updateGalleryUiState,
  visibleGalleryItems,
} from "../gdl_backend/webui/js/core/gallery-model.js";
import {
  createScheduleUiState,
  projectScheduleState,
  resetScheduleDraft,
  schedulePresentation,
  selectSchedulePlan,
  updateScheduleDraft,
  validateScheduleDraft,
} from "../gdl_backend/webui/js/core/schedule-model.js";
import {
  exportPresentation,
  exportSelectionFacts,
  projectExportState,
  toggleExportSource,
  updateExportConfig,
} from "../gdl_backend/webui/js/core/export-model.js";
import {
  TESTS_ONLY_STAGE5,
  exportFixtures,
  galleryFixtures,
  scheduleFixtures,
} from "./fixtures/webui/stage5-preview-fixtures.js";

const WEBUI = new URL("../gdl_backend/webui/", import.meta.url);
const REGISTRY_SOURCE = readFileSync(new URL("js/core/app-registry.js", WEBUI), "utf8");
const INDEX_SOURCE = readFileSync(new URL("index.html", WEBUI), "utf8");

const PREVIEW_APPS = Object.freeze(["gallery", "schedule", "export"]);
const SECRET_PARTS = ["stage5", "private", "value", "271828"];
const SECRET = SECRET_PARTS.join("-");
const APP_MODULES = Object.freeze({ gallery: galleryApplication, schedule: scheduleApplication, export: exportApplication });
const APP_SOURCES = Object.fromEntries(PREVIEW_APPS.map((appId) => [appId, readFileSync(new URL(`js/apps/${appId}.js`, WEBUI), "utf8")]));
const MODEL_SOURCES = Object.fromEntries(PREVIEW_APPS.map((appId) => [appId, readFileSync(new URL(`js/core/${appId}-model.js`, WEBUI), "utf8")]));
const VIEW_SOURCES = Object.fromEntries(PREVIEW_APPS.map((appId) => [appId, readFileSync(new URL(`js/components/${appId}-view.js`, WEBUI), "utf8")]));
const CSS_SOURCES = Object.fromEntries(PREVIEW_APPS.map((appId) => [appId, readFileSync(new URL(`styles/apps/${appId}.css`, WEBUI), "utf8")]));
const FIXTURE_SOURCE = readFileSync(new URL("fixtures/webui/stage5-preview-fixtures.js", import.meta.url), "utf8");
const FIXTURE_HOST_SOURCE = readFileSync(new URL("fixtures/webui/stage5-preview-host.js", import.meta.url), "utf8");

function sourceExists(path) {
  return existsSync(new URL(path, WEBUI));
}

test("Stage 5 registry uses three independent preview controllers instead of placeholders", () => {
  for (const appId of PREVIEW_APPS) {
    assert.match(
      REGISTRY_SOURCE,
      new RegExp(`import\\s+${appId}Application\\s+from\\s+["']\\.\\./apps/${appId}\\.js["']`),
      `${appId} must have an explicit production controller import`,
    );
    assert.doesNotMatch(
      REGISTRY_SOURCE,
      new RegExp(`\\[\\s*["']${appId}["'][^\\n]*createPlaceholderApplication`),
      `${appId} must not use createPlaceholderApplication`,
    );
  }
});

test("Stage 5 production model, view, controller, and stylesheet modules exist per app", () => {
  for (const appId of PREVIEW_APPS) {
    assert.equal(sourceExists(`js/apps/${appId}.js`), true, `${appId} controller is missing`);
    assert.equal(sourceExists(`js/core/${appId}-model.js`), true, `${appId} model is missing`);
    assert.equal(sourceExists(`js/components/${appId}-view.js`), true, `${appId} view is missing`);
    assert.equal(sourceExists(`styles/apps/${appId}.css`), true, `${appId} stylesheet is missing`);
  }
});

test("Stage 5 index explicitly loads all preview application styles", () => {
  for (const appId of PREVIEW_APPS) {
    assert.match(INDEX_SOURCE, new RegExp(`href=["']\\./styles/apps/${appId}\\.css["']`));
  }
});

test("Stage 5 preview production boundary declares no guessed business endpoints", () => {
  for (const appId of PREVIEW_APPS) {
    const paths = [
      `js/apps/${appId}.js`,
      `js/core/${appId}-model.js`,
      `js/components/${appId}-view.js`,
    ];
    for (const path of paths) {
      if (!sourceExists(path)) continue;
      const source = readFileSync(new URL(path, WEBUI), "utf8");
      assert.doesNotMatch(source, /\/api\//, `${path} must not declare a business API path`);
    }
  }
});

test("Stage 5 model state machines project loading/empty/content/error fixtures immutably", () => {
  assert.equal(TESTS_ONLY_STAGE5, true);
  const tables = [
    [projectGalleryState, galleryFixtures, ["loading", "empty", "content", "error"]],
    [projectScheduleState, scheduleFixtures, ["loading", "empty", "content", "error"]],
    [projectExportState, exportFixtures, ["loading", "empty", "content", "error"]],
  ];
  for (const [project, fixtures, phases] of tables) {
    for (const phase of phases) {
      const state = project(fixtures[phase]);
      assert.equal(state.phase, phase);
      assert.equal(Object.isFrozen(state), true);
    }
    assert.equal(project({ phase: "unavailable" }).phase, "unavailable");
  }
  assert.equal(galleryPresentation(galleryFixtures.content).state, "content");
  assert.equal(schedulePresentation(scheduleFixtures.error).state, "error");
  assert.equal(exportPresentation(exportFixtures.loading).state, "loading");
});

test("Stage 5 strict projections reject non-plain, dangerous, accessor, enum/count/text, and secret-shaped fields", () => {
  const projectors = [projectGalleryState, projectScheduleState, projectExportState];
  for (const project of projectors) {
    assert.throws(() => project([]), TypeError);
    assert.throws(() => project(new (class State { constructor() { this.phase = "empty"; } })()), TypeError);
    assert.throws(() => project(JSON.parse('{"phase":"empty","__proto__":{"polluted":true}}')), TypeError);
    const accessor = { phase: "empty" };
    Object.defineProperty(accessor, "payload", { enumerable: true, get() { throw new Error(SECRET); } });
    assert.throws(() => project(accessor), TypeError);
    assert.equal({}.polluted, undefined);
  }

  assert.throws(() => projectGalleryState({ phase: "content", items: [{
    ...galleryFixtures.content.items[0], width: Number.NaN,
  }] }), TypeError);
  assert.throws(() => projectGalleryState({ phase: "content", items: [{
    ...galleryFixtures.content.items[0], mediaVariant: "unknown",
  }] }), TypeError);
  assert.throws(() => projectGalleryState({ phase: "content", items: [{
    ...galleryFixtures.content.items[0], label: "x".repeat(100),
  }] }), TypeError);
  assert.throws(() => projectGalleryState({ phase: "content", items: [{
    ...galleryFixtures.content.items[0], path: `/private/${SECRET}`,
  }] }), TypeError);
  assert.throws(() => projectScheduleState({ phase: "content", plans: [{
    ...scheduleFixtures.content.plans[0], concurrency: Infinity,
  }] }), TypeError);
  assert.throws(() => projectScheduleState({ phase: "content", plans: [{
    ...scheduleFixtures.content.plans[0], state: "paused",
  }] }), TypeError);
  assert.throws(() => projectExportState({ phase: "content", ...exportFixtures.content, progress: {
    ...exportFixtures.content.progress, total: Number.NaN,
  } }), TypeError);
  assert.throws(() => projectExportState({ phase: "content", ...exportFixtures.content, config: {
    ...exportFixtures.content.config, destinationPath: `/private/${SECRET}`,
  } }), TypeError);
});

test("Stage 5 projections never retain paths, URLs, credentials, raw errors, filenames, or runtime image fields", () => {
  const gallery = structuredClone(galleryFixtures.content);
  gallery.items[0].url = `https://private.invalid/${SECRET}`;
  const schedule = structuredClone(scheduleFixtures.content);
  schedule.plans[0].token = SECRET;
  const exported = structuredClone(exportFixtures.content);
  exported.config.destinationPath = `/private/${SECRET}`;
  for (const [project, value] of [
    [projectGalleryState, gallery], [projectScheduleState, schedule], [projectExportState, exported],
  ]) {
    assert.throws(() => project(value), TypeError);
  }
  const safe = JSON.stringify({
    gallery: projectGalleryState(galleryFixtures.content),
    schedule: projectScheduleState(scheduleFixtures.content),
    exported: projectExportState(exportFixtures.content),
  });
  for (const forbidden of [SECRET, "https://", "/private/", "filename", "cookie", "password", "secret", "raw error", "details"] ) {
    assert.equal(safe.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test("Gallery interactions are deterministic: collection, search, sort, mode, selection and Quick Look id", () => {
  const state = projectGalleryState(galleryFixtures.content);
  let ui = createGalleryUiState();
  assert.deepEqual(visibleGalleryItems(state, ui).map((item) => item.id), ["media-06", "media-05", "media-04", "media-03", "media-02", "media-01"]);
  ui = updateGalleryUiState(ui, { query: "绿色", sort: "label", mode: "list" }, state.items);
  assert.deepEqual(visibleGalleryItems(state, ui).map((item) => item.id), ["media-03"]);
  ui = updateGalleryUiState(ui, { query: "", collection: "favorites" }, state.items);
  assert.deepEqual(visibleGalleryItems(state, ui).map((item) => item.id), ["media-03", "media-06", "media-01"]);
  ui = toggleGallerySelection(ui, "media-03", state.items);
  ui = toggleGallerySelection(ui, "media-01", state.items, { additive: true });
  assert.deepEqual(ui.selectedIds, ["media-03", "media-01"]);
  ui = updateGalleryUiState(ui, { inspectorOpen: false, quickLookId: "media-03" }, state.items);
  assert.equal(ui.inspectorOpen, false);
  assert.equal(ui.quickLookId, "media-03");
  assert.throws(() => updateGalleryUiState(ui, { quickLookId: "missing" }, state.items), TypeError);
});

test("Schedule selection, validation, dirty/reset and running state are pure model facts", () => {
  const state = projectScheduleState(scheduleFixtures.content);
  let ui = selectSchedulePlan(state, "plan-daily");
  assert.equal(ui.dirty, false);
  ui = updateScheduleDraft(state, ui, { name: "更新后的计划", concurrency: 12 });
  assert.equal(ui.dirty, true);
  assert.equal(ui.validation.valid, true);
  ui = updateScheduleDraft(state, ui, { concurrency: 0 });
  assert.deepEqual(ui.validation, { valid: false, field: "concurrency", reason: "并发数需为 1–128 的整数。" });
  assert.equal(validateScheduleDraft({ ...ui.draft, name: "" }).field, "name");
  assert.equal(validateScheduleDraft({ ...ui.draft, scheduleKind: "cron" }).field, "schedule-kind");
  assert.equal(validateScheduleDraft({ ...ui.draft, scheduleLabel: "" }).field, "schedule-label");
  ui = resetScheduleDraft(state, ui);
  assert.equal(ui.dirty, false);
  assert.equal(state.plans.find((plan) => plan.id === "plan-running").state, "running");
  assert.deepEqual(createScheduleUiState(), { selectedId: "", draft: null, dirty: false, validation: { valid: true, field: "", reason: "" } });
});

test("Export source/config and deterministic running/success/error facts never use timers", () => {
  let state = projectExportState(exportFixtures.content);
  assert.deepEqual(exportSelectionFacts(state), { sourceCount: 2, itemCount: 276, reviewedCount: 276 });
  state = toggleExportSource(state, "source-partial");
  assert.deepEqual(exportSelectionFacts(state), { sourceCount: 3, itemCount: 356, reviewedCount: 328 });
  state = updateExportConfig(state, { format: "coco", shardSize: 50, includeRejected: true });
  assert.equal(state.config.format, "coco");
  assert.equal(state.config.shardSize, 50);
  assert.equal(projectExportState(exportFixtures.running).progress.completed, 148);
  assert.equal(projectExportState(exportFixtures.success).progress.state, "success");
  assert.equal(projectExportState(exportFixtures.resultError).progress.code, "export_fixture_interrupted");
  assert.doesNotMatch(`${APP_SOURCES.export}\n${MODEL_SOURCES.export}`, /setTimeout|setInterval|requestAnimationFrame/);
});

test("Stage 5 controllers use unavailable adapters, make zero API calls, and stale reads stay inert", async () => {
  class TestRoot {
    constructor() { this.hidden = false; this.inert = false; this.dataset = {}; this.listeners = new Map(); }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    toggleAttribute(name, enabled) { if (name === "inert") this.inert = Boolean(enabled); }
    removeAttribute(name) { if (name === "data-lifecycle") delete this.dataset.lifecycle; }
    querySelector() { return null; }
  }
  const previousElement = globalThis.Element;
  Object.defineProperty(globalThis, "Element", { configurable: true, value: TestRoot });
  try {
    const constructors = [
      [createGalleryController, { phase: "content", items: galleryFixtures.content.items }],
      [createScheduleController, { phase: "content", plans: scheduleFixtures.content.plans }],
      [createExportController, exportFixtures.content],
    ];
    for (const [createController, fixture] of constructors) {
      const root = new TestRoot();
      const calls = [];
      let resolveRead;
      const readPromise = new Promise((resolve) => { resolveRead = resolve; });
      const viewLog = [];
      const view = {
        render(state) { viewLog.push(state.phase); },
        getUiState() { return createGalleryUiState(); },
        closeQuickLook() { return false; }, releaseMedia() {}, destroy() { viewLog.push("destroy"); },
      };
      const controller = createController({ root, app: {} , api: { get() { calls.push("get"); }, post() { calls.push("post"); } } }, {
        adapter: { read: () => readPromise },
        createView: () => view,
      });
      controller.activate();
      controller.deactivate();
      resolveRead(fixture);
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(calls, []);
      assert.equal(controller.getState().phase, "unavailable");
      assert.equal(root.hidden, true);
      assert.equal(root.inert, true);
      controller.destroy();
      assert.equal(viewLog.at(-1), "destroy");
    }
  } finally {
    if (previousElement === undefined) delete globalThis.Element;
    else Object.defineProperty(globalThis, "Element", { configurable: true, value: previousElement });
  }
});

test("Stage 5 applications expose complete lifecycle and production registry has zero placeholder use", () => {
  const retainedForPhaseSix = createPlaceholderApplication("仅用于兼容测试");
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof retainedForPhaseSix[hook], "function", `placeholder.${hook}`);
  }
  for (const [appId, application] of Object.entries(APP_MODULES)) {
    for (const hook of ["mount", "activate", "deactivate", "unmount"]) assert.equal(typeof application[hook], "function", `${appId}.${hook}`);
  }
  assert.doesNotMatch(REGISTRY_SOURCE, /createPlaceholderApplication/);
  assert.doesNotMatch(REGISTRY_SOURCE, /apps\/placeholder\.js/);
});

test("Stage 5 fixture host is explicit tests-only injection and production source closure has zero fixture references", () => {
  assert.match(FIXTURE_SOURCE, /TESTS_ONLY_STAGE5\s*=\s*true/);
  assert.match(FIXTURE_HOST_SOURCE, /testsOnly:\s*true/);
  assert.match(FIXTURE_HOST_SOURCE, /createGalleryController/);
  assert.match(FIXTURE_HOST_SOURCE, /createScheduleController/);
  assert.match(FIXTURE_HOST_SOURCE, /createExportController/);
  const production = [REGISTRY_SOURCE, ...Object.values(APP_SOURCES), ...Object.values(MODEL_SOURCES), ...Object.values(VIEW_SOURCES)].join("\n");
  assert.doesNotMatch(production, /stage5-preview-fixtures|stage5-preview-host|tests\/fixtures|fixtures\/webui|testsOnly/);
});

test("Stage 5 static security and rendering boundaries forbid bypass I/O, unsafe DOM, runtime media, and fixture imports", () => {
  for (const appId of PREVIEW_APPS) {
    const combined = `${APP_SOURCES[appId]}\n${MODEL_SOURCES[appId]}\n${VIEW_SOURCES[appId]}`;
    for (const forbidden of [
      /\bfetch\s*\(/, /globalThis\.fetch/, /XMLHttpRequest/, /localStorage|sessionStorage|indexedDB/,
      /console\./, /innerHTML/, /URL\.createObjectURL/, /\bBlob\b/, /data:image/, /\/api\//,
      /tests\/fixtures|fixtures\/webui/,
    ]) assert.doesNotMatch(combined, forbidden, `${appId}: ${forbidden}`);
  }
  assert.doesNotMatch(`${VIEW_SOURCES.gallery}\n${MODEL_SOURCES.gallery}`, /<img|document\.createElement\(["']img|\.src\s*=/i);
  assert.doesNotMatch(`${APP_SOURCES.schedule}\n${VIEW_SOURCES.schedule}`, /scheduler\/status|view=diagnostics/);
});

test("Stage 5 CSS contracts use content/navigation solid surfaces, local scroll owners, and accessibility media", () => {
  for (const appId of PREVIEW_APPS) {
    const css = CSS_SOURCES[appId];
    assert.match(css, /--imageweave-surface-content-solid/);
    assert.match(css, /--imageweave-surface-navigation-solid/);
    assert.match(css, new RegExp(`\\.${appId}-workspace\\s*\\{[\\s\\S]*overflow-x:\\s*auto[\\s\\S]*overflow-y:\\s*hidden`));
    assert.match(css, new RegExp(`\\.${appId}-column-scroll(?:\\s*,[^\\{]+)?\\s*\\{[\\s\\S]*?overflow-y:\\s*auto`));
    assert.match(css, /application-window\[data-maximized\]/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /data-motion="off"/);
    assert.match(css, /forced-colors:\s*active/);
    assert.match(css, /Canvas/);
    assert.match(css, /ButtonFace/);
    assert.match(css, /Highlight/);
    assert.doesNotMatch(css, /@media\s*\((?:max-width|max-height)|backdrop-filter/);
  }
});

test("Stage 5 views declare disabled write reasons and Gallery Quick Look keyboard/release contracts", () => {
  for (const [appId, source] of Object.entries(VIEW_SOURCES)) {
    assert.match(source, new RegExp(`${appId}-write-reason`));
    assert.match(source, /aria-describedby/);
  }
  for (const phrase of ["导入", "删除", "在文件夹中显示", "写入标签", "导出所选"]) assert.match(VIEW_SOURCES.gallery, new RegExp(phrase));
  for (const phrase of ["保存计划", "启用 / 停用", "立即运行"]) assert.match(VIEW_SOURCES.schedule, new RegExp(phrase));
  for (const phrase of ["选择目标", "开始导出", "取消导出", "打开结果"]) assert.match(VIEW_SOURCES.export, new RegExp(phrase));
  for (const fingerprint of [
    'role: "dialog"', '"aria-modal": "true"', "trapQuickLookFocus", "event.key !== \"Tab\"",
    "quickLookReturnFocus", "event.key === \"Escape\"", "view.releaseMedia()", "preview.replaceChildren()",
    "ArrowLeft", "ArrowRight", "EDITABLE_SELECTOR",
  ]) assert.match(`${APP_SOURCES.gallery}\n${VIEW_SOURCES.gallery}`, new RegExp(fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
