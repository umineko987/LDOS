import assert from "node:assert/strict";
import test from "node:test";

import { readSourceText } from "./source-test-text.mjs";
import {
  applicationDefinitions,
  APPLICATION_GROUPS,
  DEFAULT_APP_ID,
  DEFAULT_ROUTE,
} from "../gdl_backend/webui/js/core/app-definitions.js";
import { applications } from "../gdl_backend/webui/js/core/app-registry.js";
import { CRAWL_ENDPOINTS } from "../gdl_backend/webui/js/apps/crawl.js";
import { DIAGNOSTICS_ENDPOINTS } from "../gdl_backend/webui/js/apps/diagnostics.js";
import { POLICY_ENDPOINTS } from "../gdl_backend/webui/js/apps/policy.js";
import { PROXY_ENDPOINTS } from "../gdl_backend/webui/js/apps/proxy.js";
import { REVIEW_ENDPOINTS } from "../gdl_backend/webui/js/apps/review.js";
import { TASKS_ENDPOINTS } from "../gdl_backend/webui/js/apps/tasks.js";
import { VAULT_ENDPOINTS } from "../gdl_backend/webui/js/apps/vault.js";
import { BUILT_IN_WALLPAPER_COLOR_IDS, PERSONALIZATION_DEFAULTS } from "../gdl_backend/webui/js/core/personalization-model.js";
import { createPollingManager } from "../gdl_backend/webui/js/core/polling.js";
import { POLLING_SCOPE_STATES } from "../gdl_backend/webui/js/core/polling-focus-source.js";
import { hashForRoute, parseHashRoute, resolveNavigationTarget } from "../gdl_backend/webui/js/core/router.js";
import {
  deserializeWindowPlacements,
  migrateLegacyWindowLayout,
  serializeWindowPlacements,
} from "../gdl_backend/webui/js/core/storage-layout.js";
import {
  deserializeUiPreferences,
  projectUiPreferences,
  serializeUiPreferences,
} from "../gdl_backend/webui/js/core/storage-preferences.js";
import {
  parseStorageObject,
  readApplicationIdSnapshot,
  readBatchIdSnapshot,
} from "../gdl_backend/webui/js/core/storage-snapshot.js";
import { STORAGE_KEYS } from "../gdl_backend/webui/js/core/storage.js";
import {
  actionCreators,
  createInitialState,
  createStore,
  selectors,
} from "../gdl_backend/webui/js/core/store.js";
import {
  sanitizeTaskPage,
  TASK_DISPLAY_LIMIT,
  TASK_POLL_INTERVAL_MS,
} from "../gdl_backend/webui/js/core/tasks-model.js";
import { deriveDockModel } from "../gdl_backend/webui/js/components/taskbar-windows.js";

const WEBUI = new URL("../gdl_backend/webui/", import.meta.url);
const readWebui = (path) => readSourceText(new URL(path, WEBUI));
const occurrences = (source, value) => source.split(value).length - 1;

const EXPECTED_APPLICATIONS = Object.freeze([
  ["crawl", "图片采集", "download", "/crawl", "图片采集", "workflow", "搜索来源、选择地址并创建有序采集批次。", 0, "ready", "normal"],
  ["tasks", "批次管理", "list", "/tasks", "批次管理", "workflow", "查看采集进度，并取消、重试或重新规划批次。", 1, "ready", "normal"],
  ["proxy", "代理管理", "network", "/proxy", "代理管理", "connections", "管理代理来源、运行池状态与连接探测。", 0, "ready", "normal"],
  ["vault", "授权管理", "key", "/vault", "授权管理", "connections", "管理站点授权、浏览器会话与授权代理。", 1, "ready", "normal"],
  ["review", "去重审核", "images", "/review", "去重审核", "workflow", "比较重复候选、确认保留项并应用整理结果。", 3, "ready", "maximized"],
  ["policy", "站点设置", "sliders", "/policy", "站点设置", "connections", "配置各站点的并发、重试和代理策略。", 2, "ready", "normal"],
  ["diagnostics", "系统诊断", "activity", "/diagnostics", "系统诊断", "system", "检查服务、配置能力与调度器健康状态。", 0, "ready", "normal"],
  ["personalization", "外观设置", "sliders", "/personalization", "外观设置", "system", "调整主题、壁纸、窗口可读性与动效。", 1, "ready", "normal"],
  ["gallery", "图片库", "folder", "/gallery", "图片库", "workflow", "浏览、搜索和整理已下载的图片。", 2, "preview", "normal"],
  ["export", "数据集导出", "archive", "/export", "数据集导出", "workflow", "配置来源并导出审核后的数据集。", 4, "preview", "normal"],
]);

