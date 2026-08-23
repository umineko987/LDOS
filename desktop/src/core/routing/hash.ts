import {
  getApplicationDefinition,
  getApplicationDefinitionByRoute,
  type ApplicationId,
} from "../applications/definitions";

export type RouteReason = "initial" | "hashchange" | "navigate" | "restore";

export interface RouteChange {
  readonly appId: ApplicationId | null;
  readonly reason: RouteReason;
  readonly malformed: boolean;
  readonly skipUnsaved: boolean;
}

interface LocationLike {
  readonly pathname: string;
  readonly search: string;
  hash: string;
}

interface HistoryLike {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

interface EventSource {
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

export interface HashRouter {
  start(): void;
  navigate(target: ApplicationId | string | null, options?: { readonly replace?: boolean }): void;
  restore(target: ApplicationId | string | null): void;
  stop(): void;
}

export function parseHashRoute(hash: unknown): ApplicationId | null {
  if (hash === "" || hash === "#" || hash === "#/") return null;
  if (typeof hash !== "string" || !hash.startsWith("#/")) return null;
  return getApplicationDefinitionByRoute(hash.slice(1))?.id ?? null;
}

export function resolveNavigationTarget(target: ApplicationId | string | null): ApplicationId | null {
  if (target === null) return null;
  return getApplicationDefinition(target)?.id ?? getApplicationDefinitionByRoute(target)?.id ?? null;
}

export function hashForApplication(target: ApplicationId | string | null): string {
  const appId = resolveNavigationTarget(target);
  return appId ? `#${getApplicationDefinition(appId).route}` : "";
}

function isMalformedHash(hash: string, appId: ApplicationId | null): boolean {
  return appId === null && !["", "#", "#/"].includes(hash);
}

function urlFor(location: LocationLike, hash: string): string {
  return `${location.pathname}${location.search}${hash}`;
}

export function createHashRouter(
  onChange: (change: RouteChange) => void,
  {
    location = globalThis.location,
    history = globalThis.history,
    events = globalThis.window,
  }: {
    readonly location?: LocationLike;
    readonly history?: HistoryLike;
    readonly events?: EventSource;
  } = {},
): HashRouter {
  let started = false;

  const dispatch = (reason: RouteReason, skipUnsaved = false): void => {
    const originalHash = location.hash;
    const appId = parseHashRoute(originalHash);
    const malformed = isMalformedHash(originalHash, appId);
    const canonicalHash = hashForApplication(appId);
    if (canonicalHash !== originalHash) {
      history.replaceState(null, "", urlFor(location, canonicalHash));
      location.hash = canonicalHash;
    }
    onChange(Object.freeze({ appId, reason, malformed, skipUnsaved }));
  };

  const onHashChange = (): void => dispatch("hashchange");

  const navigate = (
    target: ApplicationId | string | null,
    { replace = false }: { readonly replace?: boolean } = {},
    reason: RouteReason = "navigate",
    skipUnsaved = false,
  ): void => {
    const hash = hashForApplication(target);
    const method = replace ? history.replaceState.bind(history) : history.pushState.bind(history);
    method(null, "", urlFor(location, hash));
    location.hash = hash;
    dispatch(reason, skipUnsaved);
  };

  return Object.freeze({
    start() {
      if (started) return;
      started = true;
      events.addEventListener("hashchange", onHashChange);
      dispatch("initial");
    },
    navigate(target, options) {
      navigate(target, options);
    },
    restore(target) {
      navigate(target, { replace: true }, "restore", true);
    },
    stop() {
      if (!started) return;
      started = false;
      events.removeEventListener("hashchange", onHashChange);
    },
  } satisfies HashRouter);
}
