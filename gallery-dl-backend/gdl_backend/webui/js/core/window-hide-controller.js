export function createWindowHideController({
  getApplication,
  getInstance,
  getRecord,
  isUnavailable,
  onBeforeHide,
}) {
  const requests = new Map();

  const stateFor = (appId) => {
    if (!requests.has(appId)) {
      requests.set(appId, { sequence: 0, pending: false });
    }
    return requests.get(appId);
  };

  const request = (instance, visibility, commit) => {
    const record = getRecord(instance.appId);
    const requestState = stateFor(instance.appId);
    if (
      isUnavailable()
      || requestState.pending
      || !record
      || record.windowState === "minimized"
    ) return;
    const app = getApplication(instance.appId);
    let decision = true;
    try {
      decision = typeof onBeforeHide === "function"
        ? onBeforeHide(app, visibility)
        : true;
    } catch {
      decision = false;
    }

    if (typeof decision?.then !== "function") {
      if (decision === true && !isUnavailable()) commit(app);
      return;
    }

    requestState.pending = true;
    const requestSequence = ++requestState.sequence;
    void Promise.resolve(decision)
      .then((allowed) => {
        const current = getRecord(instance.appId);
        if (
          allowed !== true
          || isUnavailable()
          || requestSequence !== requestState.sequence
          || getInstance(instance.appId) !== instance
          || !current
          || current.windowState === "minimized"
        ) return;
        commit(app);
      })
      .catch(() => {})
      .finally(() => {
        if (requestSequence === requestState.sequence) requestState.pending = false;
      });
  };

  const invalidate = (appId) => {
    const requestState = requests.get(appId);
    if (requestState) {
      requestState.sequence += 1;
      requestState.pending = false;
    }
    requests.delete(appId);
  };

  const destroy = () => {
    for (const appId of [...requests.keys()]) invalidate(appId);
  };

  return Object.freeze({ destroy, invalidate, request });
}
