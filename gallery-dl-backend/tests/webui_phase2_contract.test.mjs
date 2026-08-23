import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationDefinitions,
  validateApplicationDefinitions,
} from "../gdl_backend/webui/js/core/app-definitions.js";
import { getApplicationById } from "../gdl_backend/webui/js/core/app-registry.js";
import {
  createHashRouter,
  hashForRoute,
  parseHashRoute,
  resolveNavigationTarget,
} from "../gdl_backend/webui/js/core/router.js";
import * as desktopModule from "../gdl_backend/webui/js/core/desktop.js";
import {
  normalizeSourceText,
  readSourceText as readFileSync,
} from "./source-test-text.mjs";

import { STORAGE_KEYS } from "../gdl_backend/webui/js/core/storage-contract.js";
import {
  deserializeWindowPlacements,
  migrateLegacyWindowLayout,
  serializeWindowPlacements,
} from "../gdl_backend/webui/js/core/storage-layout.js";

const PREVIEW_APP_IDS = Object.freeze(["gallery", "export"]);
const EXPECTED_GROUPS = Object.freeze([
  Object.freeze({
    id: "workflow",
    title: "工作流",
    appIds: Object.freeze(["crawl", "tasks", "gallery", "review", "export"]),
  }),
  Object.freeze({
    id: "connections",
    title: "连接与策略",
    appIds: Object.freeze(["proxy", "vault", "policy"]),
  }),
  Object.freeze({
    id: "system",
    title: "系统",
    appIds: Object.freeze(["diagnostics", "personalization"]),
  }),
]);

function windowRecord(appId, windowState, rect = { x: 80, y: 72, w: 720, h: 480 }) {
  return { appId, windowState, rect };
}

function dangerousPlacement(key) {
  return JSON.parse(`{"appId":"crawl","rect":{"x":64,"y":56,"w":780,"h":510},"maximized":false,"${key}":{}}`);
}

function installRouterWindow(initialHash = "") {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const listeners = new Map();
  const location = { pathname: "/ui/", search: "", hash: initialHash };
  const historyCalls = [];
  const windowObject = {
    location,
    history: {
      replaceState(_state, _title, url) {
        historyCalls.push(["replace", url]);
        const hashIndex = url.indexOf("#");
        location.hash = hashIndex < 0 ? "" : url.slice(hashIndex);
      },
      pushState(_state, _title, url) {
        historyCalls.push(["push", url]);
        const hashIndex = url.indexOf("#");
        location.hash = hashIndex < 0 ? "" : url.slice(hashIndex);
      },
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: windowObject,
  });
  return {
    location,
    listeners,
    historyCalls,
    emitHashChange() { listeners.get("hashchange")?.(); },
    restore() {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else delete globalThis.window;
    },
  };
}

test("阶段 2 路由与 preview availability 使用正式桌面契约", () => {
  for (const hash of ["", "#", "#/", "#/unknown", "#/crawl?window=tasks", "not-a-hash"]) {
    assert.equal(parseHashRoute(hash), null, hash);
  }
  assert.equal(hashForRoute(null), "");
  assert.equal(hashForRoute("/unknown"), "");
  assert.equal(resolveNavigationTarget(null), null);
  assert.equal(resolveNavigationTarget("unknown"), null);
  for (const appId of PREVIEW_APP_IDS) {
    const app = getApplicationById(appId);
    assert.equal(app.availability, "preview");
    assert.equal(parseHashRoute(`#${app.route}`), app.route);
    assert.equal(resolveNavigationTarget(appId), app.route);
  }
  assert.doesNotThrow(() => validateApplicationDefinitions(applicationDefinitions));
});

