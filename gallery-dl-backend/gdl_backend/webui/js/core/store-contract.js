import { cloneInput, isPlainObject } from "./store-data.js";

export const ACTION_TYPES = Object.freeze({
  SYSTEM_SHELL_SUMMARY_UPDATED: "system/shellSummaryUpdated",
  DIAGNOSTICS_RECEIVED: "diagnostics/received",
  PROXY_STATUS_RECEIVED: "proxy/statusReceived",
  PROXY_SOURCES_RECEIVED: "proxy/sourcesReceived",
  POLICY_CONFIG_RECEIVED: "policy/configReceived",
  AUTH_STATUS_RECEIVED: "auth/statusReceived",
  AUTH_SITE_STATUS_RECEIVED: "auth/siteStatusReceived",
  CRAWL_SEARCH_RECEIVED: "crawl/searchReceived",
  CRAWL_CANDIDATE_SELECTION_CHANGED: "crawl/candidateSelectionChanged",
  CRAWL_VISIBLE_SELECTION_CHANGED: "crawl/visibleSelectionChanged",
  CRAWL_SOURCE_MOVED: "crawl/sourceMoved",
  CRAWL_CANDIDATE_MOVED: "crawl/candidateMoved",
  CRAWL_WEAK_VISIBILITY_CHANGED: "crawl/weakVisibilityChanged",
  CRAWL_EH_FILTER_CHANGED: "crawl/ehFilterChanged",
  CRAWL_EH_FILTER_CLEARED: "crawl/ehFilterCleared",
  BATCH_ACTIVE_ID_CHANGED: "batches/activeIdChanged",
  BATCH_RECENT_RECEIVED: "batches/recentReceived",
  BATCH_SNAPSHOT_RECEIVED: "batches/snapshotReceived",
  BATCH_SNAPSHOT_CLEARED: "batches/snapshotCleared",
  REVIEW_WORKSPACE_RECEIVED: "review/workspaceReceived",
  REVIEW_SUMMARY_RECEIVED: "review/summaryReceived",
  REVIEW_IMAGE_SELECTION_CHANGED: "review/imageSelectionChanged",
  REVIEW_GROUP_CONFIRMED: "review/groupConfirmed",
  REVIEW_PAGE_SAVED: "review/pageSaved",
  REVIEW_CLEARED: "review/cleared",
  UI_WINDOW_OPENED: "ui/windowOpened",
  UI_WINDOW_CLOSED: "ui/windowClosed",
  UI_WINDOW_FOCUSED: "ui/windowFocused",
  UI_WINDOW_MOVED: "ui/windowMoved",
  UI_WINDOW_STATE_CHANGED: "ui/windowStateChanged",
});

const KNOWN_ACTION_TYPES = new Set(Object.values(ACTION_TYPES));

export class UnknownActionError extends Error {
  constructor(type) {
    super(`未知状态 action：${type}`);
    this.name = "UnknownActionError";
    this.actionType = type;
  }
}

export function normalizeAction(input) {
  if (!isPlainObject(input) || typeof input.type !== "string" || !input.type) {
    throw new TypeError("action 必须包含非空 type");
  }
  if (!KNOWN_ACTION_TYPES.has(input.type)) throw new UnknownActionError(input.type);
  return {
    type: input.type,
    payload: cloneInput(input.payload),
  };
}