const applicationTuple = (application) => [
  application.id,
  application.label,
  application.icon,
  application.route,
  application.windowTitle,
  application.group,
  application.description,
  application.applicationCenterOrder,
  application.availability,
  application.defaultWindowState,
];

test("[P0 current] 10 个应用的 definition、route、availability 与默认窗口完全固化", () => {
  assert.equal(DEFAULT_APP_ID, "crawl");
  assert.equal(DEFAULT_ROUTE, "/crawl");
  assert.deepEqual(APPLICATION_GROUPS, [
    { id: "workflow", title: "工作流" },
    { id: "connections", title: "连接与策略" },
    { id: "system", title: "系统" },
  ]);
  assert.deepEqual(applicationDefinitions.map(applicationTuple), EXPECTED_APPLICATIONS);
  assert.deepEqual(applications.map(applicationTuple), EXPECTED_APPLICATIONS);
  assert.deepEqual(
    applications.filter(({ availability }) => availability === "ready").map(({ id }) => id),
    ["crawl", "tasks", "proxy", "vault", "review", "policy", "diagnostics", "personalization"],
  );
  assert.deepEqual(
    applications.filter(({ availability }) => availability === "preview").map(({ id }) => id),
    ["gallery", "export"],
  );
  for (const application of applications) {
    for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
      assert.equal(typeof application[hook], "function", `${application.id}.${hook}`);
    }
  }
});

