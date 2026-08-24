import { describe, expect, it, vi } from "vitest";

import type { ApplicationId, WindowRect } from "../applications/definitions";
import {
  createWindowInteractionEngine,
  type AnimationFramePort,
  type WindowInteractionMode,
} from "./interaction";

class TrackingTarget extends EventTarget {
  readonly counts = new Map<string, number>();

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    super.addEventListener(type, callback, options);
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, callback, options);
    this.counts.set(type, Math.max(0, (this.counts.get(type) ?? 0) - 1));
  }
}

class FakeElement extends TrackingTarget {
  readonly attributes = new Map<string, string>();
  readonly captures = new Set<number>();
  readonly style = { transform: "", width: "800px", height: "560px" };

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setPointerCapture(pointerId: number): void {
    this.captures.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.captures.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.captures.delete(pointerId);
  }
}

class TestFrames implements AnimationFramePort {
  private nextId = 1;
  readonly callbacks = new Map<number, FrameRequestCallback>();
  readonly request = vi.fn((callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  });
  readonly cancel = vi.fn((frameId: number): void => {
    this.callbacks.delete(frameId);
  });

  flush(): void {
    const pending = [...this.callbacks.entries()];
    this.callbacks.clear();
    for (const [, callback] of pending) callback(0);
  }
}

function pointerEvent(
  type: string,
  { pointerId = 7, clientX = 100, clientY = 80, button = 0, isPrimary = true } = {},
): PointerEvent {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
    button: { value: button },
    isPrimary: { value: isPrimary },
  });
  return event as PointerEvent;
}

function keyEvent(key: string): KeyboardEvent {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  return event as KeyboardEvent;
}

const rect: WindowRect = Object.freeze({ x: 100, y: 80, w: 800, h: 560 });
const viewport = Object.freeze({ width: 1200, height: 800 });

function fixture() {
  const events = new TrackingTarget();
  const frames = new TestFrames();
  const commits: Array<{ appId: ApplicationId; rect: WindowRect }> = [];
  const engine = createWindowInteractionEngine({
    events,
    frames,
    commit: (appId, committedRect) => commits.push({ appId, rect: committedRect }),
  });
  const element = new FakeElement();
  const handle = new FakeElement();
  const begin = (mode: WindowInteractionMode, event = pointerEvent("pointerdown")) => engine.begin({
    appId: "crawl",
    mode,
    rect,
    viewport,
    element: element as unknown as HTMLElement,
    handle: handle as unknown as HTMLElement,
    event,
  });
  return { events, frames, commits, engine, element, handle, begin };
}