test("阶段 2 hash router 规范化未知地址并保留 desktop/application 历史语义", () => {
  const fixture = installRouterWindow("#/unknown");
  const events = [];
  const router = createHashRouter((app, navigation) => {
    events.push([app?.id ?? null, navigation.reason, navigation.malformed]);
  });
  try {
    router.start();
    assert.deepEqual(events, [[null, "initial", true]]);
    assert.equal(fixture.location.hash, "");
    assert.deepEqual(fixture.historyCalls, [["replace", "/ui/"]]);

    router.navigate("crawl");
    assert.equal(fixture.location.hash, "#/crawl");
    fixture.emitHashChange();
    assert.deepEqual(events.at(-1), ["crawl", "hashchange", false]);

    router.navigate(null);
    assert.equal(fixture.location.hash, "");
    assert.deepEqual(fixture.historyCalls.at(-1), ["push", "/ui/"]);
    assert.deepEqual(events.at(-1), [null, "desktop-navigation", false]);

    router.restore("review");
    assert.equal(fixture.location.hash, "#/review");
    assert.deepEqual(events.at(-1), ["review", "restore-route", false]);
    router.stop();
    assert.equal(fixture.listeners.size, 0);
  } finally {
    router.stop();
    fixture.restore();
  }
});

test("阶段 2 应用元数据包含自然语言标题、分组和职责", async () => {
  for (const definition of applicationDefinitions) {
    assert.equal(definition.windowTitle, definition.label, definition.id);
    assert.equal(typeof definition.group, "string", definition.id);
    assert.match(definition.description, /\S/u, definition.id);
  }
  const { deriveApplicationCenterGroups } = await import(
    "../gdl_backend/webui/js/components/application-center.js"
  );
  const groups = deriveApplicationCenterGroups(applicationDefinitions);
  assert.deepEqual(groups.map((group) => ({
    id: group.id,
    title: group.title,
    appIds: group.items.map((item) => item.id),
  })), EXPECTED_GROUPS);
  assert.deepEqual(
    groups.flatMap((group) => group.items.map((item) => item.id)).sort(),
    applicationDefinitions.map((definition) => definition.id).sort(),
  );
});

test("阶段 2 v1 只迁移位置偏好并严格拒绝重复和未知字段", () => {
  const viewport = { width: 1440, height: 900 };
  const legacy = JSON.stringify({ windows: [
    windowRecord("review", "maximized", { x: 24, y: 32, w: 1080, h: 640 }),
    windowRecord("crawl", "normal", { x: 64, y: 56, w: 780, h: 510 }),
    windowRecord("tasks", "minimized", { x: 96, y: 80, w: 820, h: 520 }),
  ] });
  assert.deepEqual(migrateLegacyWindowLayout(legacy, viewport), [
    { appId: "crawl", rect: { x: 64, y: 56, w: 780, h: 510 }, maximized: false },
    { appId: "tasks", rect: { x: 96, y: 80, w: 820, h: 520 }, maximized: false },
    { appId: "review", rect: { x: 24, y: 32, w: 1080, h: 640 }, maximized: true },
  ]);
  for (const windows of [
    [windowRecord("crawl", "normal"), windowRecord("crawl", "maximized")],
    [{ ...windowRecord("crawl", "normal"), backendPath: "/private" }],
    [windowRecord("unknown", "normal")],
  ]) {
    assert.equal(migrateLegacyWindowLayout(JSON.stringify({ windows }), viewport), null);
  }
});

test("阶段 2 storage v2 验证与 v1 迁移共享 window-layer 本地工作区", () => {
  const layerViewport = { width: 1000, height: 600 };
  const layerOptions = { minW: 360, minH: 240, taskbarHeight: 0 };
  const clippedRect = { x: 64, y: 121, w: 720, h: 480 };
  assert.equal(deserializeWindowPlacements(JSON.stringify({ placements: [
    { appId: "crawl", rect: clippedRect, maximized: false },
  ] }), layerViewport, layerOptions), null);

  assert.deepEqual(migrateLegacyWindowLayout(JSON.stringify({ windows: [
    windowRecord("crawl", "normal", clippedRect),
  ] }), layerViewport, layerOptions), [
    { appId: "crawl", rect: { x: 64, y: 120, w: 720, h: 480 }, maximized: false },
  ]);
});

