import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import reviewApplication, {
  createReviewController,
  REVIEW_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/review.js";
import {
  buildReviewDecisionPayload,
  createReviewRequestGate,
  REVIEW_DECISION_BATCH_LIMIT,
  REVIEW_GROUP_LIMIT,
  REVIEW_POLL_INTERVAL_MS,
  reviewErrorGuidance,
  reviewImageUrl,
  sanitizeReviewPage,
  sanitizeReviewSummary,
  splitReviewDecisionPayload,
  updateReviewImageSelection,
} from "../gdl_backend/webui/js/core/review-model.js";
import { actionCreators, createStore } from "../gdl_backend/webui/js/core/store.js";

const SECRET = "stage4-review-cookie-token-path-secret-173205";
const APP_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/apps/review.js", import.meta.url),
  "utf8",
);
const MODEL_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/review-model.js", import.meta.url),
  "utf8",
);
const VIEW_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/components/review-view.js", import.meta.url),
  "utf8",
);
const LOUPE_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/js/core/review-loupe.js", import.meta.url),
  "utf8",
);
const CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/apps/review.css", import.meta.url),
  "utf8",
);
const CONTROLS_CSS_SOURCE = readFileSync(
  new URL("../gdl_backend/webui/styles/controls.css", import.meta.url),
  "utf8",
);

function cssBlock(selector) {
  const marker = `${selector} {`;
  const start = CSS_SOURCE.indexOf(marker);
  assert.notEqual(start, -1, selector);
  const opening = CSS_SOURCE.indexOf("{", start);
  const closing = CSS_SOURCE.indexOf("}", opening);
  assert.notEqual(closing, -1, selector);
  return CSS_SOURCE.slice(opening + 1, closing);
}

function rawSummary(overrides = {}) {
  return {
    batch_id: "batch-review-stage4",
    status: "ready",
    total_image_count: 2,
    total_group_count: 1,
    duplicate_group_count: 1,
    unreadable_image_count: 0,
    automatic_group_count: 0,
    automatic_rejected_image_count: 0,
    selected_image_count: 2,
    decided_group_count: 0,
    kept_image_count: 0,
    rejected_image_count: 0,
    failed_image_count: 0,
    error: "",
    ...overrides,
  };
}

function rawImage(index = 1, overrides = {}) {
  return {
    id: `image-${index}`,
    ordinal: index,
    readable: true,
    recommended: index === 1,
    selected: true,
    relative_path: `/private/${SECRET}/image-${index}.jpg`,
    url: `https://private.invalid/${SECRET}/${index}`,
    metadata: {
      w: 1200,
      h: 1800,
      path: `/private/${SECRET}`,
      token: SECRET,
    },
    ...overrides,
  };
}

function rawGroup(index = 1, overrides = {}) {
  return {
    id: `group-${index}`,
    ordinal: index,
    kind: "duplicate",
    decided: false,
    images: [rawImage(index * 2 - 1), rawImage(index * 2)],
    match_levels: ["L2"],
    raw: SECRET,
    ...overrides,
  };
}

function rawPage({ groups = [rawGroup()], summary = {}, filter = "" } = {}) {
  return {
    ...rawSummary({
      total_image_count: groups.reduce((count, group) => count + group.images.length, 0),
      total_group_count: groups.length,
      duplicate_group_count: filter && filter !== "duplicate" ? 0 : groups.length,
      ...summary,
    }),
    groups: {
      items: groups,
      offset: 0,
      limit: groups.length,
      total: groups.length,
      secret: SECRET,
    },
    details: { token: SECRET },
  };
}

function cloneRaw(value) {
  return structuredClone(value);
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

async function flush(turns = 12) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

class ReviewTestElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.hidden = false;
    this.inert = false;
    this.disabled = false;
    this.listeners = new Map();
    this.attributes = new Map();
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "hidden") this.hidden = true;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
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

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  closest() {
    return null;
  }
}

class ReviewTestButton extends ReviewTestElement {
  constructor() {
    super("button");
  }
}

