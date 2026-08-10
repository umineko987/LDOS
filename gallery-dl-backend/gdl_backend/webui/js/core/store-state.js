import { projectCrawlSearchResponse } from "./crawl-model.js";
import { validateDiagnosticsSnapshot } from "./diagnostics-model.js";
import { sanitizePolicyResponse } from "./policy-model.js";
import { sanitizeReviewSummary, validateReviewState } from "./review-model.js";
import { ACTION_TYPES } from "./store-contract.js";
import {
  sanitizeBatchDetail,
  sanitizeRecentBatches,
  sanitizeTaskPage,
} from "./tasks-model.js";
import { sanitizeVaultSiteStatus, sanitizeVaultStatus } from "./vault-model.js";
import { createInitialUiState, selectWindowView } from "./store-window-transition.js";

function initialSummary() {
  return {
    api: { status: "disabled", label: "服务检查中" },
    proxy: { status: "disabled", label: "代理检查中" },
    dedup: { status: "disabled", label: "去重检查中" },
  };
}

export function createInitialState({ windows = [] } = {}) {
  return {
    system: {
      health: null,
      readiness: null,
      apiConnected: false,
      summary: initialSummary(),
      errors: { health: null, readiness: null },
      lastCheckedAt: null,
    },
    diagnostics: {
      snapshot: null,
    },
    proxy: {
      status: null,
      sources: null,
    },
    auth: {
      bySite: new Map(),
      browserProfile: null,
      authorizationProxy: null,
    },
    policy: {
      config: null,
    },
    crawl: {
      sources: [],
      relatedProfiles: [],
      addressCount: 0,
      weakEvidenceCount: 0,
      showWeakEvidence: false,
      ehTagFilter: new Map(),
    },
    batches: {
      activeId: "",
      active: null,
      tasks: [],
      recent: [],
    },
    review: {
      batchId: "",
      summary: null,
      groups: [],
      filter: "",
      offset: 0,
      limit: 0,
      total: 0,
      dirty: false,
      dirtyGroupIds: [],
    },
    ui: createInitialUiState(windows),
  };
}

function action(type, payload) {
  return { type, payload };
}

