import { describe, expect, it, vi } from "vitest";

import controllerSource from "../src/apps/review/controller.ts?raw";
import engineSource from "../src/apps/review/engine.ts?raw";
import modelSource from "../src/apps/review/model.ts?raw";
import reviewSource from "../src/apps/review/Review.svelte?raw";
import serviceSource from "../src/apps/review/service.ts?raw";
import stateSource from "../src/apps/review/state.ts?raw";
import { sanitizeReviewPage } from "../src/apps/review/model";
import { createReviewStore } from "../src/apps/review/state";

function snapshot() {
  return sanitizeReviewPage({
    batch_id: "batch-review-target",
    status: "ready",
    total_image_count: 3,
    total_group_count: 2,
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
    groups: {
      offset: 0,
      limit: 2,
      total: 2,
      items: [
        { id: "group-one", ordinal: 1, kind: "duplicate", decided: false, images: [
          { id: "image-one", ordinal: 1, readable: true, recommended: true, selected: true, metadata: { w: 1200, h: 800 }, url: "https://private.invalid/secret" },
          { id: "image-two", ordinal: 2, readable: true, recommended: false, selected: false, metadata: { w: 800, h: 1200 }, relative_path: "/private/secret.jpg" },
        ] },
        { id: "group-two", ordinal: 2, kind: "single", decided: false, images: [
          { id: "image-three", ordinal: 1, readable: true, recommended: true, selected: true, metadata: { w: 900, h: 900 } },
        ] },
      ],
    },
  }, { batchId: "batch-review-target", filter: "" });
}

describe("P4 Review target ownership", () => {
  it("updates only one keyed group and one sanitized snapshot notification", () => {
    const store = createReviewStore();
    const initial = snapshot();
    store.commitSnapshot(initial);
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    expect(store.toggleImage("group-one", "image-two")).toBe(true);
    const current = store.getState().snapshot!;
    expect(listener).toHaveBeenCalledOnce();
    expect(current.groups["group-one"]).not.toBe(initial.groups["group-one"]);
    expect(current.groups["group-two"]).toBe(initial.groups["group-two"]);
    expect(current.groupOrder).toBe(initial.groupOrder);
    expect(current.groups["group-one"].images["image-one"]).toBe(initial.groups["group-one"].images["image-one"]);
    expect(JSON.stringify(current)).not.toMatch(/private\.invalid|\/private\/|relative_path|"url"/);
  });

  it("pins the independent Canvas engine, bounded media window, and lifecycle release boundary", () => {
    expect(reviewSource).toContain("createReviewEngine({ host: engineHost");
    expect(reviewSource).toContain("engine?.destroy()");
    expect(engineSource).toContain("reviewImageWindow(");
    expect(engineSource).toContain('element.crossOrigin = "anonymous"');
    expect(engineSource).toContain("element.decoding = \"async\"");
    expect(engineSource).toContain("observer?.disconnect()");
    expect(engineSource).toContain("cancelFrame(frameHandle)");
    expect(engineSource).toContain('image.removeAttribute("src")');
    expect(engineSource).toContain("canvas.width = 1");
    expect(stateSource).not.toMatch(/canvas|pixel|magnification|objectUrl|mediaUrl|imageUrl/i);
  });

  it("keeps release orchestration and the one shared API/polling path", () => {
    expect(controllerSource).toContain('REVIEW_POLL_KEY = "review.active"');
    expect(controllerSource).toContain("splitReviewDecisionPayload(buildReviewDecisionPayload(snapshot))");
    expect(controllerSource).toContain("queueMicrotask(() =>");
    expect(controllerSource).toContain("beforeLeave: save");
    expect(serviceSource.match(/"\/api\/v1\//g)).toHaveLength(1);
    expect(serviceSource.match(/view=desktop/g)).toHaveLength(4);
    expect(serviceSource).toContain("REVIEW_PAGE_LIMIT = 50");
    expect(serviceSource).not.toContain("all=true");
    const combined = [reviewSource, controllerSource, modelSource, serviceSource, stateSource].join("\n");
    expect(combined).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\bsetInterval\s*\(|innerHTML|console\.|URL\.createObjectURL|new Blob/);
  });
});
