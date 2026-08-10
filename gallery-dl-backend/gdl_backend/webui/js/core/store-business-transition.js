import { crawlCandidateVisible, validateCrawlSnapshot } from "./crawl-model.js";
import { validateDiagnosticsSnapshot } from "./diagnostics-model.js";
import { ACTION_TYPES, UnknownActionError } from "./store-contract.js";
import { isPlainObject } from "./store-data.js";
import { validatePolicySnapshot } from "./policy-model.js";
import { sanitizeProxySources, sanitizeProxyStatus } from "./proxy-model.js";
import {
  markReviewGroupDirty,
  markReviewPageSaved,
  sanitizeReviewSummary,
  updateReviewImageSelection,
  validateReviewState,
} from "./review-model.js";
import { validateBatchState } from "./tasks-model.js";
import { validateVaultSiteViewModel, validateVaultSnapshot } from "./vault-model.js";

const UI_STATUSES = new Set(["ready", "running", "warning", "error", "disabled"]);
const BUSINESS_ACTION_TYPES = new Set([
  ACTION_TYPES.SYSTEM_SHELL_SUMMARY_UPDATED,
  ACTION_TYPES.DIAGNOSTICS_RECEIVED,
  ACTION_TYPES.PROXY_STATUS_RECEIVED,
  ACTION_TYPES.PROXY_SOURCES_RECEIVED,
  ACTION_TYPES.POLICY_CONFIG_RECEIVED,
  ACTION_TYPES.AUTH_STATUS_RECEIVED,
  ACTION_TYPES.AUTH_SITE_STATUS_RECEIVED,
  ACTION_TYPES.CRAWL_SEARCH_RECEIVED,
  ACTION_TYPES.CRAWL_CANDIDATE_SELECTION_CHANGED,
  ACTION_TYPES.CRAWL_VISIBLE_SELECTION_CHANGED,
  ACTION_TYPES.CRAWL_SOURCE_MOVED,
  ACTION_TYPES.CRAWL_CANDIDATE_MOVED,
  ACTION_TYPES.CRAWL_WEAK_VISIBILITY_CHANGED,
  ACTION_TYPES.CRAWL_EH_FILTER_CHANGED,
  ACTION_TYPES.CRAWL_EH_FILTER_CLEARED,
  ACTION_TYPES.BATCH_ACTIVE_ID_CHANGED,
  ACTION_TYPES.BATCH_RECENT_RECEIVED,
  ACTION_TYPES.BATCH_SNAPSHOT_RECEIVED,
  ACTION_TYPES.BATCH_SNAPSHOT_CLEARED,
  ACTION_TYPES.REVIEW_WORKSPACE_RECEIVED,
  ACTION_TYPES.REVIEW_SUMMARY_RECEIVED,
  ACTION_TYPES.REVIEW_IMAGE_SELECTION_CHANGED,
  ACTION_TYPES.REVIEW_GROUP_CONFIRMED,
  ACTION_TYPES.REVIEW_PAGE_SAVED,
  ACTION_TYPES.REVIEW_CLEARED,
]);

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function requireString(value, label, maximum = 160) {
  if (typeof value !== "string" || value.length > maximum) {
    throw new TypeError(`${label}必须是长度不超过 ${maximum} 的字符串`);
  }
  return value;
}

function requireBatchId(value) {
  if (value === "") return value;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError("批次 ID 格式无效");
  }
  return value;
}

function validateSafeError(error) {
  if (error === null) return null;
  if (!isPlainObject(error)) throw new TypeError("摘要错误必须是对象或 null");
  const status = Number.isInteger(error.status) && error.status >= 0 ? error.status : 0;
  const code = requireString(error.code || "request_failed", "错误码", 128);
  const requestId = requireString(error.requestId || "", "请求 ID", 128);
  return { status, code, requestId };
}

function validateStatusDescriptor(descriptor) {
  if (!isPlainObject(descriptor) || !UI_STATUSES.has(descriptor.status)) {
    throw new TypeError("任务栏状态描述无效");
  }
  return {
    status: descriptor.status,
    label: requireString(descriptor.label, "状态文本", 100),
  };
}

function validateShellSnapshot(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.summary)) {
    throw new TypeError("系统摘要 payload 无效");
  }
  if (!isPlainObject(payload.errors)) throw new TypeError("系统摘要错误字段无效");
  const lastCheckedAt = Number(payload.lastCheckedAt);
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt < 0) {
    throw new TypeError("系统摘要时间无效");
  }
  return {
    health: payload.health ?? null,
    readiness: payload.readiness ?? null,
    apiConnected: requireBoolean(payload.apiConnected, "API 连接状态"),
    summary: {
      api: validateStatusDescriptor(payload.summary.api),
      proxy: validateStatusDescriptor(payload.summary.proxy),
      dedup: validateStatusDescriptor(payload.summary.dedup),
    },
    errors: {
      health: validateSafeError(payload.errors.health ?? null),
      readiness: validateSafeError(payload.errors.readiness ?? null),
    },
    lastCheckedAt,
  };
}

