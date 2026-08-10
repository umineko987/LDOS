import { cloneInput, makeImmutable } from "./store-data.js";

function reportSubscriberFailure(reportError) {
  try {
    reportError(Object.freeze({ kind: "subscriber_error" }));
  } catch {
    // 错误报告器不得中断其余订阅者。
  }
}

export function createStoreRuntime({
  initialState,
  reducer,
  normalizeAction = (input) => input,
  prepareInitialState = (state) => state,
  reportError = () => console.error("ImageWeave 状态订阅者执行失败"),
} = {}) {
  if (typeof reducer !== "function") throw new TypeError("reducer 必须是函数");
  if (typeof normalizeAction !== "function") throw new TypeError("action 规范化器必须是函数");
  if (typeof prepareInitialState !== "function") throw new TypeError("初始状态规范化器必须是函数");
  if (typeof reportError !== "function") throw new TypeError("错误报告器必须是函数");

  let state = makeImmutable(prepareInitialState(cloneInput(initialState)));
  let phase = "idle";
  const subscribers = new Set();

  const dispatch = (input) => {
    if (phase !== "idle") throw new Error("状态通知期间不得嵌套 dispatch");
    const normalized = normalizeAction(input);
    let nextState;
    phase = "reducing";
    try {
      nextState = reducer(state, normalized);
      if (nextState === undefined) throw new TypeError("reducer 必须返回状态");
      nextState = makeImmutable(nextState);
    } finally {
      phase = "idle";
    }
    if (nextState === state) return Object.freeze({ type: normalized.type });

    state = nextState;
    phase = "notifying";
    try {
      for (const subscription of [...subscribers]) {
        if (!subscribers.has(subscription)) continue;
        let selected;
        try {
          selected = subscription.selector(state);
          if (subscription.equality(selected, subscription.selected)) continue;
          const previous = subscription.selected;
          subscription.selected = selected;
          subscription.listener(
            selected,
            previous,
            Object.freeze({ type: normalized.type }),
          );
        } catch {
          reportSubscriberFailure(reportError);
        }
      }
    } finally {
      phase = "idle";
    }
    return Object.freeze({ type: normalized.type });
  };

  const subscribe = (selector, listener, options = {}) => {
    if (typeof listener !== "function") {
      listener = selector;
      selector = (current) => current;
    }
    if (typeof selector !== "function" || typeof listener !== "function") {
      throw new TypeError("subscribe 需要 selector 与 listener 函数");
    }
    const equality = options.equality || Object.is;
    if (typeof equality !== "function") throw new TypeError("订阅比较器必须是函数");
    const subscription = {
      selector,
      listener,
      equality,
      selected: selector(state),
    };
    subscribers.add(subscription);
    if (options.fireImmediately) {
      const previousPhase = phase;
      phase = "notifying";
      try {
        listener(subscription.selected, undefined, Object.freeze({ type: "store/initial" }));
      } catch {
        reportSubscriberFailure(reportError);
      } finally {
        phase = previousPhase;
      }
    }
    return () => subscribers.delete(subscription);
  };

  return Object.freeze({
    getState() {
      return state;
    },
    dispatch,
    subscribe,
  });
}