class ReviewTestSelect extends ReviewTestElement {
  constructor() {
    super("select");
    this.value = "";
  }

  matches(selector) {
    return selector === "[data-review-group-select]" &&
      Object.prototype.hasOwnProperty.call(this.dataset, "reviewGroupSelect");
  }
}

function installReviewDom() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("Element", ReviewTestElement);
  install("HTMLElement", ReviewTestElement);
  install("HTMLButtonElement", ReviewTestButton);
  install("HTMLSelectElement", ReviewTestSelect);
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

function reviewControllerHarness({
  initialPage = null,
  activeBatchId = "",
  apiGet,
  apiPut,
  apiPost,
} = {}) {
  const root = new ReviewTestElement("main");
  const store = createStore({ reportError: () => {} });
  if (activeBatchId) store.dispatch(actionCreators.activeBatchIdChanged(activeBatchId));
  if (initialPage) {
    store.dispatch(actionCreators.reviewWorkspaceReceived(
      sanitizeReviewPage(initialPage, {
        batchId: initialPage.batch_id,
        filter: "",
        requestedOffset: 0,
      }),
    ));
  }
  const calls = [];
  const api = {
    get(url, options) {
      calls.push(["get", url, options]);
      if (apiGet) return apiGet(url, options);
      if (url === `${REVIEW_ENDPOINTS.crawls}?limit=30`) return Promise.resolve({ items: [] });
      if (url.includes("/review?all=true")) return Promise.resolve(cloneRaw(initialPage || rawPage()));
      throw new Error(`unexpected GET ${url}`);
    },
    put(url, payload, options) {
      calls.push(["put", url, payload, options]);
      return apiPut ? apiPut(url, payload, options) : Promise.resolve(rawSummary());
    },
    post(url, payload, options) {
      calls.push(["post", url, payload, options]);
      return apiPost ? apiPost(url, payload, options) : Promise.resolve(rawSummary());
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
  const dialogLog = [];
  const dialogs = {
    async open(options) {
      dialogLog.push(options);
      return "confirm";
    },
    destroy() {},
  };
  const viewLog = [];
  const view = {
    selectedBatchId: () => "",
    clearError: () => viewLog.push(["clear-error"]),
    showError: (guidance) => viewLog.push(["error", guidance]),
    setOperationMessage: (message) => viewLog.push(["message", message]),
    setBusy: (kind) => viewLog.push(["busy", kind]),
    releaseImages: () => viewLog.push(["release"]),
    getFocusedIndex: () => 0,
    getActiveImageId: () => store.getState().review.groups[0]?.images[0]?.id || "",
    setFocusedIndex: () => true,
    setActiveImage: () => true,
    isLoupeAvailable: () => false,
    toggleLoupe: () => null,
    toggleLoupePin: () => "",
    hideCompletion: () => false,
    showCompletion: () => true,
    markConfirmed: () => true,
    resetWorkspaceState: () => viewLog.push(["reset"]),
    applyConfirmationText: () => "安全确认文本",
    activate: () => viewLog.push(["activate"]),
    deactivate: () => viewLog.push(["deactivate"]),
    destroy: () => viewLog.push(["destroy"]),
  };
  const controller = createReviewController({
    root,
    api,
    store,
    polling,
    actions,
    dialogs,
    pollingScope: "app:review",
    app: { id: "review", label: "去重审核", windowTitle: "去重审核" },
  }, { createView: () => view });
  return {
    root,
    store,
    calls,
    polling,
    actionLog,
    dialogLog,
    viewLog,
    controller,
  };
}

function dirtyPage(groupCount = 1) {
  const groups = Array.from({ length: groupCount }, (_, index) => rawGroup(index + 1, {
    images: [rawImage(index + 1, { id: `image-${index + 1}` })],
  }));
  const page = sanitizeReviewPage(rawPage({ groups }), {
    batchId: "batch-review-stage4",
    filter: "",
    requestedOffset: 0,
  });
  return groups.reduce(
    (state, group) => updateReviewImageSelection(state, group.id, group.images[0].id, false),
    page,
  );
}

function dispatchDirty(store, groupCount = 1) {
  store.dispatch(actionCreators.reviewWorkspaceReceived(dirtyPage(groupCount)));
}

test("4D model：严格投影仅接受 exact boolean/count，且 raw secret/path/URL 不进入状态", () => {
  const projected = sanitizeReviewPage(rawPage(), {
    batchId: "batch-review-stage4",
    filter: "",
    requestedOffset: 0,
  });
  const serialized = JSON.stringify(projected);
  for (const forbidden of [SECRET, "private.invalid", "/private/", "relative_path", '"url"']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(projected.groups[0].images[0].readable, true);
  assert.equal(projected.groups[0].images[0].recommended, true);
  assert.equal(projected.groups[0].images[0].selected, true);

  for (const [field, value] of [
    ["readable", "false"],
    ["recommended", 1],
    ["selected", "true"],
  ]) {
    const raw = rawPage();
    raw.groups.items[0].images[0][field] = value;
    assert.throws(() => sanitizeReviewPage(raw, { batchId: "batch-review-stage4" }), TypeError);
  }
  const badGroup = rawPage();
  badGroup.groups.items[0].decided = "false";
  assert.throws(() => sanitizeReviewPage(badGroup, { batchId: "batch-review-stage4" }), TypeError);

  for (const value of ["2", 2.5, Number.NaN, -1]) {
    const raw = rawPage();
    raw.total_image_count = value;
    assert.throws(() => sanitizeReviewPage(raw, { batchId: "batch-review-stage4" }), TypeError);
  }
  for (const field of ["offset", "limit", "total"]) {
    const raw = rawPage();
    raw.groups[field] = String(raw.groups[field]);
    assert.throws(() => sanitizeReviewPage(raw, { batchId: "batch-review-stage4" }), TypeError);
  }
  const projectedSummary = sanitizeReviewSummary({
    ...sanitizeReviewSummary(rawSummary(), "batch-review-stage4"),
    hasError: false,
  }, "batch-review-stage4");
  assert.equal(projectedSummary.hasError, false);
  assert.throws(() => sanitizeReviewSummary({
    ...projectedSummary,
    hasError: "false",
  }, "batch-review-stage4"), TypeError);
});

test("4D model：危险原型/accessor 与错误 getter 被拒绝且不泄漏", () => {
  const dangerous = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => sanitizeReviewPage({
    ...rawPage(),
    ...dangerous,
  }, { batchId: "batch-review-stage4" }), TypeError);
  assert.equal({}.polluted, undefined);

  const accessor = rawPage();
  Object.defineProperty(accessor.groups.items[0].images[0], "selected", {
    enumerable: true,
    get() {
      throw new Error(SECRET);
    },
  });
  assert.throws(() => sanitizeReviewPage(accessor, { batchId: "batch-review-stage4" }), TypeError);

  const error = {};
  Object.defineProperty(error, "code", {
    enumerable: true,
    get() {
      throw new Error(SECRET);
    },
  });
  const guidance = reviewErrorGuidance(error);
  assert.equal(guidance.code, "request_failed");
  assert.equal(JSON.stringify(guidance).includes(SECRET), false);
  const withRaw = reviewErrorGuidance({
    code: `invalid_${SECRET}`,
    status: 409,
    requestId: "request-review-1",
    message: SECRET,
    details: { path: `/private/${SECRET}`, token: SECRET },
  });
  assert.equal(JSON.stringify(withRaw).includes(SECRET), false);
  assert.equal(withRaw.requestId, "request-review-1");
});

test("4D model：全量上限、图片 URL 和串行 50 组 payload 保持闭环", () => {
  const dirty = dirtyPage(REVIEW_DECISION_BATCH_LIMIT * 2 + 1);
  const payload = buildReviewDecisionPayload(dirty);
  assert.deepEqual(
    splitReviewDecisionPayload(payload).map((chunk) => chunk.groups.length),
    [50, 50, 1],
  );
  assert.equal(REVIEW_GROUP_LIMIT, 10_000);
  assert.equal(REVIEW_DECISION_BATCH_LIMIT, 50);
  assert.equal(REVIEW_POLL_INTERVAL_MS, 1_500);
  assert.equal(
    reviewImageUrl("batch-review-stage4", "image-1"),
    "/api/v1/crawls/batch-review-stage4/review/images/image-1",
  );
  for (const bad of ["", "../batch", "batch/child", `batch-${SECRET}/child`]) {
    assert.throws(() => reviewImageUrl(bad, "image-1"), TypeError);
    assert.throws(() => reviewImageUrl("batch-review-stage4", bad), TypeError);
  }
});

test("4D request gate：page/recent/summary/write 通道隔离写前、过期及生命周期结果", () => {
  const gate = createReviewRequestGate();
  const page = gate.beginRead("page", "batch-review-stage4", "", 0);
  const recent = gate.beginRead("recent", "", "", 0);
  const summary = gate.beginRead("summary", "batch-review-stage4", "duplicate", 0);
  assert.equal(gate.isReadCurrent(recent, { channel: "recent", batchId: "", filter: "", offset: 0 }), true);
  assert.equal(gate.isReadCurrent(summary, {
    channel: "summary", batchId: "batch-review-stage4", filter: "duplicate", offset: 0,
  }), true);
  const newerPage = gate.beginRead("page", "batch-review-stage4", "", 0);
  assert.equal(gate.isReadCurrent(newerPage, {
    channel: "page", batchId: "batch-review-stage4", filter: "", offset: 0,
  }), true);
  assert.equal(gate.isReadCurrent(page, {
    channel: "page", batchId: "batch-review-stage4", filter: "", offset: 0,
  }), false);
  const write = gate.beginWrite();
  assert.equal(gate.isWriteCurrent(write), true);
  assert.equal(gate.isReadCurrent(summary, {
    channel: "summary", batchId: "batch-review-stage4", filter: "duplicate", offset: 0,
  }), false);
  gate.advanceLifecycle();
  assert.equal(gate.isWriteCurrent(write), false);
  assert.equal(gate.isReadCurrent(recent, { channel: "recent", batchId: "", filter: "", offset: 0 }), false);
  assert.throws(() => gate.beginRead("unsafe", "batch", "", 0), TypeError);
});

test("4D controller：activate 读取 recent/page，活动态 1.5s poll；dirty 立即停止", async () => {
  const restore = installReviewDom();
  try {
    const page = rawPage({ summary: { status: "analyzing" } });
    const harness = reviewControllerHarness({ initialPage: page });
    harness.controller.activate();
    await flush();
    assert.equal(harness.calls.some((call) => call[1] === `${REVIEW_ENDPOINTS.crawls}?limit=30`), true);
    assert.equal(harness.calls.some((call) => call[1].includes("?all=true")), true);
    assert.equal(harness.polling.starts.at(-1).intervalMs, REVIEW_POLL_INTERVAL_MS);
    assert.equal(harness.polling.entries.has("review.active"), true);

    const ready = rawPage();
    harness.store.dispatch(actionCreators.reviewWorkspaceReceived(sanitizeReviewPage(ready, {
      batchId: ready.batch_id,
      filter: "",
      requestedOffset: 0,
    })));
    harness.store.dispatch(actionCreators.reviewGroupConfirmed("group-1"));
    assert.equal(harness.store.getState().review.dirty, true);
    assert.equal(harness.polling.entries.has("review.active"), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4D controller：旧生命周期 recent/page 即使 adapter 忽略 Abort 也不能提交", async () => {
  const restore = installReviewDom();
  try {
    const oldRecent = deferred();
    const oldPage = deferred();
    let recentCount = 0;
    let pageCount = 0;
    const harness = reviewControllerHarness({
      initialPage: rawPage(),
      apiGet(url) {
        if (url === `${REVIEW_ENDPOINTS.crawls}?limit=30`) {
          recentCount += 1;
          return recentCount === 1 ? oldRecent.promise : Promise.resolve({ items: [] });
        }
        if (url.includes("/review?all=true")) {
          pageCount += 1;
          return pageCount === 1 ? oldPage.promise : Promise.resolve(cloneRaw(rawPage()));
        }
        throw new Error(`unexpected GET ${url}`);
      },
    });
    harness.controller.activate();
    await flush(2);
    harness.controller.deactivate();
    harness.controller.activate();
    await flush(2);
    oldRecent.resolve({ items: [{
      id: "batch-stale-review",
      status: "succeeded",
      created_at: 1,
      output_dir: `/private/${SECRET}`,
    }] });
    oldPage.resolve(cloneRaw(rawPage({ summary: { decided_group_count: 99 } })));
    await flush();
    assert.equal(harness.store.getState().batches.recent.some((item) => item.id === "batch-stale-review"), false);
    assert.notEqual(harness.store.getState().review.summary.decidedGroupCount, 99);
    assert.equal(JSON.stringify(harness.store.getState()).includes(SECRET), false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4D controller：leave/minimize/close 共享一次串行保存和权威重读", async () => {
  const restore = installReviewDom();
  try {
    const firstPut = deferred();
    const putPayloads = [];
    const harness = reviewControllerHarness({
      initialPage: rawPage(),
      apiPut(_url, payload) {
        putPayloads.push(structuredClone(payload));
        return putPayloads.length === 1 ? firstPut.promise : Promise.resolve(rawSummary());
      },
    });
    dispatchDirty(harness.store, REVIEW_DECISION_BATCH_LIMIT + 1);
    harness.controller.activate();
    await flush();
    const baselineGets = harness.calls.filter((call) => call[0] === "get" && call[1].includes("?all=true")).length;
    const leave = harness.controller.beforeLeave();
    const minimize = harness.controller.beforeWindowHide("minimized");
    const close = harness.controller.beforeWindowHide("closed");
    await flush(2);
    assert.deepEqual(putPayloads.map((payload) => payload.groups.length), [50]);
    firstPut.resolve(rawSummary());
    assert.deepEqual(await Promise.all([leave, minimize, close]), [true, true, true]);
    assert.deepEqual(putPayloads.map((payload) => payload.groups.length), [50, 1]);
    assert.deepEqual(
      putPayloads.flatMap((payload) => payload.groups.map((group) => group.group_id)),
      Array.from({ length: REVIEW_DECISION_BATCH_LIMIT + 1 }, (_, index) => `group-${index + 1}`),
    );
    assert.equal(putPayloads.every((payload) => Object.keys(payload).join() === "groups"), true);
    const pageGets = harness.calls.filter((call) => call[0] === "get" && call[1].includes("?all=true")).length;
    assert.equal(pageGets, baselineGets + 1);
    assert.equal(harness.store.getState().review.dirty, false);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4D controller：保存失败拒绝 leave/hide、保留完整草稿并可按原 payload 重试", async () => {
  const restore = installReviewDom();
  try {
    const putPayloads = [];
    const harness = reviewControllerHarness({
      initialPage: rawPage(),
      apiPut(_url, payload) {
        putPayloads.push(structuredClone(payload));
        if (putPayloads.length === 1) {
          return Promise.reject(Object.assign(new Error(SECRET), {
            status: 409,
            code: "review_state_conflict",
            requestId: "review-request-safe",
            details: { token: SECRET },
          }));
        }
        return Promise.resolve(rawSummary({ decided_group_count: 1 }));
      },
    });
    dispatchDirty(harness.store, 1);
    harness.controller.activate();
    await flush();
    const leave = harness.controller.beforeLeave();
    const hide = harness.controller.beforeWindowHide("closed");
    assert.deepEqual(await Promise.all([leave, hide]), [false, false]);
    assert.equal(harness.store.getState().review.dirty, true);
    assert.deepEqual(harness.store.getState().review.dirtyGroupIds, ["group-1"]);
    assert.deepEqual(putPayloads, [{ groups: [{ group_id: "group-1", selected_image_ids: [] }] }]);
    assert.equal(JSON.stringify(harness.viewLog).includes(SECRET), false);

    assert.equal(await harness.controller.beforeLeave(), true);
    assert.deepEqual(putPayloads[1], putPayloads[0]);
    assert.equal(harness.store.getState().review.dirty, false);
    assert.deepEqual(harness.store.getState().review.dirtyGroupIds, []);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4D controller：deactivate/destroy 后旧 write 不清 dirty、不重读、不污染 Store", async () => {
  const restore = installReviewDom();
  try {
    const pending = deferred();
    const harness = reviewControllerHarness({
      initialPage: rawPage(),
      apiPut: () => pending.promise,
    });
    dispatchDirty(harness.store, 1);
    harness.controller.activate();
    await flush();
    const save = harness.controller.beforeWindowHide("minimized");
    await flush(2);
    const readsBeforeDeactivate = harness.calls.filter((call) => call[0] === "get").length;
    harness.controller.deactivate();
    pending.resolve(rawSummary({ decided_group_count: 1 }));
    assert.equal(await save, false);
    await flush();
    assert.equal(harness.store.getState().review.dirty, true);
    assert.equal(harness.calls.filter((call) => call[0] === "get").length, readsBeforeDeactivate);
    harness.controller.destroy();
  } finally {
    restore();
  }
});

test("4D DOM/CSS T7.6：全高 deck、低透明舞台、真实图片与 canonical a11y", () => {
  for (const fingerprint of [
    'className: "review-deck-header"',
    'className: "review-deck-stage"',
    'className: "review-deck-statusbar"',
    'className: "review-deck-command-list"',
    'className: "review-shortcut-hints"',
    'dataset: { reviewGroupSelect: "" }',
    'button("prev-group"',
    'button("next-group"',
    "当前筛选全量组选择器",
    "读取受限",
  ]) assert.match(VIEW_SOURCE, new RegExp(fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(CSS_SOURCE, /\.window-body:has\(> \.review-app\)/);
  assert.match(CSS_SOURCE, /\.review-app\s*\{[^}]*height:\s*100%[^}]*background:\s*transparent/s);
  assert.match(CSS_SOURCE, /\.review-app\[data-mode="panel"\][^\{]*\{[^}]*overflow-y:\s*auto/s);
  assert.match(CSS_SOURCE, /\.review-deck-stage\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(CSS_SOURCE, /\.review-deck-cards\s*\{[^}]*overflow:\s*auto/s);

  const panel = cssBlock(".review-panel");
  for (const expected of [
    "border: var(--imageweave-border-width) solid var(--imageweave-border-default)",
    "border-radius: var(--imageweave-radius-card)",
    "background: var(--imageweave-glass-surface-input)",
    "inset 0 1px 0",
    "inset 0 -1px 0",
  ]) assert.match(panel, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(panel, /backdrop-filter|var\(--imageweave-shadow-/);

  for (const [selector, surface] of [
    [".review-deck-header", "secondary"],
    [".review-deck-stage", "input"],
    [".review-deck-statusbar", "secondary"],
  ]) {
    const block = cssBlock(selector);
    assert.match(block, /border:\s*var\(--imageweave-border-width\) solid var\(--imageweave-border-default\)/);
    assert.match(block, /border-radius:\s*var\(--imageweave-radius-card\)/);
    assert.match(block, new RegExp(`background:\\s*var\\(--imageweave-glass-surface-${surface}\\)`));
    assert.match(block, /inset 0 1px 0/);
    assert.match(block, /inset 0 -1px 0/);
    assert.doesNotMatch(block, /backdrop-filter|var\(--imageweave-shadow-/);
    if (selector === ".review-deck-header") assert.match(block, /max-height:\s*230px/);
  }

  const errorOverlay = cssBlock('.review-app[data-mode="deck"] > .review-error-host:not(:empty)');
  assert.match(errorOverlay, /inset:\s*16px/);
  assert.match(errorOverlay, /display:\s*grid/);
  assert.match(errorOverlay, /place-items:\s*center/);
  assert.match(errorOverlay, /border:[^;]*--imageweave-border-default/);
  assert.match(errorOverlay, /background:\s*rgb\(6 10 19 \/ 0\.68\)/);
  assert.match(errorOverlay, /box-shadow:\s*none/);
  assert.doesNotMatch(errorOverlay, /backdrop-filter|var\(--imageweave-shadow-/);

  const operation = cssBlock(".review-operation-live");
  assert.match(operation, /border:[^;]*--imageweave-border-weak/);
  assert.match(operation, /border-radius:\s*var\(--imageweave-radius-control\)/);
  assert.match(operation, /background:\s*var\(--imageweave-glass-surface-weak\)/);
  assert.match(operation, /color:\s*var\(--imageweave-text-secondary\)/);
  assert.match(CSS_SOURCE, /\.review-operation-live\[data-review-dirty="true"\][\s\S]*?border:\s*var\(--imageweave-border-strong-width\) solid var\(--imageweave-state-warning\)/);
  assert.match(CSS_SOURCE, /content:\s*"△ 未保存 · "/);
  assert.match(CSS_SOURCE, /\.review-tab--active::before\s*\{[^}]*content:\s*"◆ "/s);

  const imageCard = cssBlock(".review-image-card");
  assert.match(imageCard, /border:[^;]*--imageweave-border-default/);
  assert.match(imageCard, /border-radius:\s*var\(--imageweave-radius-control\)/);
  assert.match(imageCard, /background:\s*var\(--imageweave-glass-surface-secondary\)/);
  assert.match(imageCard, /box-shadow:\s*none/);
  assert.match(imageCard, /transform:\s*none/);
  const cardHover = cssBlock('.review-image-card[aria-disabled="false"]:hover');
  assert.match(cardHover, /transform:\s*none/);
  assert.match(cardHover, /box-shadow:\s*none/);
  assert.match(cssBlock('.review-image-card[data-selected="false"]'), /opacity:\s*1/);
  assert.match(CSS_SOURCE, /\.review-image-card\[data-selected="true"\][\s\S]*?border-color:\s*var\(--imageweave-border-focus\)/);
  assert.match(CSS_SOURCE, /\.review-image-card\[data-active="true"\][\s\S]*?border-color:\s*var\(--imageweave-accent\)[\s\S]*?outline:[^;]*--imageweave-focus-ring/);
  assert.match(CSS_SOURCE, /\.review-image-card\[data-active="true"\] \.review-image-active-marker\s*\{\s*display:\s*block/);
  assert.match(CSS_SOURCE, /\.review-image-stamp\[data-state="keep"\][\s\S]*?background:\s*var\(--imageweave-glass-surface-input\)/);

  const image = cssBlock(".review-image-media > img");
  for (const expected of [
    /min-width:\s*0/,
    /min-height:\s*0/,
    /object-fit:\s*contain/,
    /background:\s*transparent/,
    /opacity:\s*1/,
    /filter:\s*none/,
    /mix-blend-mode:\s*normal/,
    /transition:\s*none/,
  ]) assert.match(image, expected);
  const lens = cssBlock(".review-loupe-lens");
  assert.match(lens, /border:[^;]*--imageweave-border-default/);
  assert.match(lens, /border-radius:\s*var\(--imageweave-radius-control\)/);
  assert.match(lens, /background:\s*var\(--imageweave-glass-surface-secondary\)/);
  assert.match(lens, /image-rendering:\s*pixelated/);
  assert.match(lens, /filter:\s*none/);
  assert.match(lens, /mix-blend-mode:\s*normal/);
  assert.match(lens, /transition:\s*none/);
  assert.match(lens, /animation:\s*none/);

  assert.deepEqual(
    CSS_SOURCE.match(/--imageweave-[\w-]*-solid/g) || [],
    ["--imageweave-fallback-elevated-solid"],
  );
  assert.doesNotMatch(CSS_SOURCE, /--imageweave-state-[\w-]*-surface|\b(?:100|120|140|150|160|180)ms\b/);
  for (const match of CSS_SOURCE.matchAll(/(?:^|\n)\s*(?:-webkit-)?backdrop-filter\s*:\s*([^;\n]+)/g)) {
    assert.equal(match[1].trim(), "none");
  }
  assert.doesNotMatch(CSS_SOURCE, /border-style:\s*(?:double|dashed|dotted)|outline:\s*6px\s+double/);
  assert.match(CSS_SOURCE, /@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/);
  assert.match(CSS_SOURCE, /@media \(prefers-contrast: more\)/);
  assert.match(CSS_SOURCE, /@media \(forced-colors: active\)/);
  assert.match(CSS_SOURCE, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(CSS_SOURCE, /data-motion="off"/);
  assert.match(CSS_SOURCE, /CanvasText/);
  assert.match(CSS_SOURCE, /ButtonFace/);
  assert.match(CSS_SOURCE, /Highlight/);
  assert.match(
    CONTROLS_CSS_SOURCE,
    /\.review-button\.review-button--primary[\s\S]*?border-color:\s*var\(--imageweave-accent\)[\s\S]*?background:\s*var\(--imageweave-glass-surface-button\)/,
  );
  assert.doesNotMatch(`${VIEW_SOURCE}\n${CSS_SOURCE}`, /review-deck-inspector|review-metrics|pseudo-terminal|raw logs/i);
});

test("4D focus/loupe：重绘保留稳定 token，当前项与保留项状态独立且媒体释放完整", () => {
  for (const fingerprint of [
    "reviewFocusToken",
    "captureReviewFocus",
    "restoreReviewFocus",
    'card.dataset.active = String(active)',
    'card.dataset.selected = String(image.selected)',
    'className: "review-image-active-marker"',
    "const neighborIndex =",
    "adjacentPreviews.push(preview)",
    'image.removeAttribute("src")',
    "canvas.width = 1",
    "new globalThis.ResizeObserver",
    "MAX_CANVAS_DPR = 2",
    "context2d.imageSmoothingEnabled = false",
  ]) assert.equal(VIEW_SOURCE.includes(fingerprint), true, fingerprint);
  assert.doesNotMatch(`${APP_SOURCE}\n${VIEW_SOURCE}\n${MODEL_SOURCE}\n${LOUPE_SOURCE}`, /URL\.createObjectURL|new Blob|globalThis\.document\.(?:querySelector|getElementById)/);
});

test("4D static boundary：唯一 crawls endpoint、全生命周期及无旁路 I/O/storage/fixture", () => {
  assert.deepEqual(REVIEW_ENDPOINTS, { crawls: "/api/v1/crawls" });
  assert.equal((APP_SOURCE.match(/"\/api\/v1\//g) || []).length, 1);
  assert.equal((APP_SOURCE.match(/\?all=true/g) || []).length, 1);
  for (const hook of [
    "mount", "activate", "beforeLeave", "beforeWindowHide", "deactivate", "unmount",
  ]) assert.equal(typeof reviewApplication[hook], "function", hook);
  assert.equal(typeof createReviewController, "function");
  const combined = [APP_SOURCE, MODEL_SOURCE, VIEW_SOURCE, LOUPE_SOURCE].join("\n");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /globalThis\.fetch/,
    /XMLHttpRequest/,
    /localStorage|sessionStorage|indexedDB/,
    /console\./,
    /innerHTML/,
    /tests\/fixtures|fixtures\/webui/,
    /data:image/,
  ]) assert.doesNotMatch(combined, forbidden);
  assert.match(APP_SOURCE, /createReviewRequestGate/);
  assert.match(APP_SOURCE, /AbortController/);
  assert.match(APP_SOURCE, /beforeWindowHide/);
});