function requireCandidateKey(value) {
  if (typeof value !== "string" || !/^candidate:\d+:\d+$/.test(value)) {
    throw new TypeError("抓取候选键无效");
  }
  return value;
}

function requireSourceKey(value) {
  if (typeof value !== "string" || !/^source:[a-z]+:\d+$/.test(value)) {
    throw new TypeError("抓取来源键无效");
  }
  return value;
}

function requireDirection(value) {
  if (value !== -1 && value !== 1) throw new TypeError("移动方向无效");
  return value;
}

function moveAt(items, index, target) {
  if (index < 0 || target < 0 || target >= items.length || index === target) return items;
  const result = [...items];
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}

function mapCrawlCandidates(crawl, keys, selected) {
  const keySet = new Set(keys.map(requireCandidateKey));
  let changed = false;
  const sources = crawl.sources.map((source) => {
    const addresses = source.addresses.map((candidate) => {
      if (!keySet.has(candidate.key) || candidate.selected === selected) return candidate;
      changed = true;
      return { ...candidate, selected };
    });
    return addresses === source.addresses ? source : { ...source, addresses };
  });
  return changed ? { ...crawl, sources } : crawl;
}

function emptyReviewState(batchId = "") {
  return {
    batchId: requireBatchId(batchId),
    summary: null,
    groups: [],
    filter: "",
    offset: 0,
    limit: 0,
    total: 0,
    dirty: false,
    dirtyGroupIds: [],
  };
}

export function isBusinessActionType(type) {
  return BUSINESS_ACTION_TYPES.has(type);
}

