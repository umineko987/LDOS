import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import diagnosticsApplication, {
  createDiagnosticsController,
  DIAGNOSTICS_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/diagnostics.js";
import { createDiagnosticsView } from "../gdl_backend/webui/js/components/diagnostics-view.js";
import {
  buildDiagnosticsSnapshot,
  createDiagnosticsRequestGate,
  deriveDiagnosticsWorkspacePresentation,
  diagnosticsCopyText,
  DIAGNOSTIC_COMPONENTS,
  DIAGNOSTICS_POLL_INTERVAL_MS,
  sanitizeDiagnosticsConfig,
  sanitizeDiagnosticsScheduler,
  sanitizeHealthDiagnostics,
  sanitizeReadinessDiagnostics,
} from "../gdl_backend/webui/js/core/diagnostics-model.js";
import { actionCreators, createStore } from "../gdl_backend/webui/js/core/store.js";

const SECRET = "stage4-diagnostics-cookie-token-password-secret-173205";
const REQUEST_ID = "diagnostics-request-42";
const APP_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/apps/diagnostics.js", import.meta.url),
  "utf8",
);
const MODEL_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/diagnostics-model.js", import.meta.url),
  "utf8",
);
const VIEW_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/diagnostics-view.js", import.meta.url),
  "utf8",
);
const CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/apps/diagnostics.css", import.meta.url),
  "utf8",
);

function rawHealth(overrides = {}) {
  return {
    ok: true,
    components: {
      process: { status: "ok", summary: SECRET },
      database: { status: "ok", path: `/private/${SECRET}` },
    },
    time: 1_700_000_000,
    raw: SECRET,
    ...overrides,
  };
}

function rawReadiness(overrides = {}) {
  return {
    ready: false,
    components: {
      unknown_component: { status: "ok", summary: SECRET },
      torch: {
        status: "optional_warning",
        version: "2.1+cpu",
        configured_device: "cpu",
        actual_device: "cpu",
        cuda_available: false,
        raw: SECRET,
      },
      database: { status: "ok", path: `/private/${SECRET}` },
      project_proxy: {
        status: "error",
        source_count: 4,
        healthy: 2,
        running: true,
        endpoint: `https://user:${SECRET}@private.invalid`,
      },
      scheduler: {
        status: "ok",
        details: { active: 3, max_concurrent: 20, secret: SECRET },
      },
      process: { status: "ok", summary: SECRET },
      ordered_crawls: {
        status: "ok",
        details: { active_batches: 1, log: SECRET },
      },
      database_duplicate: { status: "error" },
    },
    time: 1_700_000_001,
    raw: SECRET,
    ...overrides,
  };
}

function rawConfig(overrides = {}) {
  return {
    response_profile: "diagnostics",
    secrets_exposed: false,
    server: {
      loopback_only: true,
      cors_enabled: false,
      private_targets_enabled: false,
      host: `https://private.invalid/${SECRET}`,
    },
    gallery: { managed_auth_cache: true, cookie: SECRET },
    proxy: {
      enabled: true,
      auto_start: false,
      transport_core_enabled: true,
      token: SECRET,
    },
    scheduler: { max_concurrent_tasks: 20, raw: SECRET },
    dedup: {
      enabled: true,
      configured_device: "cpu",
      sscd_enabled: true,
      dino_enabled: false,
      model_path: `/private/${SECRET}`,
    },
    raw: SECRET,
    ...overrides,
  };
}

function rawScheduler(overrides = {}) {
  return {
    response_profile: "diagnostics",
    secrets_exposed: false,
    tasks: {
      running: true,
      active: 3,
      max_concurrent: 20,
      active_site_count: 2,
      sites: { pixiv: { token: SECRET } },
      dispatch_loop: { state: "degraded", last_error: SECRET },
    },
    ordered_crawls: {
      running: true,
      active_batches: 1,
      execution_order: "source_then_address",
      address_parallelism: "media_tasks",
      raw: SECRET,
    },
    raw: SECRET,
    ...overrides,
  };
}

function success(data) {
  return { connected: true, data, error: null };
}

function failure({ status = 503, code = "diagnostics_failed", connected = true } = {}) {
  return {
    connected,
    data: null,
    error: {
      status,
      code,
      requestId: REQUEST_ID,
      details: {
        url: `https://private.invalid/${SECRET}`,
        path: `/private/${SECRET}`,
        cookie: SECRET,
      },
      message: SECRET,
    },
  };
}

