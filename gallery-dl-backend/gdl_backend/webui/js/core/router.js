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
  let pendingNavigation = null;

  const dispatch = (reason) => {
    const originalHash = window.location.hash;
    const route = parseHashRoute(originalHash);
    const malformed = route === null && !["", "#", "#/"].includes(originalHash);
    const canonicalHash = hashForRoute(route);
    const canonicalized = originalHash !== canonicalHash;
    if (canonicalized) {
      window.history.replaceState(null, "", urlForRoute(window.location, route));
    }
    const navigation = pendingNavigation?.hash === canonicalHash
      ? pendingNavigation
      : null;
    pendingNavigation = null;
    onRouteChange(route === null ? null : getApplicationByRoute(route), {
      reason,
      canonicalized,
      malformed,
      originalHash,
      skipBeforeLeave: navigation?.skipBeforeLeave === true,
    });
  };

  const onHashChange = () => dispatch("hashchange");

  return Object.freeze({
    start() {
      if (started) return;
      started = true;
      window.addEventListener("hashchange", onHashChange);
      dispatch("initial");
    },

    navigate(target, { replace = false, skipBeforeLeave = false } = {}) {
      const route = resolveNavigationTarget(target);
      const nextHash = hashForRoute(route);
      pendingNavigation = { hash: nextHash, skipBeforeLeave: skipBeforeLeave === true };
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
      const nextHash = hashForRoute(route);
      pendingNavigation = { hash: nextHash, skipBeforeLeave: true };
      window.history.replaceState(null, "", urlForRoute(window.location, route));
      dispatch("restore-route");
    },

    stop() {
      if (!started) return;
      started = false;
      pendingNavigation = null;
      window.removeEventListener("hashchange", onHashChange);
    },
  });
}
