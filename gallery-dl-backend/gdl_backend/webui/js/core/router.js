import {
  getApplicationById,
  getApplicationByRoute,
} from "./app-registry.js";

function launchableApplication(application) {
  return application
    && (application.availability === "ready" || application.availability === "preview")
    ? application
    : null;
}

function routeFromTarget(target) {
  if (typeof target !== "string") return null;
  const byId = launchableApplication(getApplicationById(target));
  if (byId) return byId.route;
  return launchableApplication(getApplicationByRoute(target))?.route || null;
}

export function parseHashRoute(hash) {
  if (hash === "" || hash === "#" || hash === "#/") return null;
  if (typeof hash !== "string" || !hash.startsWith("#/")) return null;
  const route = hash.slice(1);
  return launchableApplication(getApplicationByRoute(route)) ? route : null;
}

export function hashForRoute(route) {
  const normalized = routeFromTarget(route);
  return normalized ? `#${normalized}` : "";
}

export function resolveNavigationTarget(target) {
  return routeFromTarget(target);
}

function desktopUrl(location) {
  return `${location.pathname}${location.search}`;
}

function urlForRoute(location, route) {
  return `${desktopUrl(location)}${hashForRoute(route)}`;
}

export function createHashRouter(onRouteChange) {
  if (typeof onRouteChange !== "function") throw new TypeError("路由回调必须是函数");
  let started = false;

  const dispatch = (reason) => {
    const originalHash = window.location.hash;
    const route = parseHashRoute(originalHash);
    const malformed = route === null && !["", "#", "#/"].includes(originalHash);
    const canonicalHash = hashForRoute(route);
    const canonicalized = originalHash !== canonicalHash;
    if (canonicalized) {
      window.history.replaceState(null, "", urlForRoute(window.location, route));
    }
    onRouteChange(route === null ? null : getApplicationByRoute(route), {
      reason,
      canonicalized,
      malformed,
      originalHash,
    });
  };

  const onHashChange = () => dispatch("hashchange");
  const onPopState = () => dispatch("popstate");

  return Object.freeze({
    start() {
      if (started) return;
      started = true;
      window.addEventListener("hashchange", onHashChange);
      window.addEventListener("popstate", onPopState);
      dispatch("initial");
    },

    navigate(target, { replace = false } = {}) {
      const route = resolveNavigationTarget(target);
      const nextHash = hashForRoute(route);
      if (window.location.hash === nextHash) {
        dispatch("same-route");
      } else if (replace) {
        window.history.replaceState(null, "", urlForRoute(window.location, route));
        dispatch("replace-route");
      } else if (nextHash) {
        window.location.hash = nextHash;
      } else {
        window.history.pushState?.(null, "", desktopUrl(window.location));
        if (window.location.hash !== "") window.location.hash = "";
        dispatch("desktop-navigation");
      }
    },

    restore(target) {
      const route = resolveNavigationTarget(target);
      window.history.replaceState(null, "", urlForRoute(window.location, route));
      dispatch("restore-route");
    },

    stop() {
      if (!started) return;
      started = false;
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onPopState);
    },
  });
}
