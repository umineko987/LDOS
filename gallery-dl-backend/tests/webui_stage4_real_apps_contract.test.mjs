import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { actionCreators, createStore } from "../gdl_backend/webui/js/core/store.js";
import tasksApplication, {
  createTasksController,
  taskBatchPath,
  TASKS_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/tasks.js";
import {
  createBatchRequestGate,
  deriveTasksWorkspacePresentation,
  filterRecentBatches,
  formatTaskBytes,
  sanitizeBatchDetail,
  sanitizeRecentBatches,
  sanitizeTaskPage,
  shouldPollBatch,
  TASK_POLL_INTERVAL_MS,
  taskErrorCategory,
  taskErrorGuidance,
  taskFileFacts,
  taskRecoveryTargets,
  TERMINAL_BATCH_STATUSES,
  validateBatchId,
} from "../gdl_backend/webui/js/core/tasks-model.js";
import {
  createTasksView,
  taskResultText,
} from "../gdl_backend/webui/js/components/tasks-view.js";

const SECRET = "stage4-task-cookie-token-secret-314159";
const TASKS_APP_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/apps/tasks.js", import.meta.url),
  "utf8",
);
const TASKS_MODEL_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/tasks-model.js", import.meta.url),
  "utf8",
);
const TASKS_VIEW_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/tasks-view.js", import.meta.url),
  "utf8",
);
const TASKS_CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/apps/tasks.css", import.meta.url),
  "utf8",
);

function rawBatch(overrides = {}) {
  return {
    id: "batch-stage4",
    status: "running",
    output_dir: `/private/${SECRET}`,
    concurrency: 12,
    max_tasks: 500,
    task_count: 4,
    succeeded_task_count: 1,
    failed_task_count: 1,
    cancelled_task_count: 0,
    pre_dedup_skipped_count: 2,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_030,
    sources: [{
      order: 0,
      site: "pixiv",
      status: "running",
      addresses: [{
        id: "address-stage4",
        address_order: 0,
        label: "画师作品",
        address_type: "account",
        status: "running",
        planned_task_count: 4,
        succeeded_task_count: 1,
        failed_task_count: 1,
        cancelled_task_count: 0,
        pre_dedup_skipped_count: 2,
        probed_proxy_count: 3,
        healthy_proxy_count: 2,
        url: `https://private.invalid/?token=${SECRET}`,
        planning_error: `planning ${SECRET}`,
      }],
    }],
    current: {
      address_id: "address-stage4",
      source_order: 0,
      address_order: 0,
      site: "pixiv",
      status: "running",
      url: `https://private.invalid/current?token=${SECRET}`,
    },
    review: null,
    resumable: false,
    ...overrides,
  };
}