export const actionCreators = Object.freeze({
  shellSummaryUpdated(snapshot) {
    return action(ACTION_TYPES.SYSTEM_SHELL_SUMMARY_UPDATED, snapshot);
  },
  diagnosticsReceived(snapshot) {
    return action(ACTION_TYPES.DIAGNOSTICS_RECEIVED, validateDiagnosticsSnapshot(snapshot));
  },
  proxyStatusReceived(status) {
    return action(ACTION_TYPES.PROXY_STATUS_RECEIVED, status);
  },
  proxySourcesReceived(sources) {
    return action(ACTION_TYPES.PROXY_SOURCES_RECEIVED, sources);
  },
  policyConfigReceived(config) {
    return action(ACTION_TYPES.POLICY_CONFIG_RECEIVED, sanitizePolicyResponse(config));
  },
  authStatusReceived(status) {
    return action(ACTION_TYPES.AUTH_STATUS_RECEIVED, sanitizeVaultStatus(status));
  },
  authSiteStatusReceived(status) {
    return action(ACTION_TYPES.AUTH_SITE_STATUS_RECEIVED, sanitizeVaultSiteStatus(status));
  },
  crawlSearchReceived(response) {
    return action(ACTION_TYPES.CRAWL_SEARCH_RECEIVED, projectCrawlSearchResponse(response).snapshot);
  },
  crawlCandidateSelectionChanged(key, selected) {
    return action(ACTION_TYPES.CRAWL_CANDIDATE_SELECTION_CHANGED, { key, selected });
  },
  crawlVisibleSelectionChanged(keys, selected) {
    return action(ACTION_TYPES.CRAWL_VISIBLE_SELECTION_CHANGED, { keys, selected });
  },
  crawlSourceMoved(key, direction) {
    return action(ACTION_TYPES.CRAWL_SOURCE_MOVED, { key, direction });
  },
  crawlCandidateMoved(sourceKey, key, direction) {
    return action(ACTION_TYPES.CRAWL_CANDIDATE_MOVED, { sourceKey, key, direction });
  },
  crawlWeakVisibilityChanged(visible) {
    return action(ACTION_TYPES.CRAWL_WEAK_VISIBILITY_CHANGED, { visible });
  },
  crawlEhFilterChanged(key, mode) {
    return action(ACTION_TYPES.CRAWL_EH_FILTER_CHANGED, { key, mode });
  },
  crawlEhFilterCleared() {
    return action(ACTION_TYPES.CRAWL_EH_FILTER_CLEARED, {});
  },
  activeBatchIdChanged(batchId) {
    return action(ACTION_TYPES.BATCH_ACTIVE_ID_CHANGED, { batchId });
  },
  recentBatchesReceived(response) {
    return action(ACTION_TYPES.BATCH_RECENT_RECEIVED, sanitizeRecentBatches(response));
  },
  batchSnapshotReceived(batch, tasks) {
    const safeBatch = sanitizeBatchDetail(batch);
    const safeTasks = sanitizeTaskPage(tasks, safeBatch.id).tasks;
    return action(ACTION_TYPES.BATCH_SNAPSHOT_RECEIVED, { batch: safeBatch, tasks: safeTasks });
  },
  batchSnapshotCleared() {
    return action(ACTION_TYPES.BATCH_SNAPSHOT_CLEARED, {});
  },
  reviewWorkspaceReceived(workspace) {
    return action(ACTION_TYPES.REVIEW_WORKSPACE_RECEIVED, validateReviewState(workspace));
  },
  reviewSummaryReceived(batchId, summary) {
    return action(ACTION_TYPES.REVIEW_SUMMARY_RECEIVED, {
      batchId,
      summary: sanitizeReviewSummary(summary, batchId),
    });
  },
  reviewImageSelectionChanged(groupId, imageId, selected) {
    return action(ACTION_TYPES.REVIEW_IMAGE_SELECTION_CHANGED, { groupId, imageId, selected });
  },
  reviewGroupConfirmed(groupId) {
    return action(ACTION_TYPES.REVIEW_GROUP_CONFIRMED, { groupId });
  },
  reviewPageSaved(summary, batchId = summary?.batch_id || summary?.batchId) {
    return action(ACTION_TYPES.REVIEW_PAGE_SAVED, {
      summary: sanitizeReviewSummary(summary, batchId),
    });
  },
  reviewCleared(batchId = "") {
    return action(ACTION_TYPES.REVIEW_CLEARED, { batchId });
  },
  windowOpened(appId) {
    return action(ACTION_TYPES.UI_WINDOW_OPENED, { appId });
  },
  windowClosed(appId) {
    return action(ACTION_TYPES.UI_WINDOW_CLOSED, { appId });
  },
  windowFocused(appId) {
    return action(ACTION_TYPES.UI_WINDOW_FOCUSED, { appId });
  },
  windowMoved(appId, rect) {
    return action(ACTION_TYPES.UI_WINDOW_MOVED, { appId, rect });
  },
  windowStateChanged(appId, windowState) {
    return action(ACTION_TYPES.UI_WINDOW_STATE_CHANGED, { appId, windowState });
  },
  startMenuChanged(open) {
    return action(ACTION_TYPES.UI_START_MENU_CHANGED, { open });
  },
});

export const selectors = Object.freeze({
  focusedAppId: (state) => state.ui.focusedAppId,
  startMenuOpen: (state) => state.ui.startMenuOpen,
  taskbarSummary: (state) => state.system.summary,
  diagnostics: (state) => state.diagnostics.snapshot,
  proxyStatus: (state) => state.proxy.status,
  proxySources: (state) => state.proxy.sources,
  policyConfig: (state) => state.policy.config,
  authSites: (state) => state.auth.bySite,
  authBrowserProfile: (state) => state.auth.browserProfile,
  authAuthorizationProxy: (state) => state.auth.authorizationProxy,
  crawl: (state) => state.crawl,
  activeBatchId: (state) => state.batches.activeId,
  activeBatch: (state) => state.batches.active,
  batchTasks: (state) => state.batches.tasks,
  recentBatches: (state) => state.batches.recent,
  review: (state) => state.review,
  windowStack: (state) => state.ui.windows,
  windowView: selectWindowView,
});