function completeSnapshot(overrides = {}) {
  return buildDiagnosticsSnapshot({
    health: success(rawHealth()),
    readiness: success(rawReadiness()),
    config: success(rawConfig()),
    scheduler: success(rawScheduler()),
    checkedAt: 1_700_000_123_000,
    ...overrides,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

class DiagnosticsElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.inert = false;
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
  }

  toggleAttribute(name, force) {
    const enabled = force === undefined ? !this.attributes.has(name) : Boolean(force);
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return enabled;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  closest(selector) {
    let current = this;
    while (current instanceof DiagnosticsElement) {
      if (selector === "[data-diagnostics-action]" && current.dataset.diagnosticsAction !== undefined) return current;
      if (selector === "[data-target-app]" && current.dataset.targetApp !== undefined) return current;
      current = current.parentNode;
    }
    return null;
  }

  emit(type, target = this) {
    const event = { type, target, preventDefault() {} };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
}

class DiagnosticsButton extends DiagnosticsElement {
  constructor(action = "", targetApp = "") {
    super("button");
    if (action) this.dataset.diagnosticsAction = action;
    if (targetApp) this.dataset.targetApp = targetApp;
  }
}

function installDiagnosticsDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("Element", DiagnosticsElement);
  install("HTMLElement", DiagnosticsElement);
  install("HTMLButtonElement", DiagnosticsButton);
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function installViewDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  class ViewElement {
    constructor(tagName = "div") {
      this.tagName = tagName.toUpperCase();
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
      this.className = "";
      this.textContent = "";
      this.disabled = false;
      this.hidden = false;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === "hidden") this.hidden = true;
      if (name === "disabled") this.disabled = true;
    }
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === "hidden") this.hidden = false;
      if (name === "disabled") this.disabled = false;
    }
    hasAttribute(name) { return this.attributes.has(name); }
    toggleAttribute(name, force) {
      const enabled = force === undefined ? !this.hasAttribute(name) : Boolean(force);
      if (enabled) this.setAttribute(name, "");
      else this.removeAttribute(name);
      return enabled;
    }
    append(...children) {
      for (const child of children) {
        if (child instanceof ViewElement) {
          child.parentNode = this;
          this.children.push(child);
        }
      }
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      this.append(...children);
    }
    closest(selector) {
      let current = this;
      while (current instanceof ViewElement) {
        if (selector === "[data-component-id]" && current.dataset.componentId !== undefined) return current;
        if (selector === "[hidden]" && current.hidden) return current;
        current = current.parentNode;
      }
      return null;
    }
    focus() { document.activeElement = this; }
  }

  const root = new ViewElement("main");
  root.classList = {
    values: new Set(),
    add(...values) { for (const value of values) this.values.add(value); },
  };
  root.contains = (target) => {
    let current = target;
    while (current instanceof ViewElement) {
      if (current === root) return true;
      current = current.parentNode;
    }
    return false;
  };
  root.querySelectorAll = (selector) => {
    const result = [];
    const visit = (element) => {
      for (const child of element.children) {
        const interactive = ["BUTTON", "A"].includes(child.tagName) || child.hasAttribute("tabindex");
        if (selector === "button, a, [tabindex]" && interactive) result.push(child);
        visit(child);
      }
    };
    visit(root);
    return result;
  };
  const documentObject = {
    activeElement: null,
    createElement: (tagName) => new ViewElement(tagName),
  };
  install("Node", ViewElement);
  install("Element", ViewElement);
  install("HTMLElement", ViewElement);
  install("HTMLButtonElement", ViewElement);
  install("document", documentObject);
  return {
    root,
    ViewElement,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

function createPollingHarness() {
  const entries = new Map();
  const starts = [];
  const stops = [];
  const active = new Map();
  return {
    entries,
    starts,
    stops,
    start(options) {
      starts.push(options);
      entries.set(options.key, options);
      return { key: options.key };
    },
    trigger(key) {
      const options = entries.get(key);
      if (!options) return Promise.resolve(false);
      if (active.has(key)) return active.get(key);
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => options.task(controller.signal))
        .finally(() => {
          if (active.get(key) === promise) active.delete(key);
        });
      promise.controller = controller;
      active.set(key, promise);
      return promise;
    },
    stop(key) {
      stops.push(key);
      entries.delete(key);
      active.get(key)?.controller?.abort();
      return true;
    },
  };
}

function controllerHarness({ apiGet, clipboard } = {}) {
  const root = new DiagnosticsElement("main");
  const store = createStore({ reportError: () => {} });
  const calls = [];
  const api = {
    get(url, options) {
      calls.push([url, options]);
      if (apiGet) return apiGet(url, options, calls.length - 1);
      const payloads = {
        [DIAGNOSTICS_ENDPOINTS.health]: rawHealth(),
        [DIAGNOSTICS_ENDPOINTS.readiness]: rawReadiness(),
        [DIAGNOSTICS_ENDPOINTS.config]: rawConfig(),
        [DIAGNOSTICS_ENDPOINTS.scheduler]: rawScheduler(),
      };
      return Promise.resolve(payloads[url]);
    },
  };
  const polling = createPollingHarness();
  const actionLog = [];
  const viewLog = [];
  const view = {
    setBusy(value) { viewLog.push(["busy", Boolean(value)]); },
    setOperationMessage(message) { viewLog.push(["message", message]); },
    setWorkspacePhase(phase) { viewLog.push(["phase", phase]); },
    destroy() { viewLog.push(["destroy"]); },
  };
  const controller = createDiagnosticsController({
    root,
    api,
    store,
    polling,
    actions: { navigateToApp: (appId) => actionLog.push(appId) },
    pollingScope: "app:diagnostics",
    app: { id: "diagnostics", label: "系统诊断", windowTitle: "系统诊断" },
  }, { createView: () => view, clipboard });
  const click = (action, targetApp = "") => {
    const button = new DiagnosticsButton(action, targetApp);
    root.emit("click", button);
    return button;
  };
  return { root, store, calls, polling, actionLog, viewLog, controller, click };
}

