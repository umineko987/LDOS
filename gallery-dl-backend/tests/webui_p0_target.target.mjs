import assert from "node:assert/strict";
import test from "node:test";

import { readSourceText } from "./source-test-text.mjs";

// This suite is intentionally excluded from scripts/run-webui-coverage.py.
// P3 Tasks and P4 Crawl targets now live under desktop/. This legacy source
// target retains only lifecycle characterizations that still protect the frozen WebUI.
const WEBUI = new URL("../gdl_backend/webui/", import.meta.url);
const readWebui = (path) => readSourceText(new URL(path, WEBUI));

function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `missing section start: ${start}`);
  assert.notEqual(last, -1, `missing section end: ${end}`);
  return source.slice(first, last);
}



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