test("阶段 2 正式 DOM 包含五层、交通灯与严格桌面边界", () => {
  assert.equal(normalizeSourceText("lf\ncrlf\r\ncr\r"), "lf\ncrlf\ncr\n");
  assert.equal(typeof desktopModule.initializeDesktop, "function");
  assert.equal("describeApplicationLaunchers" in desktopModule, false);
  const index = readFileSync(new URL("../gdl_backend/webui/index.html", import.meta.url), "utf8");
  const desktopCss = readFileSync(
    new URL("../gdl_backend/webui/styles/desktop.css", import.meta.url),
    "utf8",
  );
  const windowManager = readFileSync(
    new URL("../gdl_backend/webui/js/core/window-manager.js", import.meta.url),
    "utf8",
  );
  const windowWorkspace = readFileSync(
    new URL("../gdl_backend/webui/js/core/window-workspace.js", import.meta.url),
    "utf8",
  );
  const responsiveCss = readFileSync(
    new URL("../gdl_backend/webui/styles/responsive.css", import.meta.url),
    "utf8",
  );
  for (const marker of [
    "data-desktop-wallpaper", "data-menu-bar", "data-window-layer",
    "data-application-center-host", "data-dock", "data-desktop-size-blocker",
    "data-route-announcer",
  ]) assert.equal(index.includes(marker), true, marker);
  assert.equal(index.includes('data-window-workspace="normal"'), true);
  const dockTag = index.match(/<nav[^>]*\bdata-dock\b[^>]*>/u)?.[0] ?? "";
  assert.equal(dockTag, '<nav class="dock" data-dock aria-label="ImageWeave Dock">');
  for (const unsafeBootstrapAttribute of ["hidden", "inert", "aria-hidden"]) {
    assert.doesNotMatch(
      dockTag,
      new RegExp(`(?:^|\\s)${unsafeBootstrapAttribute}(?:\\s|=|>)`, "u"),
    );
  }
  assert.equal(
    index.split('href="./styles/desktop.css?v=20260815.1"').length - 1,
    1,
  );
  assert.equal(index.includes('href="./styles/desktop.css"'), false);
  assert.equal(index.includes("data-start-menu"), false);
  assert.equal(index.includes("data-desktop-icons"), false);
  const trafficOrder = ["data-window-close", "data-window-minimize", "data-window-maximize"];
  assert.deepEqual([...trafficOrder].sort((left, right) => index.indexOf(left) - index.indexOf(right)), trafficOrder);
  assert.equal(index.includes('aria-pressed="false"'), true);
  assert.equal(index.includes('aria-disabled="false"'), true);
  assert.match(desktopCss, /\.window-traffic-light\s*\{[^}]*min-width:\s*30px;[^}]*min-height:\s*30px;/su);
  assert.equal(desktopCss.includes("resize: both"), false);
  assert.equal(responsiveCss.includes("@media (max-width: 1179px), (max-height: 719px)"), true);
  assert.equal(responsiveCss.includes("@media (max-width: 767px)"), false);
  assert.equal(responsiveCss.includes("display: none !important"), true);
  assert.match(
    desktopCss,
    /:root\[data-motion="off"\]\s+:is\([\s\S]*?\.dock__item[\s\S]*?\)\s*\{[^}]*transition:\s*none;/u,
  );
  assert.equal(desktopCss.includes("@media (prefers-reduced-motion: reduce)"), true);
  assert.equal(desktopCss.includes("@media (forced-colors: active)"), true);
  assert.match(
    desktopCss,
    /\.window-layer\[data-window-workspace="maximized"\]\s*\{[^}]*bottom:\s*0;/u,
  );
  const fallbackPredicate = ".window-layer:has(> .application-window[data-window-focused][data-maximized]:not([hidden]))";
  assert.equal(desktopCss.split(fallbackPredicate).length - 1 >= 4, true);
  assert.equal(
    desktopCss.includes(`${fallbackPredicate} {\n  bottom: 0;\n}`),
    true,
  );
  assert.equal(
    desktopCss.includes(`${fallbackPredicate}\n  > .application-window[data-window-focused][data-maximized]:not([hidden]) {\n  left: 0 !important;\n  top: 0 !important;\n  width: 100% !important;\n  height: 100% !important;\n}`),
    true,
  );
  assert.equal(
    desktopCss.includes(`${fallbackPredicate} ~ .dock {\n  display: none;\n  -webkit-backdrop-filter: none !important;\n  backdrop-filter: none !important;\n}`),
    true,
  );
  assert.equal(desktopCss.includes("~ .dock :is(.dock__items, .dock__overflow)"), true);
  assert.match(desktopCss, /\.dock\[hidden\] \.dock__items/u);
  for (const contract of [
    'windowLayer.setAttribute("data-window-workspace", mode)',
    "setElementInert(dock, true)",
    'dock.toggleAttribute("hidden", true)',
    'dock.setAttribute("aria-hidden", "true")',
  ]) assert.equal(windowWorkspace.includes(contract), true, contract);
  const workspaceProjection = windowManager.indexOf(
    "syncWindowWorkspaceMode(windowLayer, dock, workspaceMode)",
  );
  const renderGeometry = windowManager.indexOf(
    "deriveWindowRenderPlan(stack, focusedAppId",
    workspaceProjection,
  );
  assert.equal(workspaceProjection >= 0 && workspaceProjection < renderGeometry, true);
});

