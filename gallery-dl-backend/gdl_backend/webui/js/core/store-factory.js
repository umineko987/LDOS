import { normalizeAction } from "./store-contract.js";
import { createStoreRuntime } from "./store-runtime.js";
import { createInitialState } from "./store-state.js";
import { reduceNormalizedRootState } from "./store-transition.js";
import { prepareInitialWindowState } from "./store-window-transition.js";

export function createStore({
  initialState = createInitialState(),
  reducer = reduceNormalizedRootState,
  reportError = () => console.error("ImageWeave 状态订阅者执行失败"),
} = {}) {
  return createStoreRuntime({
    initialState,
    reducer,
    normalizeAction,
    reportError,
    prepareInitialState: prepareInitialWindowState,
  });
}