test("[P0 current] 前端消费的 FastAPI endpoint 基线精确且 preview 应用无业务 endpoint", () => {
  assert.deepEqual({
    crawl: CRAWL_ENDPOINTS,
    tasks: TASKS_ENDPOINTS,
    proxy: PROXY_ENDPOINTS,
    vault: VAULT_ENDPOINTS,
    review: REVIEW_ENDPOINTS,
    policy: POLICY_ENDPOINTS,
    diagnostics: DIAGNOSTICS_ENDPOINTS,
    personalization: {},
    gallery: {},
    export: {},
  }, {
    crawl: {
      search: "/api/v1/search",
      autocomplete: "/api/v1/search/autocomplete",
      crawls: "/api/v1/crawls",
    },
    tasks: { crawls: "/api/v1/crawls" },
    proxy: {
      status: "/api/v1/proxy/status",
      start: "/api/v1/proxy/start",
      reload: "/api/v1/proxy/reload",
      probe: "/api/v1/proxy/probe",
      stop: "/api/v1/proxy/stop",
      sources: "/api/v1/proxy/sources",
      subscriptions: "/api/v1/proxy/sources/subscriptions",
      nodeFile: "/api/v1/proxy/sources/node-file",
      inlineNodes: "/api/v1/proxy/sources/inline-nodes",
      override: "/api/v1/proxy/sources/override",
    },
    vault: {
      status: "/api/v1/auth",
      proxy: "/api/v1/auth/proxy",
      browserProfile: "/api/v1/auth/browser-profile",
      pixivOAuthStart: "/api/v1/auth/pixiv/oauth/start",
      pixivOAuthSession: "/api/v1/auth/pixiv/oauth/session",
    },
    review: { crawls: "/api/v1/crawls" },
    policy: { policies: "/api/v1/sites/policies" },
    diagnostics: {
      health: "/healthz",
      readiness: "/readyz",
      config: "/api/v1/config?view=diagnostics",
      scheduler: "/api/v1/scheduler/status?view=diagnostics",
    },
    personalization: {},
    gallery: {},
    export: {},
  });

  for (const name of ["personalization", "gallery", "export"]) {
    const source = readWebui(`js/apps/${name}.js`);
    assert.doesNotMatch(source, /["'`]\/?(?:api\/v1|healthz|readyz)/, name);
  }
});

test("[P0 current] storage key、作用域与 sanitizer/migration 行为固化", () => {
  assert.deepEqual(STORAGE_KEYS, {
    currentApp: "imageweave.ui:current-app",
    activeBatch: "imageweave.ui:active-batch",
    windowLayout: "imageweave.window-layout.v1",
    windowPlacements: "imageweave.window-placements.v2",
    uiPreferences: "imageweave.ui:ui-preferences",
  });

  for (const { id } of applicationDefinitions) assert.equal(readApplicationIdSnapshot(id), id);
  for (const value of ["unknown", "../crawl", "a".repeat(33), "", null]) {
    assert.equal(readApplicationIdSnapshot(value), null);
  }
  assert.equal(readBatchIdSnapshot("batch:p0.1"), "batch:p0.1");
  for (const value of ["../batch", "batch/child", "a".repeat(129), "", null]) {
    assert.equal(readBatchIdSnapshot(value), null);
  }
  for (const value of [null, "", "[]", "null", "{broken", "x".repeat(4097)]) {
    assert.equal(parseStorageObject(value), null);
  }

  assert.deepEqual(deserializeUiPreferences(null), PERSONALIZATION_DEFAULTS);
  assert.deepEqual(
    deserializeUiPreferences('{"animations":"reduced","wallpaperColor":"forest","retired":true}'),
    { animations: "off", wallpaperColor: "forest" },
  );
  assert.deepEqual(
    deserializeUiPreferences('{"constructor":{"prototype":{"polluted":true}},"wallpaperColor":"warm-paper"}'),
    PERSONALIZATION_DEFAULTS,
  );
  assert.equal(
    serializeUiPreferences({ animations: "off", wallpaperColor: "deep-ocean" }),
    '{"animations":"off","wallpaperColor":"deep-ocean"}',
  );
  assert.throws(
    () => projectUiPreferences({ animations: "on", wallpaperColor: "graphite", unknown: true }),
    TypeError,
  );

  const viewport = { width: 1180, height: 720 };
  const placements = [
    { appId: "crawl", rect: { x: 48, y: 36, w: 720, h: 480 }, maximized: false },
    { appId: "review", rect: { x: 96, y: 52, w: 900, h: 600 }, maximized: true },
  ];
  const serialized = serializeWindowPlacements(placements);
  assert.deepEqual(deserializeWindowPlacements(serialized, viewport), placements);
  assert.equal(deserializeWindowPlacements(
    JSON.stringify({ placements, focusedAppId: "review" }),
    viewport,
  ), null);
  assert.equal(deserializeWindowPlacements(JSON.stringify({ placements: [
    { ...placements[0], windowState: "running" },
  ] }), viewport), null);

  assert.deepEqual(migrateLegacyWindowLayout(JSON.stringify({ windows: [
    { appId: "review", windowState: "maximized", rect: placements[1].rect },
    { appId: "tasks", windowState: "minimized", rect: placements[0].rect },
    { appId: "crawl", windowState: "normal", rect: placements[0].rect },
  ] }), viewport), [
    placements[0],
    { appId: "tasks", rect: placements[0].rect, maximized: false },
    placements[1],
  ]);
  assert.equal({}.polluted, undefined);
});

test("[P0 current] Hash 深链接与模拟多窗口状态转移固化", () => {
  for (const application of applicationDefinitions) {
    assert.equal(parseHashRoute(`#${application.route}`), application.route, application.id);
    assert.equal(resolveNavigationTarget(application.id), application.route, application.id);
    assert.equal(resolveNavigationTarget(application.route), application.route, application.id);
    assert.equal(hashForRoute(application.id), `#${application.route}`, application.id);
  }
  for (const malformed of ["", "#", "#/", "#/unknown", "#/crawl?window=tasks", "not-a-hash"]) {
    assert.equal(parseHashRoute(malformed), null, malformed);
  }

  const store = createStore({ initialState: createInitialState(), reportError() {} });
  store.dispatch(actionCreators.windowOpened("review"));
  assert.equal(selectors.windowStack(store.getState())[0].windowState, "maximized");
  store.dispatch(actionCreators.windowOpened("crawl"));
  store.dispatch(actionCreators.windowOpened("tasks"));
  assert.deepEqual(selectors.windowStack(store.getState()).map(({ appId }) => appId), [
    "review", "crawl", "tasks",
  ]);
  store.dispatch(actionCreators.windowFocused("review"));
  assert.equal(selectors.focusedAppId(store.getState()), "review");
  store.dispatch(actionCreators.windowStateChanged("review", "minimized"));
  assert.equal(selectors.focusedAppId(store.getState()), "tasks");
  store.dispatch(actionCreators.windowOpened("review"));
  assert.equal(selectors.windowStack(store.getState()).at(-1).windowState, "normal");
  store.dispatch(actionCreators.windowClosed("review"));
  assert.equal(selectors.focusedAppId(store.getState()), "tasks");

  const dock = deriveDockModel(selectors.windowStack(store.getState()), "tasks");
  assert.deepEqual(dock.items.slice(0, 5).map(({ key, state }) => [key, state]), [
    ["application-center", "launcher"],
    ["app:crawl", "background"],
    ["app:tasks", "focused"],
    ["app:gallery", "closed"],
    ["app:review", "closed"],
  ]);
});

test("[P0 current] 键盘、焦点返回与无障碍 shell 标记固化", () => {
  const index = readWebui("index.html");
  const desktop = readWebui("js/core/desktop.js");
  const menu = readWebui("js/components/menu-bar.js");
  const dock = readWebui("js/components/taskbar-windows.js");
  const center = readWebui("js/components/application-center.js");
  const dialog = readWebui("js/components/dialog.js");

  for (const marker of [
    "data-desktop-wallpaper", "data-menu-bar", "data-window-layer",
    "data-application-center-host", "data-dock", "data-skip-link",
    'data-route-announcer aria-live="polite" aria-atomic="true"',
    'data-window-body tabindex="-1"', 'aria-label="关闭窗口"',
    'aria-label="最小化窗口"', 'aria-label="最大化窗口"',
    'aria-label="调整窗口宽度"', 'aria-label="调整窗口高度"',
    'aria-label="调整窗口宽度和高度"',
  ]) assert.equal(index.includes(marker), true, marker);

  for (const marker of [
    'role: "menu"', 'role: "menuitem"', 'role: "menuitemcheckbox"',
    '["ArrowDown", "ArrowUp", "Home", "End"]', 'event.key === "Escape"',
    "closeMenu({ returnFocus: true })", "isShellShortcutTarget(event.target)",
  ]) assert.equal(menu.includes(marker), true, marker);
  for (const source of [dock, center, dialog]) {
    assert.match(source, /event\.key\s*[!=]==?\s*"Escape"/);
    assert.equal(source.includes("focus({ preventScroll: true })"), true);
    assert.equal(source.includes("removeEventListener"), true);
  }
  assert.match(center, /role:\s*"dialog"[\s\S]*"aria-modal":\s*"true"/);
  assert.match(dialog, /"aria-labelledby"[\s\S]*"aria-describedby"/);
  assert.match(dock, /"aria-pressed": String\(item\.state === "focused"\)/);
  assert.match(desktop, /polling\.stopScope\(mounted\.context\.pollingScope\)/);
  assert.match(desktop, /announcer\.textContent/);
});

class ManualTimers {
  now = 0;
  nextId = 1;
  entries = new Map();

  setTimeout = (callback, delay) => {
    const id = this.nextId;
    this.nextId += 1;
    this.entries.set(id, { callback, at: this.now + delay });
    return id;
  };

  clearTimeout = (id) => this.entries.delete(id);

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.entries.entries()]
        .filter(([, entry]) => entry.at <= target)
        .toSorted((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, entry] = next;
      this.entries.delete(id);
      this.now = entry.at;
      entry.callback();
    }
    this.now = target;
  }
}

