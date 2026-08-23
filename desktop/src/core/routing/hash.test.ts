import { describe, expect, it, vi } from "vitest";

import { APPLICATION_DEFINITIONS } from "../applications/definitions";
import {
  createHashRouter,
  hashForApplication,
  parseHashRoute,
  resolveNavigationTarget,
  type RouteChange,
} from "./hash";

function routerFixture(initialHash = "") {
  const location = { pathname: "/ui/", search: "?mode=test", hash: initialHash };
  const listeners = new Set<() => void>();
  const history = {
    pushState: vi.fn(),
    replaceState: vi.fn(),
  };
  const events = {
    addEventListener: vi.fn((_type: "hashchange", listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: "hashchange", listener: () => void) => listeners.delete(listener)),
  };
  return { location, history, events, emit: () => { for (const listener of listeners) listener(); } };
}

describe("Hash routing", () => {
  it("maps only the ten canonical IDs and routes", () => {
    for (const definition of APPLICATION_DEFINITIONS) {
      expect(parseHashRoute(`#${definition.route}`)).toBe(definition.id);
      expect(resolveNavigationTarget(definition.id)).toBe(definition.id);
      expect(resolveNavigationTarget(definition.route)).toBe(definition.id);
      expect(hashForApplication(definition.id)).toBe(`#${definition.route}`);
    }
    for (const malformed of ["", "#", "#/", "#/unknown", "#/crawl?window=tasks", "not-a-hash", 42]) {
      expect(parseHashRoute(malformed)).toBeNull();
    }
    expect(resolveNavigationTarget(null)).toBeNull();
    expect(resolveNavigationTarget("unknown")).toBeNull();
    expect(hashForApplication(null)).toBe("");
    expect(hashForApplication("unknown")).toBe("");
  });

  it("canonicalizes malformed initial hashes and removes its listener", () => {
    const fixture = routerFixture("#/unknown");
    const changes: RouteChange[] = [];
    const router = createHashRouter((change) => changes.push(change), fixture);
    router.start();
    router.start();
    expect(changes).toEqual([{
      appId: null,
      reason: "initial",
      malformed: true,
      skipUnsaved: false,
    }]);
    expect(Object.isFrozen(changes[0])).toBe(true);
    expect(fixture.location.hash).toBe("");
    expect(fixture.history.replaceState).toHaveBeenCalledWith(null, "", "/ui/?mode=test");
    expect(fixture.events.addEventListener).toHaveBeenCalledOnce();

    router.stop();
    router.stop();
    expect(fixture.events.removeEventListener).toHaveBeenCalledOnce();
  });

  it("opens one target, supports replacement/restore, and follows hashchange", () => {
    const fixture = routerFixture();
    const changes: RouteChange[] = [];
    const router = createHashRouter((change) => changes.push(change), fixture);
    router.start();

    router.navigate("crawl");
    expect(fixture.history.pushState).toHaveBeenLastCalledWith(null, "", "/ui/?mode=test#/crawl");
    expect(changes.at(-1)).toMatchObject({ appId: "crawl", reason: "navigate", skipUnsaved: false });

    router.navigate("tasks", { replace: true });
    expect(fixture.history.replaceState).toHaveBeenLastCalledWith(null, "", "/ui/?mode=test#/tasks");
    expect(changes.at(-1)?.appId).toBe("tasks");

    router.restore("review");
    expect(changes.at(-1)).toEqual({
      appId: "review",
      reason: "restore",
      malformed: false,
      skipUnsaved: true,
    });

    fixture.location.hash = "#/gallery";
    fixture.emit();
    expect(changes.at(-1)).toMatchObject({ appId: "gallery", reason: "hashchange" });

    router.navigate("unknown");
    expect(fixture.location.hash).toBe("");
    expect(changes.at(-1)).toMatchObject({ appId: null, reason: "navigate", malformed: false });
    router.stop();
  });
});