export function reduceBusinessState(state, action) {
  switch (action.type) {
    case ACTION_TYPES.SYSTEM_SHELL_SUMMARY_UPDATED: {
      const snapshot = validateShellSnapshot(action.payload);
      return { ...state, system: { ...state.system, ...snapshot } };
    }
    case ACTION_TYPES.DIAGNOSTICS_RECEIVED:
      return {
        ...state,
        diagnostics: { snapshot: validateDiagnosticsSnapshot(action.payload) },
      };
    case ACTION_TYPES.PROXY_STATUS_RECEIVED:
      return {
        ...state,
        proxy: { ...state.proxy, status: sanitizeProxyStatus(action.payload) },
      };
    case ACTION_TYPES.PROXY_SOURCES_RECEIVED:
      return {
        ...state,
        proxy: { ...state.proxy, sources: sanitizeProxySources(action.payload) },
      };
    case ACTION_TYPES.POLICY_CONFIG_RECEIVED:
      return {
        ...state,
        policy: { config: validatePolicySnapshot(action.payload) },
      };
    case ACTION_TYPES.AUTH_STATUS_RECEIVED: {
      const snapshot = validateVaultSnapshot(action.payload);
      const bySite = new Map(state.auth.bySite);
      for (const [siteId, site] of snapshot.bySite) bySite.set(siteId, site);
      return {
        ...state,
        auth: {
          bySite,
          browserProfile: snapshot.browserProfile,
          authorizationProxy: snapshot.authorizationProxy,
        },
      };
    }
    case ACTION_TYPES.AUTH_SITE_STATUS_RECEIVED: {
      const site = validateVaultSiteViewModel(action.payload);
      const bySite = new Map(state.auth.bySite);
      bySite.set(site.site, site);
      return { ...state, auth: { ...state.auth, bySite } };
    }
    case ACTION_TYPES.CRAWL_SEARCH_RECEIVED:
      return { ...state, crawl: validateCrawlSnapshot(action.payload) };
    case ACTION_TYPES.CRAWL_CANDIDATE_SELECTION_CHANGED: {
      const key = requireCandidateKey(action.payload?.key);
      const selected = requireBoolean(action.payload?.selected, "候选选择状态");
      return {
        ...state,
        crawl: mapCrawlCandidates(state.crawl, [key], selected),
      };
    }
    case ACTION_TYPES.CRAWL_VISIBLE_SELECTION_CHANGED: {
      if (!Array.isArray(action.payload?.keys)) throw new TypeError("可见候选键列表无效");
      const selected = requireBoolean(action.payload?.selected, "批量选择状态");
      return {
        ...state,
        crawl: mapCrawlCandidates(state.crawl, action.payload.keys, selected),
      };
    }
    case ACTION_TYPES.CRAWL_SOURCE_MOVED: {
      const key = requireSourceKey(action.payload?.key);
      const direction = requireDirection(action.payload?.direction);
      const index = state.crawl.sources.findIndex((source) => source.key === key);
      const sources = moveAt(state.crawl.sources, index, index + direction);
      return sources === state.crawl.sources
        ? state
        : { ...state, crawl: { ...state.crawl, sources } };
    }
    case ACTION_TYPES.CRAWL_CANDIDATE_MOVED: {
      const sourceKey = requireSourceKey(action.payload?.sourceKey);
      const key = requireCandidateKey(action.payload?.key);
      const direction = requireDirection(action.payload?.direction);
      let changed = false;
      const sources = state.crawl.sources.map((source) => {
        if (source.key !== sourceKey) return source;
        const visibleIndices = source.addresses
          .map((candidate, index) => (
            crawlCandidateVisible(state.crawl, source, candidate) ? index : -1
          ))
          .filter((index) => index >= 0);
        const index = source.addresses.findIndex((candidate) => candidate.key === key);
        const visiblePosition = visibleIndices.indexOf(index);
        const targetPosition = visiblePosition + direction;
        if (
          visiblePosition < 0
          || targetPosition < 0
          || targetPosition >= visibleIndices.length
        ) return source;
        const addresses = moveAt(source.addresses, index, visibleIndices[targetPosition]);
        if (addresses === source.addresses) return source;
        changed = true;
        return { ...source, addresses };
      });
      return changed ? { ...state, crawl: { ...state.crawl, sources } } : state;
    }
    case ACTION_TYPES.CRAWL_WEAK_VISIBILITY_CHANGED: {
      const visible = requireBoolean(action.payload?.visible, "待核实结果显示状态");
      let crawl = { ...state.crawl, showWeakEvidence: visible };
      if (!visible) {
        const weakKeys = crawl.sources.flatMap((source) =>
          source.addresses
            .filter((candidate) => candidate.weak)
            .map((candidate) => candidate.key));
        crawl = mapCrawlCandidates(crawl, weakKeys, false);
      }
      return { ...state, crawl };
    }
    case ACTION_TYPES.CRAWL_EH_FILTER_CHANGED: {
      const key = requireString(action.payload?.key, "EH 标签键", 180);
      if (!/^[a-z]+:[^\u0000-\u001f\u007f]{1,160}$/.test(key)) {
        throw new TypeError("EH 标签键无效");
      }
      const mode = action.payload?.mode;
      if (!["include", "exclude", ""].includes(mode)) throw new TypeError("EH 标签模式无效");
      const filter = new Map(state.crawl.ehTagFilter);
      if (mode) filter.set(key, mode);
      else filter.delete(key);
      return { ...state, crawl: { ...state.crawl, ehTagFilter: filter } };
    }
    case ACTION_TYPES.CRAWL_EH_FILTER_CLEARED:
      return { ...state, crawl: { ...state.crawl, ehTagFilter: new Map() } };
    case ACTION_TYPES.BATCH_ACTIVE_ID_CHANGED:
      return {
        ...state,
        batches: { ...state.batches, activeId: requireBatchId(action.payload?.batchId) },
      };
    case ACTION_TYPES.BATCH_RECENT_RECEIVED: {
      const projected = validateBatchState({
        batch: state.batches.active,
        tasks: state.batches.tasks,
        recent: action.payload,
      });
      return {
        ...state,
        batches: { ...state.batches, recent: projected.recent },
      };
    }
    case ACTION_TYPES.BATCH_SNAPSHOT_RECEIVED: {
      const projected = validateBatchState({
        batch: action.payload?.batch,
        tasks: action.payload?.tasks,
        recent: state.batches.recent,
      });
      return {
        ...state,
        batches: { ...state.batches, active: projected.batch, tasks: projected.tasks },
      };
    }
    case ACTION_TYPES.BATCH_SNAPSHOT_CLEARED:
      return { ...state, batches: { ...state.batches, active: null, tasks: [] } };
    case ACTION_TYPES.REVIEW_WORKSPACE_RECEIVED:
      return { ...state, review: validateReviewState(action.payload) };
    case ACTION_TYPES.REVIEW_SUMMARY_RECEIVED: {
      const batchId = requireBatchId(action.payload?.batchId);
      const summary = sanitizeReviewSummary(action.payload?.summary, batchId);
      const review = state.review.batchId === batchId
        ? { ...state.review, summary }
        : { ...emptyReviewState(batchId), summary };
      return { ...state, review };
    }
    case ACTION_TYPES.REVIEW_IMAGE_SELECTION_CHANGED:
      return {
        ...state,
        review: updateReviewImageSelection(
          state.review,
          action.payload?.groupId,
          action.payload?.imageId,
          requireBoolean(action.payload?.selected, "审核图片选择状态"),
        ),
      };
    case ACTION_TYPES.REVIEW_GROUP_CONFIRMED: {
      const review = markReviewGroupDirty(state.review, action.payload?.groupId);
      return review === state.review ? state : { ...state, review };
    }
    case ACTION_TYPES.REVIEW_PAGE_SAVED:
      return { ...state, review: markReviewPageSaved(state.review, action.payload?.summary) };
    case ACTION_TYPES.REVIEW_CLEARED:
      return { ...state, review: emptyReviewState(action.payload?.batchId || "") };
    default:
      throw new UnknownActionError(action.type);
  }
}
