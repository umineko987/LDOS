import {
  isBusinessActionType,
  reduceBusinessState,
} from "./store-business-transition.js";
import { normalizeAction, UnknownActionError } from "./store-contract.js";
import {
  isWindowActionType,
  reduceWindowState,
  withDerivedWindowFocus,
} from "./store-window-transition.js";

export function reduceNormalizedRootState(state, action) {
  let nextState;
  if (isBusinessActionType(action.type)) {
    nextState = reduceBusinessState(state, action);
  } else if (isWindowActionType(action.type)) {
    nextState = reduceWindowState(state, action);
  } else {
    throw new UnknownActionError(action.type);
  }
  return withDerivedWindowFocus(nextState);
}

export function rootReducer(state, action) {
  return reduceNormalizedRootState(state, normalizeAction(action));
}