const flushMicrotasks = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

test("[P0 current] Tasks、窗口、Crawl 与 Review 的现实现性能特征可重复", async () => {
  assert.equal(TASK_DISPLAY_LIMIT, 1_000);
  assert.equal(TASK_POLL_INTERVAL_MS, 1_500);
  assert.equal(sanitizeTaskPage({ items: Array.from({ length: 1_100 }, (_, index) => ({
    id: `task-${index}`,
    status: "running",
  })) }, "batch-p0").tasks.length, 1_000);

  const tasksApp = readWebui("js/apps/tasks.js");
  const readActive = tasksApp.slice(
    tasksApp.indexOf("const readActive ="),
    tasksApp.indexOf("const refreshAuthority ="),
  );
  assert.equal(occurrences(readActive, "batchSnapshotReceived("), 1);
  assert.match(readActive, /Promise\.all\(\[[\s\S]*taskBatchPath\(batchId\)[\s\S]*\/tasks\?limit=\$\{TASK_DISPLAY_LIMIT\}/);
  assert.match(readActive, /setWorkspacePhase\(/);
  const tasksView = readWebui("js/components/tasks-view.js");
  assert.match(tasksView, /setWorkspacePhase\(phase, message = ""\)[\s\S]*render\(store\.getState\(\)\.batches\)/);
  assert.match(tasksView, /function renderTasks[\s\S]*taskHost\.replaceChildren/);

  const windowInteraction = readWebui("js/core/window-interaction.js");
  const windowDom = readWebui("js/core/window-dom-lifecycle.js");
  assert.doesNotMatch(windowInteraction, /requestAnimationFrame|translate3d/);
  assert.match(windowInteraction, /const move =[\s\S]*applyRect\(instance\.element, interaction\.rect\)/);
  for (const property of ["left", "top", "width", "height"]) {
    assert.match(windowDom, new RegExp(`element\\.style\\.${property} =`));
  }

  const crawlView = readWebui("js/components/crawl-view.js");
  assert.match(crawlView, /data-candidate-key|candidateKey/);
  assert.match(crawlView, /captureCrawlFocusToken[\s\S]*restoreCrawlFocus/);
  assert.match(crawlView, /const renderSourceNavigation[\s\S]*leftSourceHost\.replaceChildren/);
  assert.match(crawlView, /const renderCurrentSource[\s\S]*sourceHost\.replaceChildren/);

  const reviewView = readWebui("js/components/review-view.js");
  const reviewApp = readWebui("js/apps/review.js");
  for (const marker of [
    "cancelHide();", "cancelDraw();", "disconnectLayoutObserver();",
    "releaseStageImages();", "releasePreloads();", 'image.removeAttribute("src")',
    'root.removeEventListener("pointermove"', 'root.removeEventListener("wheel"',
    "unsubscribeRecent();", "unsubscribeReview();",
  ]) assert.equal(reviewView.includes(marker), true, marker);
  assert.match(reviewView, /deactivate\(\)\s*\{[\s\S]*detachInteractions\(\);[\s\S]*releaseImages\(\);/);
  assert.match(reviewView, /destroy\(\)\s*\{[\s\S]*detachInteractions\(\);[\s\S]*releaseImages\(\);/);
  assert.equal(occurrences(reviewApp, "view.deactivate();"), 2);
  assert.equal(reviewApp.includes("view.destroy();"), true);

  const timers = new ManualTimers();
  const focusListeners = new Set();
  let scopeState = POLLING_SCOPE_STATES.OPEN;
  let requests = 0;
  const polling = createPollingManager({
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    now: () => timers.now,
    visibilitySource: { getState: () => "visible", subscribe: () => () => {} },
    focusSource: {
      getFocusedScope: () => "app:tasks",
      getScopeState: () => scopeState,
      subscribe(listener) {
        focusListeners.add(listener);
        return () => focusListeners.delete(listener);
      },
    },
  });
  polling.start({
    key: "p0.tasks",
    scope: "app:tasks",
    intervalMs: TASK_POLL_INTERVAL_MS,
    immediate: true,
    critical: false,
    task: async () => { requests += 1; },
  });
  timers.advance(0);
  await flushMicrotasks();
  assert.equal(requests, 1);
  scopeState = POLLING_SCOPE_STATES.MINIMIZED;
  for (const listener of focusListeners) listener();
  timers.advance(TASK_POLL_INTERVAL_MS * 2);
  await flushMicrotasks();
  assert.equal(requests, 1, "最小化后的连续两个原轮询周期不得发请求");
  assert.equal(polling.getSummary()[0].state, "paused");
  polling.destroy();
});

test("[P0 current] 夜航玻璃、六场景、单窗口主 backdrop 与隐藏退出合成保持", () => {
  assert.deepEqual(BUILT_IN_WALLPAPER_COLOR_IDS, [
    "graphite", "slate", "deep-ocean", "forest", "plum-gray", "warm-paper",
  ]);
  const tokens = readWebui("styles/tokens.css");
  const desktop = readWebui("styles/desktop.css");
  assert.match(tokens, /--imageweave-glass-blur-window:\s*60px/);
  assert.match(tokens, /--imageweave-glass-saturation:\s*180%/);
  assert.match(desktop, /@supports \(\(-webkit-backdrop-filter:[\s\S]*\.application-window\s*\{[\s\S]*backdrop-filter:/);
  assert.match(desktop, /\.application-window\[hidden\][\s\S]*backdrop-filter:\s*none !important/);
  assert.match(desktop, /\.dock\[hidden\][\s\S]*backdrop-filter:\s*none !important/);
  assert.match(desktop, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(desktop, /@media \(forced-colors: active\)/);
  assert.match(desktop, /@supports not \(\(-webkit-backdrop-filter:/);
});