function rawTask(overrides = {}) {
  return {
    id: "task-stage4",
    crawl_address_id: "address-stage4",
    site: "pixiv",
    status: "failed",
    source_order: 0,
    address_order: 0,
    sequence_no: 2,
    attempt_count: 1,
    max_attempts: 3,
    artifact_count: 2,
    artifact_bytes: 5_242_880,
    last_error_class: "credentials_unavailable",
    last_error: `cookie=${SECRET}`,
    url: `https://private.invalid/media?token=${SECRET}`,
    output_dir: `/private/${SECRET}`,
    cookies_file: `/private/${SECRET}.txt`,
    ...overrides,
  };
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
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

class TestElement {
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

  append(child) {
    child.parentNode = this;
  }

  closest(selector) {
    let current = this;
    while (current instanceof TestElement) {
      const match = /^\[data-tasks-action(?:="([^"]+)")?\]$/.exec(selector);
      if (match && current.dataset.tasksAction !== undefined &&
          (match[1] === undefined || current.dataset.tasksAction === match[1])) return current;
      current = current.parentNode;
    }
    return null;
  }

  emit(type, target = this) {
    const event = { type, target };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
}

class TestButton extends TestElement {
  constructor(action = "") {
    super("button");
    if (action) this.dataset.tasksAction = action;
  }
}

function installControllerDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("Element", TestElement);
  install("HTMLElement", TestElement);
  install("HTMLButtonElement", TestButton);
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function createPollingHarness() {
  const entries = new Map();
  const starts = [];
  const stops = [];
  return {
    entries,
    starts,
    stops,
    start(options) {
      starts.push(options);
      entries.set(options.key, options);
    },
    stop(key) {
      stops.push(key);
      entries.delete(key);
    },
  };
}

function controllerHarness({
  activeBatchId = "batch-stage4",
  apiGet,
  apiPost,
  dialogChoice = "confirm",
} = {}) {
  const root = new TestElement("main");
  const store = createStore({ reportError: () => {} });
  if (activeBatchId) store.dispatch(actionCreators.activeBatchIdChanged(activeBatchId));
  const calls = [];
  const api = {
    get(url, options) {
      calls.push(["get", url, options]);
      return apiGet ? apiGet(url, options) : Promise.resolve({ items: [] });
    },
    post(url, payload, options) {
      calls.push(["post", url, payload, options]);
      return apiPost ? apiPost(url, payload, options) : Promise.resolve({});
    },
  };
  const polling = createPollingHarness();
  const actionLog = [];
  const actions = {
    setActiveBatchId(batchId) {
      actionLog.push(["active", batchId]);
      store.dispatch(actionCreators.activeBatchIdChanged(batchId));
    },
    navigateToApp(appId) {
      actionLog.push(["navigate", appId]);
    },
  };
  const dialogOptions = [];
  const dialogs = {
    async open(options) {
      dialogOptions.push(options);
      return dialogChoice;
    },
    destroy() {},
  };
  const viewLog = [];
  const view = {
    elements: {},
    selectedRecentId: () => "",
    clearError: () => viewLog.push(["clear-error"]),
    showError: (guidance) => viewLog.push(["error", guidance]),
    setBusy: (kind) => viewLog.push(["busy", kind]),
    setOperationMessage: (message) => viewLog.push(["message", message]),
    setWorkspacePhase: (phase, message = "") => viewLog.push(["phase", phase, message]),
    destroy: () => viewLog.push(["destroy"]),
  };
  const controller = createTasksController({
    root,
    api,
    store,
    polling,
    storage: { readActiveBatchId: () => "" },
    actions,
    dialogs,
    pollingScope: "app:tasks",
    app: { id: "tasks", label: "批次管理", windowTitle: "批次管理" },
  }, {
    createView: () => view,
  });
  return {
    root,
    store,
    calls,
    polling,
    actions,
    actionLog,
    dialogs,
    dialogOptions,
    view,
    viewLog,
    controller,
  };
}

function getCallUrl(call) {
  return call[1];
}

test("4A model：批次、地址、任务、错误分类与文件事实均为安全白名单", () => {
  const batch = sanitizeBatchDetail(rawBatch());
  const taskPage = sanitizeTaskPage({ items: [rawTask(), rawTask({
    id: "task-proxy",
    artifact_count: 0,
    artifact_bytes: 0,
    last_error_class: "proxy_exhausted",
  })] }, batch.id);
  const serialized = JSON.stringify({ batch, taskPage });

  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("private.invalid"), false);
  assert.equal(serialized.includes("output_dir"), false);
  assert.equal(batch.sources[0].addresses[0].hasPlanningIssue, true);
  assert.equal(taskPage.tasks[0].addressId, "address-stage4");
  assert.equal(taskPage.tasks[0].artifactCount, 2);
  assert.equal(taskPage.tasks[0].artifactBytes, 5_242_880);
  assert.deepEqual(taskErrorCategory(taskPage.tasks[0].errorClass), {
    id: "authentication",
    label: "授权失效",
    kind: "warning",
    targetApp: "vault",
  });
  assert.equal(taskErrorCategory(taskPage.tasks[1].errorClass).id, "proxy");
  assert.deepEqual(taskRecoveryTargets(taskPage.tasks), {
    authSites: ["pixiv"],
    proxyIssue: true,
  });
  assert.deepEqual(taskFileFacts(taskPage.tasks), {
    taskCount: 2,
    taskWithFilesCount: 1,
    artifactCount: 2,
    artifactBytes: 5_242_880,
  });
  assert.equal(formatTaskBytes(5_242_880), "5.0 MiB");
  assert.equal(taskResultText(taskPage.tasks[0]), "授权失效 · 已记录 2 个文件 / 5.0 MiB");
  assert.equal(taskErrorCategory("authentication").id, "authentication");
  assert.equal(taskErrorCategory("network_timeout").id, "network");
  assert.equal(taskErrorCategory("rate_limit").id, "rate_limit");
  assert.equal(taskErrorCategory("extraction_error").id, "extraction");
  assert.equal(taskErrorCategory("artifact_write_failed").id, "storage");
  assert.equal(taskErrorCategory("cancelled").id, "cancelled");
  assert.equal(taskErrorCategory("backend_restart").id, "unknown");
  assert.equal(taskErrorCategory(""), null);
});

test("4A model：最近批次筛选、活动/终态与七种显式工作区状态", () => {
  const recent = sanitizeRecentBatches({ items: [
    rawBatch({ id: "batch-running", status: "running" }),
    rawBatch({ id: "batch-errors", status: "completed_with_errors", resumable: true }),
    rawBatch({ id: "batch-done", status: "succeeded" }),
    rawBatch({ id: "batch-cancelled", status: "cancelled" }),
  ] });
  assert.deepEqual(filterRecentBatches(recent, "active").map((item) => item.id), ["batch-running"]);
  assert.deepEqual(filterRecentBatches(recent, "attention").map((item) => item.id), [
    "batch-errors", "batch-cancelled",
  ]);
  assert.deepEqual(filterRecentBatches(recent, "terminal").map((item) => item.id), [
    "batch-errors", "batch-done", "batch-cancelled",
  ]);
  assert.throws(() => filterRecentBatches(recent, "unknown"), TypeError);

  const running = sanitizeBatchDetail(rawBatch({ status: "running" }));
  const terminal = sanitizeBatchDetail(rawBatch({ status: "cancelled" }));
  assert.equal(shouldPollBatch(running), true);
  assert.equal(shouldPollBatch(terminal), false);
  assert.equal(TERMINAL_BATCH_STATUSES.has("cancelled"), true);

  const states = [
    ["loading", { phase: "loading", batch: null }],
    ["empty", { phase: "idle", batch: null }],
    ["content", { phase: "idle", batch: running }],
    ["partial", { phase: "partial", batch: running }],
    ["error", { phase: "error", batch: null }],
    ["terminal", { phase: "idle", batch: terminal }],
    ["writing", { phase: "writing", batch: terminal }],
  ];
  for (const [expected, input] of states) {
    const presentation = deriveTasksWorkspacePresentation(input);
    assert.equal(presentation.state, expected);
    assert.equal(Boolean(presentation.label), true);
    assert.equal(Boolean(presentation.message), true);
    assert.equal(["ready", "running", "warning", "error", "disabled"].includes(presentation.kind), true);
  }
});

test("4A model：404/409/422/transport/auth/proxy 错误只产生安全分类与恢复动作", () => {
  const cases = [
    [{ status: 404, code: "crawl_not_found", requestId: "request-404", details: SECRET }, "diagnostics", "批次不存在"],
    [{ status: 409, code: "crawl_not_finished", message: `https://private/${SECRET}` }, "diagnostics", "批次状态已变化"],
    [{ status: 422, code: "invalid_crawl", message: `/private/${SECRET}` }, "diagnostics", "批次参数无效"],
    [{ status: 0, code: "network_error", message: SECRET }, "diagnostics", "批次操作失败"],
    [{ status: 401, code: "credentials_unavailable" }, "vault", "批次操作失败"],
    [{ status: 503, code: "proxy_pool_unavailable" }, "proxy", "批次操作失败"],
  ];
  for (const [error, targetApp, title] of cases) {
    const guidance = taskErrorGuidance(error);
    assert.equal(guidance.targetApp, targetApp);
    assert.equal(guidance.title, title);
    assert.equal(Boolean(guidance.message), true);
    assert.equal(Boolean(guidance.nextStep), true);
    assert.equal(JSON.stringify(guidance).includes(SECRET), false);
    assert.equal(JSON.stringify(guidance).includes("https://"), false);
    assert.equal(JSON.stringify(guidance).includes("/private/"), false);
  }
});

test("4A model/controller：批次 ID 严格校验、编码与 crawl-media 批次重试路径", () => {
  assert.equal(validateBatchId("batch:stage4.1"), "batch:stage4.1");
  assert.equal(taskBatchPath("batch:stage4.1"), "/api/v1/crawls/batch%3Astage4.1");
  assert.equal(taskBatchPath("batch:stage4.1", "/tasks?limit=1000"), "/api/v1/crawls/batch%3Astage4.1/tasks?limit=1000");
  assert.equal(taskBatchPath("batch:stage4.1", "/retry"), "/api/v1/crawls/batch%3Astage4.1/retry");
  for (const invalid of ["", " batch", "batch ", "../batch", "batch/child", "批次", "a".repeat(129)]) {
    assert.throws(() => validateBatchId(invalid), TypeError, invalid);
    assert.throws(() => taskBatchPath(invalid), TypeError, invalid);
  }
  assert.doesNotMatch(TASKS_APP_SOURCE, /\/api\/v1\/tasks/);
  assert.match(TASKS_APP_SOURCE, /taskBatchPath\(batchId, "\/retry"\)/);
});

test("4A request gate：写入和生命周期推进使旧 detail/tasks 读取不可提交", () => {
  const gate = createBatchRequestGate();
  const first = gate.beginRead("batch-stage4");
  const second = gate.beginRead("batch-stage4");
  assert.equal(gate.isReadCurrent(second, "batch-stage4"), true);
  assert.equal(gate.isReadCurrent(first, "batch-stage4"), false);

  const beforeWrite = gate.beginRead("batch-stage4");
  const write = gate.beginWrite();
  assert.equal(gate.isReadCurrent(beforeWrite, "batch-stage4"), false);
  assert.equal(gate.isWriteCurrent(write), true);
  gate.advanceLifecycle();
  assert.equal(gate.isWriteCurrent(write), false);
});

test("4A controller：1.5s 只轮询活动批次，权威终态到达后停止", async () => {
  const restore = installControllerDom();
  try {
    let detail = rawBatch({ status: "running" });
    const harness = controllerHarness({
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30") return Promise.resolve({ items: [detail] });
        if (url.endsWith("/tasks?limit=1000")) return Promise.resolve({ items: [rawTask({ status: "running", last_error_class: "" })] });
        if (url === "/api/v1/crawls/batch-stage4") return Promise.resolve(detail);
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.controller.activate();
    await flush();

    const poll = harness.polling.entries.get("batches.active");
    assert.equal(poll.intervalMs, TASK_POLL_INTERVAL_MS);
    assert.equal(poll.intervalMs, 1_500);
    assert.equal(poll.scope, "app:tasks");
    assert.equal(shouldPollBatch(harness.store.getState().batches.active), true);

    detail = rawBatch({ status: "succeeded", task_count: 1, succeeded_task_count: 1, failed_task_count: 0 });
    await poll.task(new AbortController().signal);
    await flush();
    assert.equal(harness.store.getState().batches.active.status, "succeeded");
    assert.equal(harness.polling.entries.has("batches.active"), false);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "terminal"), true);

    harness.controller.deactivate();
    assert.equal(harness.polling.entries.has("batches.active"), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：无活动批次时只读 recent，不启动轮询", async () => {
  const restore = installControllerDom();
  try {
    const harness = controllerHarness({
      activeBatchId: "",
      apiGet(url) {
        assert.equal(url, "/api/v1/crawls?limit=30");
        return Promise.resolve({ items: [rawBatch({ id: "batch-recent-only" })] });
      },
    });
    harness.controller.activate();
    await flush();
    assert.deepEqual(harness.calls.map(getCallUrl), ["/api/v1/crawls?limit=30"]);
    assert.equal(harness.polling.entries.has("batches.active"), false);
    assert.equal(harness.store.getState().batches.active, null);
    assert.equal(harness.store.getState().batches.recent[0].id, "batch-recent-only");
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "empty"), true);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：404 清 active/snapshot，错误恢复不保留陈旧 Store", async () => {
  const restore = installControllerDom();
  try {
    const missing = Object.assign(new Error(SECRET), {
      status: 404,
      code: "crawl_not_found",
      requestId: "request-stage4",
    });
    const harness = controllerHarness({
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30") return Promise.resolve({ items: [] });
        if (url.endsWith("/tasks?limit=1000")) return Promise.resolve({ items: [] });
        if (url === "/api/v1/crawls/batch-stage4") return Promise.reject(missing);
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.store.dispatch(actionCreators.batchSnapshotReceived(rawBatch(), { items: [rawTask()] }));
    harness.controller.activate();
    await flush();

    assert.equal(harness.store.getState().batches.activeId, "");
    assert.equal(harness.store.getState().batches.active, null);
    assert.deepEqual(harness.store.getState().batches.tasks, []);
    assert.equal(harness.polling.entries.has("batches.active"), false);
    assert.deepEqual(harness.actionLog.at(-1), ["active", ""]);
    assert.equal(JSON.stringify(harness.viewLog).includes(SECRET), false);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "message" && entry[1].includes("已不存在")), true);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：取消确认被拒绝时不写入且活动轮询继续", async () => {
  const restore = installControllerDom();
  try {
    const running = rawBatch({ status: "running" });
    const harness = controllerHarness({
      dialogChoice: "cancel",
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30") return Promise.resolve({ items: [running] });
        if (url.endsWith("/tasks?limit=1000")) return Promise.resolve({ items: [rawTask({ status: "running", last_error_class: "" })] });
        if (url === "/api/v1/crawls/batch-stage4") return Promise.resolve(running);
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.controller.activate();
    await flush();
    harness.root.emit("click", new TestButton("cancel"));
    await flush();
    assert.equal(harness.dialogOptions.length, 1);
    assert.equal(harness.dialogOptions[0].dangerous, true);
    assert.equal(harness.calls.some((call) => call[0] === "post"), false);
    assert.equal(harness.polling.entries.has("batches.active"), true);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：危险重试确认后只走批次路径，并按 detail/tasks/recent 权威重读", async () => {
  const restore = installControllerDom();
  try {
    const terminal = rawBatch({
      status: "completed_with_errors",
      resumable: true,
      task_count: 1,
      succeeded_task_count: 0,
      failed_task_count: 1,
    });
    let detailReads = 0;
    let taskReads = 0;
    let recentReads = 0;
    const harness = controllerHarness({
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30") {
          recentReads += 1;
          return Promise.resolve({ items: [terminal] });
        }
        if (url.endsWith("/tasks?limit=1000")) {
          taskReads += 1;
          return Promise.resolve({ items: [rawTask()] });
        }
        if (url === "/api/v1/crawls/batch-stage4") {
          detailReads += 1;
          return Promise.resolve(detailReads === 1 ? terminal : rawBatch({ status: "running", resumable: false }));
        }
        throw new Error(`unexpected GET ${url}`);
      },
      apiPost: () => Promise.resolve({
        batch: rawBatch({ status: "succeeded" }),
        raw: SECRET,
      }),
    });
    harness.controller.activate();
    await flush();
    const before = { detailReads, taskReads, recentReads };

    harness.root.emit("click", new TestButton("retry"));
    await flush();

    const post = harness.calls.find((call) => call[0] === "post");
    assert.equal(getCallUrl(post), "/api/v1/crawls/batch-stage4/retry");
    assert.deepEqual(post[2], { additional_attempts: 2 });
    assert.equal(harness.dialogOptions.length, 1);
    assert.equal(harness.dialogOptions[0].dangerous, true);
    assert.equal(Boolean(harness.dialogOptions[0].confirmationText), true);
    assert.equal(detailReads, before.detailReads + 1);
    assert.equal(taskReads, before.taskReads + 1);
    assert.equal(recentReads, before.recentReads + 1);
    assert.equal(harness.store.getState().batches.active.status, "running");
    assert.equal(JSON.stringify(harness.store.getState()).includes(SECRET), false);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "writing"), true);
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "content"), true);
    assert.equal(harness.calls.some((call) => getCallUrl(call).includes("/api/v1/tasks")), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：写后权威重读失败保留 partial 非颜色状态", async () => {
  const restore = installControllerDom();
  try {
    const terminal = rawBatch({ status: "completed_with_errors", resumable: true });
    let detailReads = 0;
    const harness = controllerHarness({
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30" && detailReads <= 1) {
          return Promise.resolve({ items: [terminal] });
        }
        if (url.endsWith("/tasks?limit=1000") && detailReads <= 1) {
          return Promise.resolve({ items: [rawTask()] });
        }
        if (url === "/api/v1/crawls/batch-stage4" && detailReads === 0) {
          detailReads += 1;
          return Promise.resolve(terminal);
        }
        return Promise.reject(Object.assign(new Error(SECRET), {
          status: 503,
          code: "proxy_pool_unavailable",
        }));
      },
      apiPost: () => Promise.resolve({ ignored: SECRET }),
    });
    harness.controller.activate();
    await flush();
    harness.root.emit("click", new TestButton("retry"));
    await flush();

    assert.equal(harness.store.getState().batches.active.status, "completed_with_errors");
    assert.equal(harness.viewLog.some((entry) => entry[0] === "phase" && entry[1] === "partial"), true);
    assert.equal(JSON.stringify(harness.viewLog).includes(SECRET), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A controller：deactivate 后写响应与后续读取均不得污染 Store", async () => {
  const restore = installControllerDom();
  try {
    const write = deferred();
    const terminal = rawBatch({ status: "completed_with_errors", resumable: true });
    const harness = controllerHarness({
      apiGet(url) {
        if (url === "/api/v1/crawls?limit=30") return Promise.resolve({ items: [terminal] });
        if (url.endsWith("/tasks?limit=1000")) return Promise.resolve({ items: [rawTask()] });
        if (url === "/api/v1/crawls/batch-stage4") return Promise.resolve(terminal);
        throw new Error(`unexpected GET ${url}`);
      },
      apiPost: () => write.promise,
    });
    harness.controller.activate();
    await flush();
    const authoritative = harness.store.getState().batches.active;

    harness.root.emit("click", new TestButton("retry"));
    await flush();
    const callsBeforeDeactivate = harness.calls.length;
    harness.controller.deactivate();
    write.resolve({ batch: rawBatch({ status: "running" }), secret: SECRET });
    await flush();

    assert.equal(harness.store.getState().batches.active, authoritative);
    assert.equal(harness.calls.length, callsBeforeDeactivate);
    assert.equal(harness.polling.entries.has("batches.active"), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4A view：三段语义、筛选/终态、来源地址任务错误文件事实与恢复动作", () => {
  assert.equal(typeof createTasksView, "function");
  assert.equal(typeof taskResultText, "function");
  for (const contract of [
    /createElement\("aside"/,
    /createElement\("main"/,
    /tasks-workspace-track/,
    /最近批次/,
    /批次筛选/,
    /活动批次|当前活动/,
    /来源地址与任务/,
    /错误分类/,
    /文件事实/,
    /取消批次/,
    /重试未完成项/,
    /重新规划/,
    /打开授权管理/,
    /打开代理管理/,
    /打开去重审核/,
    /data.*tasks.*workspace|tasksWorkspace/,
    /tabindex/,
  ]) assert.match(TASKS_VIEW_SOURCE, contract);
  for (const state of ["loading", "content", "partial", "error", "terminal", "writing"]) {
    assert.match(TASKS_MODEL_SOURCE + TASKS_VIEW_SOURCE, new RegExp(`\\b${state}\\b`));
  }
  assert.match(TASKS_VIEW_SOURCE, /尚未选择批次|暂无批次/);
  assert.doesNotMatch(TASKS_VIEW_SOURCE, /VAULT\.CPL|TASKMGR\.EXE|PROXY\.CPL/);
});

test("4A CSS：普通 800x560 有局部可聚焦横向 scroll owner，最大化三栏独立纵向滚动", () => {
  assert.match(TASKS_CSS_SOURCE, /\.window-body:has\(> \.tasks-app\)/);
  assert.match(TASKS_CSS_SOURCE, /\.tasks-workspace\s*\{[^}]*overflow-x\s*:\s*auto/s);
  assert.match(TASKS_CSS_SOURCE, /\.tasks-workspace-track\s*\{[^}]*grid-template-columns\s*:[^;]*minmax[^;]*minmax[^;]*minmax[^;]*;/s);
  assert.match(TASKS_CSS_SOURCE, /\.tasks-workspace-track\s*\{[^}]*min-width\s*:\s*(?:1080|1100|1120|1140|1160)px/s);
  assert.match(TASKS_CSS_SOURCE, /\.tasks-column-scroll\s*\{[^}]*overflow-y\s*:\s*auto/s);
  assert.match(TASKS_CSS_SOURCE, /\.application-window\[data-maximized\] \.tasks-workspace-track\s*\{[^}]*min-width\s*:\s*100%/s);
  assert.match(TASKS_CSS_SOURCE, /--imageweave-surface-content-solid/);
  assert.match(TASKS_CSS_SOURCE, /forced-colors/);
  assert.match(TASKS_CSS_SOURCE, /prefers-reduced-motion|data-motion/);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /@media\s*\(max-width:\s*767px\)/);
  assert.doesNotMatch(TASKS_CSS_SOURCE, /backdrop-filter/);
  assert.match(TASKS_VIEW_SOURCE, /className:\s*"tasks-workspace"[\s\S]*tabindex:\s*"0"/);
});

test("4A static boundary：唯一 crawls endpoint、无旁路 I/O/storage/console/innerHTML 且生命周期不变", () => {
  assert.deepEqual(TASKS_ENDPOINTS, { crawls: "/api/v1/crawls" });
  assert.equal(TASKS_APP_SOURCE.split('"/api/v1/crawls"').length - 1, 1);
  assert.equal((TASKS_APP_SOURCE.match(/"\/api\/v1\//g) || []).length, 1);
  const combined = [TASKS_APP_SOURCE, TASKS_MODEL_SOURCE, TASKS_VIEW_SOURCE].join("\n");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /globalThis\.fetch/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /console\./,
    /innerHTML/,
    /tests\/fixtures|fixtures\/webui/,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.match(TASKS_APP_SOURCE, /requestGate/);
  assert.match(TASKS_APP_SOURCE, /advanceLifecycle/);
  assert.match(TASKS_APP_SOURCE, /\.abort\(\)/);
  assert.match(TASKS_APP_SOURCE, /Promise\.all\(/);
  assert.match(TASKS_APP_SOURCE, /Promise\.allSettled\(/);
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof tasksApplication[hook], "function");
  }
  assert.equal(typeof createTasksController, "function");
});
