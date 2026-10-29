import { describe, expect, it, vi } from "vitest";

import { createEventBus } from "./bus.ts";

describe("createEventBus", () => {
  it("delivers each kind only to its subscribers", () => {
    const bus = createEventBus();
    const dataset = vi.fn();
    const atlas = vi.fn();
    bus.subscribe("dataset.updated", dataset);
    bus.subscribe("atlas.updated", atlas);

    bus.dispatch("dataset.updated", { dataset_id: "d1", reason: "roots" });

    expect(dataset).toHaveBeenCalledExactlyOnceWith({ dataset_id: "d1", reason: "roots" });
    expect(atlas).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe and counts duplicate subscriptions once", () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.subscribe("resync", handler);
    const unsubscribe = bus.subscribe("resync", handler);

    bus.dispatch("resync", { last_event_id: "1-1", reason: "gap" });
    unsubscribe();
    bus.dispatch("resync", { last_event_id: "1-2", reason: "gap" });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps notifying the rest when one subscriber throws", () => {
    const onError = vi.fn();
    const bus = createEventBus(onError);
    const failure = new Error("boom");
    const after = vi.fn();
    bus.subscribe("captions.updated", () => {
      throw failure;
    });
    bus.subscribe("captions.updated", after);

    bus.dispatch("captions.updated", { dataset_id: "d1", batch_id: "b1", changed: 3, reason: "ops" });

    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(after).toHaveBeenCalledOnce();
  });

  it("uses a snapshot of subscribers for each dispatch", () => {
    const bus = createEventBus();
    const late = vi.fn();
    bus.subscribe("dataset.updated", () => {
      bus.subscribe("dataset.updated", late);
    });

    bus.dispatch("dataset.updated", { dataset_id: "d1" });
    expect(late).not.toHaveBeenCalled();

    bus.dispatch("dataset.updated", { dataset_id: "d1" });
    expect(late).toHaveBeenCalledOnce();
  });
});