test("Diagnostics model：四响应只保留严格白名单，组件按定义排序且未知/重复被拒绝", () => {
  const health = sanitizeHealthDiagnostics(rawHealth());
  const readiness = sanitizeReadinessDiagnostics(rawReadiness());
  const config = sanitizeDiagnosticsConfig(rawConfig());
  const scheduler = sanitizeDiagnosticsScheduler(rawScheduler());
  const serialized = JSON.stringify({ health, readiness, config, scheduler });

  for (const forbidden of [SECRET, "private.invalid", "/private/", "cookie", "token", '"raw"', '"sites"', "dispatch_loop"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(readiness.components.map((component) => component.id), [
    "process", "database", "project_proxy", "scheduler", "ordered_crawls", "torch",
  ]);
  const componentOrder = readiness.components.map((component) =>
    DIAGNOSTIC_COMPONENTS.findIndex(({ id }) => id === component.id));
  assert.deepEqual(componentOrder, [...componentOrder].sort((a, b) => a - b));
  assert.equal(readiness.components.some(({ id }) => id === "unknown_component"), false);
  assert.equal(new Set(readiness.components.map(({ id }) => id)).size, readiness.components.length);
  const dedup = sanitizeReadinessDiagnostics(rawReadiness({ components: {
    dedup: {
      status: "ok",
      configured_resources: { workers: 2, deep_batch_size: 16, neighbor_block_size: 512, secret: SECRET },
    },
  } }));
  assert.equal(dedup.components[0].detail, "工作线程 2 · 批大小 16 · 分块 512");
  assert.equal(Object.hasOwn(config, "server"), false);
  assert.equal(Object.hasOwn(scheduler, "tasks"), false);
  assert.throws(() => sanitizeDiagnosticsConfig({ ...rawConfig(), secrets_exposed: true }), TypeError);
  assert.throws(() => sanitizeDiagnosticsScheduler({ ...rawScheduler(), response_profile: "legacy" }), TypeError);
});

test("Diagnostics model：错误只留 status/code/requestId，部分与离线逐分区合并并显式 stale", () => {
  const previous = completeSnapshot();
  const partial = buildDiagnosticsSnapshot({
    health: success(rawHealth({ ok: false })),
    readiness: failure({ code: `bad code ${SECRET}` }),
    config: success(rawConfig({ proxy: { enabled: false } })),
    scheduler: failure({ status: 0, code: "network_error", connected: false }),
    checkedAt: 1_700_000_124_000,
    previous,
  });
  assert.equal(partial.health.ok, false);
  assert.equal(partial.readiness, previous.readiness);
  assert.equal(partial.config.proxyEnabled, false);
  assert.equal(partial.scheduler, previous.scheduler);
  assert.equal(partial.connected, true);
  assert.equal(partial.offline, false);
  assert.equal(partial.stale, true);
  assert.deepEqual(partial.staleSections, ["readiness", "scheduler"]);
  assert.deepEqual(partial.errors.readiness, {
    status: 503,
    code: "request_failed",
    requestId: REQUEST_ID,
  });
  assert.equal(Object.hasOwn(partial.errors.readiness, "details"), false);

  const offline = buildDiagnosticsSnapshot({
    health: failure({ status: 0, code: "network_error", connected: false }),
    readiness: failure({ status: 0, code: "network_error", connected: false }),
    config: failure({ status: 0, code: "network_error", connected: false }),
    scheduler: failure({ status: 0, code: "network_error", connected: false }),
    checkedAt: 1_700_000_125_000,
    previous,
  });
  assert.equal(offline.offline, true);
  assert.equal(offline.stale, true);
  assert.deepEqual(offline.staleSections, ["health", "readiness", "config", "scheduler"]);
  assert.equal(offline.health, previous.health);
  assert.equal(offline.readiness, previous.readiness);
  assert.equal(offline.config, previous.config);
  assert.equal(offline.scheduler, previous.scheduler);

  const firstPartial = buildDiagnosticsSnapshot({
    health: success(rawHealth()),
    readiness: failure(),
    config: success(rawConfig()),
    scheduler: failure(),
    checkedAt: 1_700_000_126_000,
  });
  assert.equal(firstPartial.health.ok, true);
  assert.equal(firstPartial.readiness, null);
  assert.equal(firstPartial.config.proxyEnabled, true);
  assert.equal(firstPartial.scheduler, null);
  assert.deepEqual(firstPartial.staleSections, []);
  assert.equal(JSON.stringify({ partial, offline, firstPartial }).includes(SECRET), false);

  const invalidWithoutTransportError = buildDiagnosticsSnapshot({
    health: success({ ok: "yes" }),
    readiness: success(rawReadiness()),
    config: success(rawConfig()),
    scheduler: success(rawScheduler()),
  });
  assert.deepEqual(invalidWithoutTransportError.errors.health, {
    status: 0,
    code: "invalid_response",
    requestId: "",
  });
  assert.throws(() => actionCreators.diagnosticsReceived({ connected: true }), TypeError);

  const httpHealth = buildDiagnosticsSnapshot({
    health: { connected: true, data: null, response: rawHealth({ ok: false }), error: failure().error },
    readiness: success(rawReadiness()),
    config: success(rawConfig()),
    scheduler: success(rawScheduler()),
  });
  assert.equal(httpHealth.health.ok, false);
  assert.equal(httpHealth.errors.health.status, 503);
  assert.equal(httpHealth.stale, false);
});

test("Diagnostics model：copy 唯一安全摘要不含 request ID、URL、路径、token/cookie/password/secret", () => {
  const snapshot = buildDiagnosticsSnapshot({
    health: failure({ code: "network_error" }),
    readiness: success(rawReadiness()),
    config: success(rawConfig()),
    scheduler: success(rawScheduler()),
    checkedAt: 1_700_000_127_000,
  });
  const copy = diagnosticsCopyText(snapshot);
  assert.match(copy, /ImageWeave 诊断摘要/);
  assert.match(copy, /连接：/);
  assert.match(copy, /检查时间：/);
  for (const forbidden of [SECRET, REQUEST_ID, "private.invalid", "/private/", "https://", "token", "cookie", "password", "secret", "raw config", "log"] ) {
    assert.equal(copy.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.doesNotMatch(VIEW_SOURCE + APP_SOURCE, /clipboard\.writeText\((?!text\))/);
  assert.match(APP_SOURCE, /diagnosticsCopyText\(snapshot\)/);
});

test("Diagnostics model：workspace presentation 纯函数覆盖 loading/content/partial/offline/error/refreshing/stale", () => {
  const complete = completeSnapshot();
  const partial = buildDiagnosticsSnapshot({
    health: success(rawHealth()), readiness: failure(), config: success(rawConfig()), scheduler: success(rawScheduler()),
  });
  const stale = buildDiagnosticsSnapshot({
    health: failure(), readiness: success(rawReadiness()), config: success(rawConfig()), scheduler: success(rawScheduler()), previous: complete,
  });
  const offline = buildDiagnosticsSnapshot({
    health: failure({ status: 0, connected: false }),
    readiness: failure({ status: 0, connected: false }),
    config: failure({ status: 0, connected: false }),
    scheduler: failure({ status: 0, connected: false }),
    previous: complete,
  });
  const firstError = buildDiagnosticsSnapshot({
    health: failure({ status: 0, connected: false }),
    readiness: failure({ status: 0, connected: false }),
    config: failure({ status: 0, connected: false }),
    scheduler: failure({ status: 0, connected: false }),
  });
  const cases = [
    ["loading", deriveDiagnosticsWorkspacePresentation()],
    ["content", deriveDiagnosticsWorkspacePresentation({ snapshot: complete })],
    ["partial", deriveDiagnosticsWorkspacePresentation({ snapshot: partial })],
    ["stale", deriveDiagnosticsWorkspacePresentation({ snapshot: stale })],
    ["offline", deriveDiagnosticsWorkspacePresentation({ snapshot: offline })],
    ["error", deriveDiagnosticsWorkspacePresentation({ snapshot: firstError })],
    ["refreshing", deriveDiagnosticsWorkspacePresentation({ snapshot: complete, refreshing: true })],
  ];
  for (const [state, presentation] of cases) {
    assert.equal(presentation.state, state);
    assert.equal(Boolean(presentation.label), true);
    assert.equal(Boolean(presentation.message), true);
    assert.equal(["ready", "running", "warning", "error", "disabled"].includes(presentation.kind), true);
  }
});

test("Diagnostics request gate：旧 cycle、重叠 begin 与生命周期推进均不可提交", () => {
  const gate = createDiagnosticsRequestGate();
  const first = gate.beginCycle();
  const second = gate.beginCycle();
  assert.equal(gate.isCycleCurrent(second), true);
  assert.equal(gate.isCycleCurrent(first), false);
  gate.advanceLifecycle();
  assert.equal(gate.isCycleCurrent(second), false);
  const third = gate.beginCycle();
  assert.equal(gate.isCycleCurrent(third), true);
});

test("Diagnostics controller：activate immediate 四并发 + 20s，manual 复用同 key 且 single-flight", async () => {
  const restoreDom = installDiagnosticsDom();
  try {
    const pending = new Map(Object.values(DIAGNOSTICS_ENDPOINTS).map((endpoint) => [endpoint, deferred()]));
    const harness = controllerHarness({ apiGet: (url) => pending.get(url).promise });
    harness.controller.activate();
    const poll = harness.polling.entries.get("diagnostics.snapshot");
    assert.equal(poll.intervalMs, DIAGNOSTICS_POLL_INTERVAL_MS);
    assert.equal(poll.intervalMs, 20_000);
    assert.equal(poll.scope, "app:diagnostics");
    assert.equal(poll.immediate, true);
    assert.equal(poll.critical, false);

    const cycle = harness.polling.trigger("diagnostics.snapshot");
    await flush();
    assert.deepEqual(harness.calls.map(([url]) => url).sort(), Object.values(DIAGNOSTICS_ENDPOINTS).sort());
    harness.click("refresh");
    harness.click("refresh");
    await flush();
    assert.equal(harness.calls.length, 4);

    pending.get(DIAGNOSTICS_ENDPOINTS.health).resolve(rawHealth());
    pending.get(DIAGNOSTICS_ENDPOINTS.readiness).resolve(rawReadiness());
    pending.get(DIAGNOSTICS_ENDPOINTS.config).resolve(rawConfig());
    pending.get(DIAGNOSTICS_ENDPOINTS.scheduler).resolve(rawScheduler());
    await cycle;
    await flush();
    assert.equal(Boolean(harness.store.getState().diagnostics.snapshot), true);
    assert.equal(harness.viewLog.filter(([kind, busy]) => kind === "busy" && busy).length, 1);
    assert.equal(harness.viewLog.some(([kind, phase]) => kind === "phase" && phase === "content"), true);
    harness.controller.destroy();
  } finally {
    restoreDom();
  }
});

test("Diagnostics controller：poll task 直调与 manual 重叠仍复用同一 cycle gate", async () => {
  const restoreDom = installDiagnosticsDom();
  try {
    const pending = new Map(Object.values(DIAGNOSTICS_ENDPOINTS).map((endpoint) => [endpoint, deferred()]));
    const harness = controllerHarness({ apiGet: (url) => pending.get(url).promise });
    harness.controller.activate();
    const poll = harness.polling.entries.get("diagnostics.snapshot");
    const direct = poll.task(new AbortController().signal);
    await flush();
    harness.click("refresh");
    harness.click("refresh");
    await flush();
    assert.equal(harness.calls.length, 4);
    pending.get(DIAGNOSTICS_ENDPOINTS.health).resolve(rawHealth());
    pending.get(DIAGNOSTICS_ENDPOINTS.readiness).resolve(rawReadiness());
    pending.get(DIAGNOSTICS_ENDPOINTS.config).resolve(rawConfig());
    pending.get(DIAGNOSTICS_ENDPOINTS.scheduler).resolve(rawScheduler());
    await direct;
    await flush();
    assert.equal(Boolean(harness.store.getState().diagnostics.snapshot), true);
    harness.controller.destroy();
  } finally {
    restoreDom();
  }
});

test("Diagnostics controller：deactivate/destroy abort 且旧 Promise.all cycle 不提交", async () => {
  const restoreDom = installDiagnosticsDom();
  try {
    for (const lifecycle of ["deactivate", "destroy"]) {
      const reads = Object.fromEntries(Object.values(DIAGNOSTICS_ENDPOINTS).map((endpoint) => [endpoint, deferred()]));
      const signals = [];
      const harness = controllerHarness({
        apiGet(url, options) {
          signals.push(options.signal);
          return reads[url].promise;
        },
      });
      harness.controller.activate();
      const cycle = harness.polling.trigger("diagnostics.snapshot");
      await flush();
      harness.controller[lifecycle]();
      assert.equal(signals.every((signal) => signal.aborted), true, lifecycle);
      reads[DIAGNOSTICS_ENDPOINTS.health].resolve(rawHealth());
      reads[DIAGNOSTICS_ENDPOINTS.readiness].resolve(rawReadiness());
      reads[DIAGNOSTICS_ENDPOINTS.config].resolve(rawConfig());
      reads[DIAGNOSTICS_ENDPOINTS.scheduler].resolve(rawScheduler());
      await cycle;
      await flush();
      assert.equal(harness.store.getState().diagnostics.snapshot, null, lifecycle);
      assert.equal(harness.polling.entries.has("diagnostics.snapshot"), false, lifecycle);
      if (lifecycle === "deactivate") harness.controller.destroy();
    }
  } finally {
    restoreDom();
  }
});

test("Diagnostics controller：deactivate 后立即 re-activate 时旧 cycle cleanup 不清除新 cycle gate", async () => {
  const restoreDom = installDiagnosticsDom();
  try {
    const first = new Map(Object.values(DIAGNOSTICS_ENDPOINTS).map((endpoint) => [endpoint, deferred()]));
    const second = new Map(Object.values(DIAGNOSTICS_ENDPOINTS).map((endpoint) => [endpoint, deferred()]));
    let generation = 0;
    const harness = controllerHarness({ apiGet: (url) => (generation === 0 ? first : second).get(url).promise });
    harness.controller.activate();
    const oldCycle = harness.polling.trigger("diagnostics.snapshot");
    await flush();
    harness.controller.deactivate();

    generation = 1;
    harness.controller.activate();
    const poll = harness.polling.entries.get("diagnostics.snapshot");
    const newCycle = poll.task(new AbortController().signal);
    await flush();
    assert.equal(harness.calls.length, 8);
    second.get(DIAGNOSTICS_ENDPOINTS.health).resolve(rawHealth({ ok: false }));
    second.get(DIAGNOSTICS_ENDPOINTS.readiness).resolve(rawReadiness());
    second.get(DIAGNOSTICS_ENDPOINTS.config).resolve(rawConfig());
    second.get(DIAGNOSTICS_ENDPOINTS.scheduler).resolve(rawScheduler());
    await newCycle;
    const committed = harness.store.getState().diagnostics.snapshot;
    assert.equal(committed.health.ok, false);

    first.get(DIAGNOSTICS_ENDPOINTS.health).resolve(rawHealth({ ok: true }));
    first.get(DIAGNOSTICS_ENDPOINTS.readiness).resolve(rawReadiness());
    first.get(DIAGNOSTICS_ENDPOINTS.config).resolve(rawConfig());
    first.get(DIAGNOSTICS_ENDPOINTS.scheduler).resolve(rawScheduler());
    await oldCycle;
    await flush();
    assert.equal(harness.store.getState().diagnostics.snapshot, committed);
    harness.controller.destroy();
  } finally {
    restoreDom();
  }
});

test("Diagnostics controller：非 2xx 安全响应体仍投影 health/ready，错误元数据保持安全", async () => {
  const restoreDom = installDiagnosticsDom();
  try {
    const harness = controllerHarness({
      apiGet(url) {
        if (url === DIAGNOSTICS_ENDPOINTS.health) {
          return Promise.reject(Object.assign(new Error(SECRET), {
            status: 503,
            code: "http_error",
            requestId: REQUEST_ID,
            details: rawHealth({ ok: false }),
          }));
        }
        if (url === DIAGNOSTICS_ENDPOINTS.readiness) {
          return Promise.reject(Object.assign(new Error(SECRET), {
            status: 503,
            code: "http_error",
            requestId: REQUEST_ID,
            details: rawReadiness(),
          }));
        }
        return Promise.resolve(url === DIAGNOSTICS_ENDPOINTS.config ? rawConfig() : rawScheduler());
      },
    });
    harness.controller.activate();
    await harness.polling.trigger("diagnostics.snapshot");
    const snapshot = harness.store.getState().diagnostics.snapshot;
    assert.equal(snapshot.health.ok, false);
    assert.equal(snapshot.readiness.ready, false);
    assert.equal(snapshot.stale, false);
    assert.deepEqual(snapshot.errors.health, { status: 503, code: "http_error", requestId: REQUEST_ID });
    assert.equal(JSON.stringify(snapshot).includes(SECRET), false);
    harness.controller.destroy();
  } finally {
    restoreDom();
  }
});

test("Diagnostics controller：单项失败不丢其余三项，partial/offline 保留上次对应分区", async () => {
  const restoreDom = installDiagnosticsDom();
  try {
    let cycle = 0;
    const harness = controllerHarness({
      apiGet(url) {
        if (cycle === 0) {
          const values = {
            [DIAGNOSTICS_ENDPOINTS.health]: rawHealth(),
            [DIAGNOSTICS_ENDPOINTS.readiness]: rawReadiness(),
            [DIAGNOSTICS_ENDPOINTS.config]: rawConfig(),
            [DIAGNOSTICS_ENDPOINTS.scheduler]: rawScheduler(),
          };
          return Promise.resolve(values[url]);
        }
        if (cycle === 1 && url === DIAGNOSTICS_ENDPOINTS.readiness) {
          return Promise.reject(Object.assign(new Error(SECRET), {
            status: 503, code: "ready_failed", requestId: REQUEST_ID, details: { secret: SECRET },
          }));
        }
        if (cycle === 1) {
          const values = {
            [DIAGNOSTICS_ENDPOINTS.health]: rawHealth({ ok: false }),
            [DIAGNOSTICS_ENDPOINTS.config]: rawConfig({ proxy: { enabled: false } }),
            [DIAGNOSTICS_ENDPOINTS.scheduler]: rawScheduler({ tasks: { active: 7, max_concurrent: 20 } }),
          };
          return Promise.resolve(values[url]);
        }
        return Promise.reject(Object.assign(new Error(SECRET), {
          status: 0, code: "network_error", requestId: REQUEST_ID, details: { secret: SECRET },
        }));
      },
    });
    harness.controller.activate();
    await harness.polling.trigger("diagnostics.snapshot");
    const initial = harness.store.getState().diagnostics.snapshot;

    cycle = 1;
    await harness.polling.trigger("diagnostics.snapshot");
    const partial = harness.store.getState().diagnostics.snapshot;
    assert.equal(partial.health.ok, false);
    assert.deepEqual(partial.readiness, initial.readiness);
    assert.equal(partial.config.proxyEnabled, false);
    assert.equal(partial.scheduler.activeTasks, 7);
    assert.deepEqual(partial.staleSections, ["readiness"]);

    cycle = 2;
    await harness.polling.trigger("diagnostics.snapshot");
    const offline = harness.store.getState().diagnostics.snapshot;
    assert.equal(offline.offline, true);
    assert.deepEqual(offline.health, partial.health);
    assert.deepEqual(offline.readiness, partial.readiness);
    assert.deepEqual(offline.config, partial.config);
    assert.deepEqual(offline.scheduler, partial.scheduler);
    assert.equal(JSON.stringify({ store: harness.store.getState().diagnostics, view: harness.viewLog }).includes(SECRET), false);
    harness.controller.destroy();
  } finally {
    restoreDom();
  }
});

test("Diagnostics controller：clipboard success/failure/unavailable 均可读且只复制 diagnosticsCopyText", async () => {
  const restoreDom = installDiagnosticsDom();
  try {
    const copied = [];
    const successHarness = controllerHarness({ clipboard: { writeText: async (text) => copied.push(text) } });
    successHarness.store.dispatch(actionCreators.diagnosticsReceived(completeSnapshot()));
    successHarness.controller.activate();
    successHarness.click("copy");
    await flush();
    assert.deepEqual(copied, [diagnosticsCopyText(successHarness.store.getState().diagnostics.snapshot)]);
    assert.equal(successHarness.viewLog.some(([kind, message]) => kind === "message" && /已复制/.test(message)), true);
    successHarness.controller.destroy();

    const denied = controllerHarness({ clipboard: { writeText: async () => { throw new Error(SECRET); } } });
    denied.store.dispatch(actionCreators.diagnosticsReceived(completeSnapshot()));
    denied.controller.activate();
    denied.click("copy");
    await flush();
    assert.equal(denied.viewLog.some(([kind, message]) => kind === "message" && /未允许|权限/.test(message)), true);
    assert.equal(JSON.stringify(denied.viewLog).includes(SECRET), false);
    denied.controller.destroy();

    const unavailable = controllerHarness({ clipboard: null });
    unavailable.store.dispatch(actionCreators.diagnosticsReceived(completeSnapshot()));
    unavailable.controller.activate();
    unavailable.click("copy");
    await flush();
    assert.equal(unavailable.viewLog.some(([kind, message]) => kind === "message" && /不可用|未允许/.test(message)), true);
    unavailable.controller.destroy();
  } finally {
    restoreDom();
  }
});

test("Diagnostics controller：recovery navigate 精确 allowlist，tampered dataset 不导航", async () => {
  const restoreDom = installDiagnosticsDom();
  try {
    const harness = controllerHarness();
    harness.controller.activate();
    for (const appId of ["proxy", "tasks", "vault", "review", "diagnostics", "../proxy", "", SECRET]) {
      harness.click("navigate", appId);
    }
    await flush();
    assert.deepEqual(harness.actionLog, ["proxy", "tasks"]);
    harness.controller.destroy();
  } finally {
    restoreDom();
  }
});

test("Diagnostics view：真实 DOM builder/render 覆盖首次、内容、陈旧、离线与焦点恢复", () => {
  const globals = installViewDom();
  try {
    const store = createStore({ reportError: () => {} });
    const context = {
      root: globals.root,
      store,
      app: { id: "diagnostics", label: "系统诊断", windowTitle: "DIAG.EXE" },
    };
    const view = createDiagnosticsView(context);
    assert.equal(view.elements.workspace.attributes.get("tabindex"), "0");
    assert.equal(view.elements.workspaceState.dataset.diagnosticsWorkspaceState, "loading");
    assert.equal(view.elements.copyButton.disabled, true);

    const snapshot = completeSnapshot();
    store.dispatch(actionCreators.diagnosticsReceived(snapshot));
    assert.equal(view.elements.workspaceState.dataset.diagnosticsWorkspaceState, "content");
    assert.equal(view.elements.copyButton.disabled, false);
    assert.equal(view.elements.componentHost.children.length > 0, true);
    view.elements.refreshButton.focus();
    view.render(snapshot);
    assert.equal(globalThis.document.activeElement.dataset.diagnosticsFocus, "refresh");

    view.setBusy(true);
    assert.equal(globals.root.hasAttribute("aria-busy"), true);
    assert.equal(view.elements.refreshButton.textContent, "正在刷新…");
    view.setBusy(false);
    view.setWorkspacePhase("stale", {
      state: "stale", kind: "warning", label: "部分快照陈旧", message: "陈旧分区已标记。",
    });
    assert.equal(view.elements.workspaceState.dataset.diagnosticsWorkspaceState, "stale");
    assert.equal(view.elements.workspaceMessage.textContent, "陈旧分区已标记。");
    view.setOperationMessage("复制失败，可重试。");
    assert.equal(view.elements.operationLive.textContent, "复制失败，可重试。");

    const stale = buildDiagnosticsSnapshot({
      health: failure(), readiness: success(rawReadiness()), config: success(rawConfig()), scheduler: success(rawScheduler()), previous: snapshot,
    });
    view.render(stale);
    assert.equal(view.elements.warningHost.children.length > 0, true);
    const offline = buildDiagnosticsSnapshot({
      health: failure({ status: 0, connected: false }),
      readiness: failure({ status: 0, connected: false }),
      config: failure({ status: 0, connected: false }),
      scheduler: failure({ status: 0, connected: false }),
      previous: stale,
    });
    view.render(offline);
    assert.equal(view.elements.workspaceState.dataset.diagnosticsWorkspaceState, "offline");
    view.destroy();
    assert.equal(globals.root.children.length, 0);
  } finally {
    globals.restore();
  }
});

test("Diagnostics DOM/CSS：三栏、聚焦横向 owner、独立纵滚、aria-live、content-solid 与稳定焦点", () => {
  for (const contract of [
    /diagnostics-workspace-track/,
    /className:\s*"diagnostics-workspace"[\s\S]*tabindex:\s*"0"/,
    /01 · 摘要/,
    /02 · 服务事实/,
    /03 · 组件与恢复/,
    /diagnostics-column-scroll/,
    /aria-live/,
    /manual refresh|手动刷新|刷新诊断/,
    /复制诊断摘要/,
    /安全配置/,
    /任务调度/,
    /下一步/,
    /data.*component.*id|componentId/,
  ]) assert.match(VIEW_SOURCE, contract);
  assert.match(VIEW_SOURCE, /diagnosticsFocusToken/);
  assert.match(VIEW_SOURCE, /restoreDiagnosticsFocus/);
  assert.match(VIEW_SOURCE, /data.*diagnostics.*workspace.*state|diagnosticsWorkspaceState/);
  assert.match(CSS_SOURCE, /\.window-body:has\(> \.diagnostics-app\)/);
  assert.match(CSS_SOURCE, /\.diagnostics-workspace\s*\{[^}]*overflow-x\s*:\s*auto/s);
  assert.match(CSS_SOURCE, /\.diagnostics-workspace-track\s*\{[^}]*grid-template-columns\s*:[^;]*minmax[^;]*minmax[^;]*minmax[^;]*;/s);
  assert.match(CSS_SOURCE, /\.diagnostics-workspace-track\s*\{[^}]*min-width\s*:\s*(?:1080|1100|1120|1140|1160)px/s);
  assert.match(CSS_SOURCE, /\.diagnostics-column-scroll\s*\{[^}]*overflow-y\s*:\s*auto/s);
  assert.match(CSS_SOURCE, /\.application-window\[data-maximized\] \.diagnostics-workspace-track\s*\{[^}]*min-width\s*:\s*100%/s);
  assert.match(CSS_SOURCE, /--imageweave-surface-content-solid/);
  assert.match(CSS_SOURCE, /forced-colors/);
  assert.match(CSS_SOURCE, /prefers-reduced-motion/);
  assert.match(CSS_SOURCE, /data-motion="off"/);
  assert.doesNotMatch(CSS_SOURCE, /@media\s*\(max-width\s*:/);
  assert.doesNotMatch(CSS_SOURCE, /backdrop-filter/);
});

test("Diagnostics application：默认 mount/activate/deactivate/unmount 生命周期可复用", () => {
  const restoreDom = installDiagnosticsDom();
  try {
    const store = createStore({ reportError: () => {} });
    const polling = createPollingHarness();
    const root = new DiagnosticsElement("main");
    const context = {
      root,
      store,
      polling,
      api: { get: () => Promise.resolve({}) },
      actions: { navigateToApp() {} },
      pollingScope: "app:diagnostics",
      app: { id: "diagnostics", label: "系统诊断", windowTitle: "DIAG.EXE" },
    };
    const originalDocument = globalThis.document;
    const originalNode = globalThis.Node;
    class BareNode extends DiagnosticsElement {
      constructor(tagName = "div") {
        super(tagName);
        this.children = [];
        this.textContent = "";
      }
      append(...children) {
        for (const child of children) {
          if (child instanceof BareNode) {
            child.parentNode = this;
            this.children.push(child);
          }
        }
      }
      replaceChildren(...children) {
        this.children = [];
        this.append(...children);
      }
      querySelectorAll() { return []; }
      contains() { return false; }
    }
    root.classList = { add() {} };
    root.children = [];
    root.replaceChildren = (...children) => { root.children = children; };
    root.querySelectorAll = () => [];
    root.contains = () => false;
    Object.defineProperty(globalThis, "Node", { configurable: true, writable: true, value: BareNode });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: { activeElement: null, createElement: (tag) => new BareNode(tag) },
    });
    try {
      diagnosticsApplication.mount(context);
      assert.throws(() => diagnosticsApplication.mount(context), /已挂载/);
      diagnosticsApplication.activate();
      assert.equal(polling.entries.has("diagnostics.snapshot"), true);
      diagnosticsApplication.deactivate();
      assert.equal(polling.entries.has("diagnostics.snapshot"), false);
      diagnosticsApplication.unmount();
      diagnosticsApplication.unmount();
    } finally {
      if (originalNode === undefined) delete globalThis.Node;
      else Object.defineProperty(globalThis, "Node", { configurable: true, writable: true, value: originalNode });
      if (originalDocument === undefined) delete globalThis.document;
      else Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: originalDocument });
    }
  } finally {
    restoreDom();
  }
});

test("Diagnostics static boundary：四 endpoint 精确、无旁路 I/O/storage/console/innerHTML/fixture/伪终端/raw log 且四生命周期", () => {
  assert.deepEqual(DIAGNOSTICS_ENDPOINTS, {
    health: "/healthz",
    readiness: "/readyz",
    config: "/api/v1/config?view=diagnostics",
    scheduler: "/api/v1/scheduler/status?view=diagnostics",
  });
  for (const endpoint of Object.values(DIAGNOSTICS_ENDPOINTS)) {
    assert.equal(APP_SOURCE.split(`"${endpoint}"`).length - 1, 1, endpoint);
  }
  assert.equal((APP_SOURCE.match(/"\/api\/v1\//g) || []).length, 2);
  const combined = [APP_SOURCE, MODEL_SOURCE, VIEW_SOURCE].join("\n");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /globalThis\.fetch/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /console\./,
    /innerHTML/,
    /tests\/fixtures|fixtures\/webui/,
    /createElement\(["'](?:pre|textarea)["']/,
    /伪终端|原始日志|raw log/i,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.match(APP_SOURCE, /Promise\.all\(/);
  assert.match(APP_SOURCE, /createDiagnosticsRequestGate/);
  assert.match(APP_SOURCE, /advanceLifecycle/);
  assert.match(APP_SOURCE, /\.abort\(\)/);
  assert.match(APP_SOURCE, /DIAGNOSTICS_POLL_KEY = "diagnostics\.snapshot"/);
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof diagnosticsApplication[hook], "function");
  }
  assert.equal(typeof createDiagnosticsController, "function");
});
