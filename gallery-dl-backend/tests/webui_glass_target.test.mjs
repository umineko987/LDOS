import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationDefinitions,
  validateApplicationDefinitions,
} from "../gdl_backend/webui/js/core/app-definitions.js";
import { getApplicationById } from "../gdl_backend/webui/js/core/app-registry.js";
import * as routerModule from "../gdl_backend/webui/js/core/router.js";
import * as storageContractModule from "../gdl_backend/webui/js/core/storage-contract.js";
import * as storageLayoutModule from "../gdl_backend/webui/js/core/storage-layout.js";
import * as dockModule from "../gdl_backend/webui/js/components/taskbar-windows.js";

const PREVIEW_APP_IDS = Object.freeze(["gallery", "export"]);
const APPLICATION_CENTER_GROUPS = Object.freeze([
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

function targetFunction(module, name) {
  assert.equal(
    typeof module[name],
    "function",
    `${name} 尚未实现；该断言属于玻璃桌面目标契约`,
  );
  return module[name];
}

function windowRecord(appId, windowState, rect = { x: 80, y: 72, w: 720, h: 480 }) {
  return { appId, windowState, rect };
}

function dockItemSnapshot(item) {
  return {
    key: item.key,
    appId: item.appId ?? null,
    state: item.state,
    activation: item.activation,
  };
}

test("目标路由：空 Hash 与未知 Hash 留在桌面，合法深链接保持应用路由", () => {
  const { hashForRoute, parseHashRoute, resolveNavigationTarget } = routerModule;

  for (const hash of ["", "#", "#/", "#/unknown", "#/crawl?window=tasks", "not-a-hash"]) {
    assert.equal(parseHashRoute(hash), null, hash);
  }
  assert.equal(parseHashRoute("#/crawl"), "/crawl");
  assert.equal(parseHashRoute("#/review"), "/review");
  assert.equal(resolveNavigationTarget(null), null);
  assert.equal(resolveNavigationTarget("unknown"), null);
  assert.equal(hashForRoute(null), "");
  assert.equal(hashForRoute("/unknown"), "");
  assert.equal(hashForRoute("/crawl"), "#/crawl");
});

test("目标 availability：preview 可校验、可启动且三项预览应用使用统一语义", () => {
  const projected = applicationDefinitions.map((definition) => ({
    ...definition,
    availability: PREVIEW_APP_IDS.includes(definition.id)
      ? "preview"
      : definition.availability,
  }));
  assert.doesNotThrow(() => validateApplicationDefinitions(projected));

  for (const appId of PREVIEW_APP_IDS) {
    const application = getApplicationById(appId);
    assert.equal(application?.availability, "preview", appId);
    assert.equal(routerModule.parseHashRoute(`#${application.route}`), application.route, appId);
    assert.equal(routerModule.resolveNavigationTarget(appId), application.route, appId);
  }
});

test("目标应用中心：分组、职责与全部 10 项完全由 application definitions 投影", async () => {
  for (const definition of applicationDefinitions) {
    assert.equal(typeof definition.group, "string", `${definition.id}.group`);
    assert.equal(typeof definition.description, "string", `${definition.id}.description`);
    assert.notEqual(definition.description.trim(), "", `${definition.id}.description`);
  }

  const applicationCenterModule = await import(
    "../gdl_backend/webui/js/components/application-center.js"
  );
  const deriveApplicationCenterGroups = targetFunction(
    applicationCenterModule,
    "deriveApplicationCenterGroups",
  );
  const groups = deriveApplicationCenterGroups(applicationDefinitions);
  assert.deepEqual(
    groups.map((group) => ({
      id: group.id,
      title: group.title,
      appIds: group.items.map((item) => item.id),
    })),
    APPLICATION_CENTER_GROUPS,
  );
  assert.deepEqual(
    groups.flatMap((group) => group.items.map((item) => item.id)).sort(),
    applicationDefinitions.map((definition) => definition.id).sort(),
  );
});

test("目标 Dock 模型：固定项与运行项去重，并投影 closed/focused/background/minimized", () => {
  const deriveDockModel = targetFunction(dockModule, "deriveDockModel");
  const stack = [
    windowRecord("tasks", "normal"),
    windowRecord("proxy", "minimized"),
    windowRecord("vault", "normal"),
    windowRecord("review", "normal"),
  ];
  const model = deriveDockModel(stack, "review", { visibleLimit: 6 });

  assert.deepEqual(model.items.map(dockItemSnapshot), [
    { key: "application-center", appId: null, state: "launcher", activation: "open-center" },
    { key: "app:crawl", appId: "crawl", state: "closed", activation: "open" },
    { key: "app:tasks", appId: "tasks", state: "background", activation: "focus" },
    { key: "app:gallery", appId: "gallery", state: "closed", activation: "open" },
    { key: "app:review", appId: "review", state: "focused", activation: "minimize" },
    { key: "app:proxy", appId: "proxy", state: "minimized", activation: "restore" },
    { key: "app:vault", appId: "vault", state: "background", activation: "focus" },
  ]);
  assert.deepEqual(model.visible.map((item) => item.key), [
    "application-center",
    "app:crawl",
    "app:tasks",
    "app:gallery",
    "app:review",
    "app:proxy",
  ]);
  assert.deepEqual(model.overflow.map((item) => item.key), ["app:vault"]);
});

test("目标 Dock 动作：四种窗口状态和应用中心入口只委托既有 shell action", () => {
  const activateDockItem = targetFunction(dockModule, "activateDockItem");
  const calls = [];
  const handlers = {
    openApplicationCenter: () => calls.push(["center"]),
    open: (appId) => calls.push(["open", appId]),
    minimize: (appId) => calls.push(["minimize", appId]),
    focus: (appId) => calls.push(["focus", appId]),
    restore: (appId) => calls.push(["restore", appId]),
  };

  assert.equal(activateDockItem({ key: "application-center", activation: "open-center" }, handlers), true);
  assert.equal(activateDockItem({ key: "app:crawl", appId: "crawl", activation: "open" }, handlers), true);
  assert.equal(activateDockItem({ key: "app:review", appId: "review", activation: "minimize" }, handlers), true);
  assert.equal(activateDockItem({ key: "app:tasks", appId: "tasks", activation: "focus" }, handlers), true);
  assert.equal(activateDockItem({ key: "app:proxy", appId: "proxy", activation: "restore" }, handlers), true);
  assert.deepEqual(calls, [
    ["center"],
    ["open", "crawl"],
    ["minimize", "review"],
    ["focus", "tasks"],
    ["restore", "proxy"],
  ]);
});

test("目标位置迁移：旧工作区只提取按应用排序的位置和最大化偏好", () => {
  const migrateLegacyWindowLayout = targetFunction(
    storageLayoutModule,
    "migrateLegacyWindowLayout",
  );
  const legacy = JSON.stringify({
    windows: [
      windowRecord("review", "maximized", { x: 24, y: 32, w: 1080, h: 640 }),
      windowRecord("crawl", "normal", { x: 64, y: 56, w: 780, h: 510 }),
      windowRecord("tasks", "minimized", { x: 96, y: 80, w: 820, h: 520 }),
    ],
  });

  assert.deepEqual(
    migrateLegacyWindowLayout(legacy, { width: 1440, height: 900 }),
    [
      { appId: "crawl", rect: { x: 64, y: 56, w: 780, h: 510 }, maximized: false },
      { appId: "tasks", rect: { x: 96, y: 80, w: 820, h: 520 }, maximized: false },
      { appId: "review", rect: { x: 24, y: 32, w: 1080, h: 640 }, maximized: true },
    ],
  );
  for (const windows of [
    [{ ...windowRecord("crawl", "normal"), backendPath: "/private" }],
    [windowRecord("crawl", "normal"), windowRecord("crawl", "maximized")],
  ]) {
    assert.equal(
      migrateLegacyWindowLayout(JSON.stringify({ windows }), { width: 1440, height: 900 }),
      null,
    );
  }
});

test("目标位置存储：版本化 key 与严格 round-trip 不保存运行、焦点或最小化事实", () => {
  const deserializeWindowPlacements = targetFunction(
    storageLayoutModule,
    "deserializeWindowPlacements",
  );
  const serializeWindowPlacements = targetFunction(
    storageLayoutModule,
    "serializeWindowPlacements",
  );
  const placements = [
    { appId: "crawl", rect: { x: 64, y: 56, w: 780, h: 510 }, maximized: false },
    { appId: "review", rect: { x: 24, y: 32, w: 1080, h: 640 }, maximized: true },
  ];

  assert.equal(
    storageContractModule.STORAGE_KEYS.windowPlacements,
    "imageweave.window-placements.v2",
  );
  assert.equal(
    storageContractModule.STORAGE_KEYS.windowLayout,
    "imageweave.window-layout.v1",
  );
  const serialized = serializeWindowPlacements(placements);
  assert.deepEqual(JSON.parse(serialized), { placements });
  for (const forbidden of ["windowState", "focusedAppId", "running", "minimized"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(
    deserializeWindowPlacements(serialized, { width: 1440, height: 900 }),
    placements,
  );
  assert.equal(
    deserializeWindowPlacements(JSON.stringify({
      placements,
      focusedAppId: "crawl",
    }), { width: 1440, height: 900 }),
    null,
  );
});