describe("single window interaction engine", () => {
  it("coalesces pointer moves to one rAF projection and commits drag once with translate3d", () => {
    const { events, frames, commits, engine, element, handle, begin } = fixture();
    const down = pointerEvent("pointerdown");
    expect(begin("move", down)).toBe(true);
    expect(down.defaultPrevented).toBe(true);
    expect(engine.isActive()).toBe(true);
    expect(element.attributes.get("data-window-interacting")).toBe("move");
    expect(handle.captures.has(7)).toBe(true);
    expect(begin("move")).toBe(false);

    events.dispatchEvent(pointerEvent("pointermove", { pointerId: 8, clientX: 999 }));
    events.dispatchEvent(pointerEvent("pointermove", { clientX: 110, clientY: 90 }));
    events.dispatchEvent(pointerEvent("pointermove", { clientX: 120, clientY: 95 }));
    const latest = pointerEvent("pointermove", { clientX: 130, clientY: 100 });
    events.dispatchEvent(latest);
    expect(latest.defaultPrevented).toBe(true);
    expect(frames.request).toHaveBeenCalledOnce();
    expect(element.style.transform).toBe("");
    expect(commits).toEqual([]);

    frames.flush();
    expect(element.style.transform).toBe("translate3d(30px, 20px, 0)");
    events.dispatchEvent(pointerEvent("pointermove", { clientX: 140, clientY: 110 }));
    events.dispatchEvent(pointerEvent("pointerup", { pointerId: 8, clientX: 999 }));
    events.dispatchEvent(pointerEvent("pointerup", { clientX: 150, clientY: 115 }));

    expect(frames.cancel).toHaveBeenCalledOnce();
    expect(commits).toEqual([{ appId: "crawl", rect: { x: 150, y: 115, w: 800, h: 560 } }]);
    expect(Object.isFrozen(commits[0].rect)).toBe(true);
    expect(element.style).toEqual({ transform: "", width: "800px", height: "560px" });
    expect(element.attributes.has("data-window-interacting")).toBe(false);
    expect(engine.isActive()).toBe(false);
    expect(handle.captures.size).toBe(0);
    expect([...events.counts.values()]).toEqual([0, 0, 0, 0, 0]);
    expect(handle.counts.get("lostpointercapture")).toBe(0);
    expect(engine.cancel()).toBe(false);
  });

  it.each([
    ["right", "830px", "560px", { x: 100, y: 80, w: 830, h: 560 }],
    ["bottom", "800px", "600px", { x: 100, y: 80, w: 800, h: 600 }],
    ["corner", "830px", "600px", { x: 100, y: 80, w: 830, h: 600 }],
  ] as const)("coalesces %s resize writes through the same frame path", (mode, width, height, expected) => {
    const { events, frames, commits, element, begin } = fixture();
    expect(begin(mode)).toBe(true);
    events.dispatchEvent(pointerEvent("pointermove", { clientX: 115, clientY: 100 }));
    events.dispatchEvent(pointerEvent("pointermove", { clientX: 130, clientY: 120 }));
    expect(frames.request).toHaveBeenCalledOnce();
    frames.flush();
    expect(element.style.width).toBe(width);
    expect(element.style.height).toBe(height);
    events.dispatchEvent(pointerEvent("pointerup", { clientX: 130, clientY: 120 }));
    expect(commits[0]?.rect).toEqual(expected);
    expect(commits).toHaveLength(1);
  });

  it("cancels pending frames, capture, and listeners on pointer cancel and lost capture", () => {
    const { events, frames, commits, element, handle, begin } = fixture();
    expect(begin("move", pointerEvent("pointerdown", { isPrimary: false }))).toBe(false);
    expect(begin("move", pointerEvent("pointerdown", { button: 2 }))).toBe(false);
    expect(begin("move")).toBe(true);
    events.dispatchEvent(pointerEvent("pointermove", { clientX: 140 }));
    events.dispatchEvent(pointerEvent("pointercancel", { pointerId: 8 }));
    expect(element.attributes.has("data-window-interacting")).toBe(true);
    events.dispatchEvent(pointerEvent("pointercancel"));
    expect(frames.cancel).toHaveBeenCalledOnce();
    expect(commits).toEqual([]);
    expect(handle.captures.size).toBe(0);

    expect(begin("move")).toBe(true);
    handle.captures.clear();
    handle.dispatchEvent(pointerEvent("lostpointercapture", { pointerId: 8 }));
    expect(element.attributes.has("data-window-interacting")).toBe(true);
    handle.dispatchEvent(pointerEvent("lostpointercapture"));
    expect(element.attributes.has("data-window-interacting")).toBe(false);
  });

  it("returns listener, frame, and capture resources to baseline across 20 cycles", () => {
    const { events, frames, engine, handle, begin } = fixture();
    for (let cycle = 0; cycle < 20; cycle += 1) {
      expect(begin("corner")).toBe(true);
      expect(engine.cancel()).toBe(true);
    }
    expect([...events.counts.values()]).toEqual([0, 0, 0, 0, 0]);
    expect(handle.counts.get("lostpointercapture")).toBe(0);
    expect(handle.captures.size).toBe(0);
    expect(frames.callbacks.size).toBe(0);
  });

  it("cancels on Escape, blur, explicit cancel, and destroy without committing", () => {
    const { events, commits, engine, element, begin } = fixture();
    expect(begin("move")).toBe(true);
    events.dispatchEvent(keyEvent("Enter"));
    expect(element.attributes.has("data-window-interacting")).toBe(true);
    const escape = keyEvent("Escape");
    events.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);

    expect(begin("move")).toBe(true);
    events.dispatchEvent(new Event("blur"));
    expect(begin("move")).toBe(true);
    expect(engine.cancel()).toBe(true);
    expect(begin("move")).toBe(true);
    engine.destroy();
    engine.destroy();
    expect(begin("move")).toBe(false);
    expect(commits).toEqual([]);
  });
});
