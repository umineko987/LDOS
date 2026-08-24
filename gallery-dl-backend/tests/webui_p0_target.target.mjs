import assert from "node:assert/strict";
import test from "node:test";

import { readSourceText } from "./source-test-text.mjs";
import { sanitizeTaskPage, TASK_DISPLAY_LIMIT } from "../gdl_backend/webui/js/core/tasks-model.js";

// This suite is intentionally excluded from scripts/run-webui-coverage.py.
// It describes the Svelte/Tauri target, while its probes remain bound to the
// legacy implementation only to make today's gaps red and reproducible. P1-P4
// must move each probe to desktop/ as the corresponding implementation lands.
const WEBUI = new URL("../gdl_backend/webui/", import.meta.url);
const readWebui = (path) => readSourceText(new URL(path, WEBUI));
const budgets = JSON.parse(readSourceText(
  new URL("./fixtures/webui/p0-performance-budget.json", import.meta.url),
));

function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `missing section start: ${start}`);
  assert.notEqual(last, -1, `missing section end: ${end}`);
  return source.slice(first, last);
}

function assertNoViolations(label, violations) {
  assert.deepEqual(violations, [], `${label}:\n- ${violations.join("\n- ")}`);
}

test("[P0 target][red] Tasks keeps at most 100 records in the current page/DOM", () => {
  const target = budgets.budgets.tasks_active_page.rows_max;
  const tasks = sanitizeTaskPage({
    items: Array.from({ length: 1_001 }, (_, index) => ({ id: `task-${index}`, status: "running" })),
  }, "batch-p0-target").tasks;
  assert.equal(TASK_DISPLAY_LIMIT, target, "legacy implementation still exposes a 1000-row page");
  assert.equal(tasks.length, target);
});

test("[P0 target][red] one Tasks poll has one domain commit and no imperative second render", () => {
  const source = readWebui("js/apps/tasks.js");
  const readActive = section(source, "const readActive =", "const refreshAuthority =");
  const violations = [];
  const commits = readActive.split("batchSnapshotReceived(").length - 1;
  if (commits !== budgets.budgets.tasks_active_page.state_commits_per_poll_max) {
    violations.push(`domain commits per poll: expected 1, found ${commits}`);
  }
  if (readActive.includes("setWorkspacePhase(")) {
    violations.push("poll performs an imperative phase update after the Store commit");
  }
  const view = readWebui("js/components/tasks-view.js");
  if (/setWorkspacePhase\(phase, message = ""\)[\s\S]*render\(store\.getState\(\)\.batches\)/.test(view)) {
    violations.push("phase update performs a second full render");
  }
  assertNoViolations("Tasks one-poll/one-commit target is not implemented", violations);
});

test("[P0 target][characterization] Tasks lifecycle stops polling and aborts reads", () => {
  const source = readWebui("js/apps/tasks.js");
  const lifecycle = section(source, "deactivate() {", "destroy() {");
  for (const marker of [
    "polling.stop(BATCH_POLL_KEY)",
    "operationController?.abort()",
    "abortRead(activeRead)",
    "abortRead(recentRead)",
    'root.dataset.lifecycle = "inactive"',
  ]) assert.equal(lifecycle.includes(marker), true, marker);
});


test("[P0 target][red] Crawl selection/sort updates keyed items without rebuilding lists", () => {
  const source = readWebui("js/components/crawl-view.js");
  const navigation = section(source, "const renderSourceNavigation =", "const renderCurrentSource =");
  const currentSource = section(source, "const renderCurrentSource =", "const renderSummary =");
  const violations = [];
  if (navigation.includes("replaceChildren(")) violations.push("source navigation is rebuilt with replaceChildren");
  if (currentSource.includes("replaceChildren(")) violations.push("current candidate list is rebuilt with replaceChildren");
  if (!/sourceKey|candidateKey/.test(`${navigation}\n${currentSource}`)) violations.push("stable business keys are absent");
  assertNoViolations("Crawl keyed-update target is not implemented", violations);
});

test("[P0 target][characterization] Review releases listeners, observer, rAF and images", () => {
  const source = readWebui("js/components/review-view.js");
  for (const marker of [
    "cancelHide();",
    "cancelDraw();",
    "cancelLayout();",
    "resizeObserver?.disconnect();",
    'image.removeAttribute("src")',
    "canvas.width = 1",
    'root.removeEventListener("pointerover"',
    'root.removeEventListener("pointerout"',
    'root.removeEventListener("pointermove"',
    'root.removeEventListener("wheel"',
    "unsubscribeRecent();",
    "unsubscribeReview();",
  ]) assert.equal(source.includes(marker), true, marker);
  assert.match(source, /deactivate\(\)\s*\{[\s\S]*detachInteractions\(\);[\s\S]*releaseImages\(\);/);
  assert.match(source, /destroy\(\)\s*\{[\s\S]*detachInteractions\(\);[\s\S]*releaseImages\(\);/);
});
