import type { ApiClient } from "../../core/api/client";
import {
  buildPolicyPayload,
  getPolicySiteDefinition,
  sanitizePolicyResponse,
  type PolicyConfig,
  type PolicyDraft,
  type PolicySiteId,
  type PolicySnapshot,
} from "./model";

export const POLICY_ENDPOINTS = Object.freeze({
  policies: "/api/v1/sites/policies",
} as const);

const POLICY_VIEW_QUERY = "view=policy";

export interface PolicyService {
  read(signal: AbortSignal): Promise<PolicySnapshot>;
  save(site: PolicySiteId, draft: PolicyDraft, signal: AbortSignal): Promise<void>;
  reset(site: PolicySiteId, signal: AbortSignal): Promise<void>;
}

function sitePath(site: PolicySiteId): string {
  if (!getPolicySiteDefinition(site)) throw new TypeError("invalid_policy_site");
  return `${POLICY_ENDPOINTS.policies}/${encodeURIComponent(site)}`;
}

function viewUrl(path: string): string {
  return `${path}?${POLICY_VIEW_QUERY}`;
}

export function createPolicyService(api: ApiClient): PolicyService {
  const service: PolicyService = {
    async read(signal) {
      return sanitizePolicyResponse(await api.get(viewUrl(POLICY_ENDPOINTS.policies), { signal }));
    },
    async save(site, draft, signal) {
      const payload: PolicyConfig = buildPolicyPayload(draft);
      await api.put(viewUrl(sitePath(site)), payload, { signal });
    },
    async reset(site, signal) {
      await api.delete(viewUrl(sitePath(site)), { signal });
    },
  };
  return Object.freeze(service);
}