test("阶段 2 v2 strict round-trip 拒绝危险、访问器、重复、非有限和非法 rect", () => {
  const viewport = { width: 1440, height: 900 };
  const placements = [
    { appId: "crawl", rect: { x: 64, y: 56, w: 780, h: 510 }, maximized: false },
    { appId: "review", rect: { x: 24, y: 32, w: 1080, h: 640 }, maximized: true },
  ];
  assert.equal(STORAGE_KEYS.windowPlacements, "imageweave.window-placements.v2");
  const serialized = serializeWindowPlacements(placements);
  assert.deepEqual(deserializeWindowPlacements(serialized, viewport), placements);
  for (const forbidden of ["windowState", "focusedAppId", "running", "minimized"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const invalidPayloads = [
    { placements, focusedAppId: "crawl" },
    { placements: [placements[0], placements[0]] },
    { placements: [{ ...placements[0], appId: "unknown" }] },
    { placements: [{ ...placements[0], rect: { ...placements[0].rect, x: Number.NaN } }] },
    { placements: [{ ...placements[0], rect: { ...placements[0].rect, y: Number.POSITIVE_INFINITY } }] },
    { placements: [{ ...placements[0], rect: { ...placements[0].rect, w: 359 } }] },
    { placements: [{ ...placements[0], rect: { ...placements[0].rect, x: 1e12 } }] },
    ...["__proto__", "prototype", "constructor"].map((key) => ({
      placements: [dangerousPlacement(key)],
    })),
  ];
  for (const payload of invalidPayloads) {
    assert.equal(deserializeWindowPlacements(JSON.stringify(payload), viewport), null);
  }

  const accessor = { ...placements[0] };
  let called = false;
  Object.defineProperty(accessor, "rect", {
    enumerable: true,
    get() {
      called = true;
      return placements[0].rect;
    },
  });
  assert.throws(() => serializeWindowPlacements([accessor]), TypeError);
  assert.equal(called, false);
});

test("T6 共享控件使用无色玻璃、完整语义边框与单一 Dialog backdrop", () => {
  const controls = readFileSync(
    new URL("../gdl_backend/webui/styles/controls.css", import.meta.url),
    "utf8",
  );
  const status = readFileSync(
    new URL("../gdl_backend/webui/styles/status.css", import.meta.url),
    "utf8",
  );
  const dialog = readFileSync(
    new URL("../gdl_backend/webui/styles/dialog.css", import.meta.url),
    "utf8",
  );
  const shared = `${controls}\n${status}\n${dialog}`;

  assert.doesNotMatch(shared, /--imageweave-(?!fallback)[\w-]*-solid/u);
  assert.doesNotMatch(shared, /--imageweave-state-[\w-]*-surface/u);
  assert.doesNotMatch(shared, /(?:border-(?:left|right)|inset\s+[34]px\s+0)/u);
  assert.doesNotMatch(shared, /\b(?:100|120|150|180)ms\b/u);

  for (const expected of [
    "background: var(--imageweave-glass-surface-button)",
    "border: var(--imageweave-border-width) solid var(--imageweave-border-button)",
    "border-radius: var(--imageweave-radius-control)",
    "box-shadow: var(--imageweave-shadow-control)",
    "transform: translateY(-2px)",
    "transform: scale(0.97)",
    "var(--imageweave-transition-standard)",
  ]) assert.equal(controls.includes(expected), true, expected);
  assert.match(
    controls,
    /--primary[\s\S]*?border-color:\s*var\(--imageweave-accent\);[\s\S]*?color:\s*var\(--imageweave-accent-highlight\);[\s\S]*?background:\s*var\(--imageweave-glass-surface-button\)/u,
  );
  assert.match(
    controls,
    /--dangerous[\s\S]*?border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-danger\);[\s\S]*?background:\s*var\(--imageweave-glass-surface-button\)/u,
  );
  assert.match(controls, /:is\(:disabled, \[aria-disabled="true"\]\)[\s\S]*?border:[^;]*solid[\s\S]*?opacity:\s*1;[\s\S]*?text-decoration:\s*line-through;[\s\S]*?transform:\s*none;/u);
  assert.match(controls, /:is\(:disabled, \[aria-disabled="true"\]\)[\s\S]*?inset 0 0 0 1px var\(--imageweave-border-weak\)[\s\S]*?font-style:\s*italic;/u);

  for (const expected of [
    "background: var(--imageweave-glass-surface-input)",
    "color: rgb(255 255 255 / 0.35)",
    "background: var(--imageweave-glass-surface-button)",
    "0 0 0 var(--imageweave-focus-width) var(--imageweave-focus-glow)",
    "[aria-invalid=\"true\"]",
    "input[type=\"checkbox\"]",
    "input[type=\"radio\"]",
  ]) assert.equal(controls.includes(expected), true, expected);

  for (const state of ["ready", "running", "warning", "error", "disabled"]) {
    assert.equal(status.includes(`[data-status="${state}"]`), true, state);
  }
  for (const panel of ["crawl", "tasks", "proxy", "vault", "policy", "diagnostics", "gallery", "export"]) {
    assert.equal(status.includes(`data-${panel}-${panel === "crawl" ? "search" : "workspace"}-state`), true, panel);
  }
  assert.equal(status.includes("data-personalization-preview-state"), true);
  assert.equal(status.includes("background: var(--imageweave-glass-surface-secondary)"), true);
  assert.equal(status.includes("section.empty-state"), true);
  assert.equal(status.includes("section.error-view"), true);
  assert.equal(status.includes("var(--imageweave-shadow-card)"), false);

  for (const expected of [
    "background-color: var(--imageweave-glass-surface-default)",
    "blur(var(--imageweave-glass-blur-window))",
    "saturate(var(--imageweave-glass-saturation))",
    "border-radius: var(--imageweave-radius-window)",
    "box-shadow: var(--imageweave-shadow-window)",
    "background: rgb(3 7 18 / 0.68)",
    "background: var(--imageweave-fallback-elevated-solid) !important",
  ]) assert.equal(dialog.includes(expected), true, expected);
  const supportedDialog = dialog.split("@supports ((-webkit-backdrop-filter", 2)[1].split("@supports not", 1)[0];
  assert.equal(supportedDialog.includes(".imageweave-dialog__panel"), false);
  assert.equal(supportedDialog.includes(".imageweave-dialog__actions"), false);

  for (const source of [controls, status, dialog]) {
    assert.equal(source.includes("@media (forced-colors: active)"), true);
  }
  assert.equal(status.includes(':root[data-motion="off"]'), true);
  assert.equal(status.includes("@media (prefers-reduced-motion: reduce)"), true);
  assert.equal(controls.includes("@media (prefers-contrast: more)"), true);
  assert.equal(dialog.includes("@supports not"), true);
});
