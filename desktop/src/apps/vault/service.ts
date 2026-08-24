import type { ApiClient } from "../../core/api/client";
import {
  buildAuthorizationProxyPayload,
  extractVaultSessionReference,
  extractVaultSessionFromSnapshot,
  getVaultSiteDefinition,
  sanitizeAuthorizationProxy,
  sanitizeVaultSiteRead,
  sanitizeVaultSnapshot,
  type VaultAuthorizationProxy,
  type VaultFullRead,
  type VaultSessionReference,
  type VaultSiteId,
  type VaultSiteRead,
} from "./model";

export const VAULT_ENDPOINTS = Object.freeze({
  status: "/api/v1/auth",
  proxy: "/api/v1/auth/proxy",
  browserProfile: "/api/v1/auth/browser-profile",
  pixivOAuthStart: "/api/v1/auth/pixiv/oauth/start",
  pixivOAuthSession: "/api/v1/auth/pixiv/oauth/session",
} as const);

const VAULT_VIEW_QUERY = "view=vault";

export interface VaultService {
  readStatus(signal: AbortSignal): Promise<VaultFullRead>;
  readSite(site: VaultSiteId, signal: AbortSignal): Promise<VaultSiteRead>;
  readSession(reference: VaultSessionReference, signal: AbortSignal): Promise<VaultSiteRead>;
  authorize(site: VaultSiteId, signal: AbortSignal): Promise<unknown>;
  cancel(reference: VaultSessionReference, signal: AbortSignal): Promise<unknown>;
  clearSite(site: VaultSiteId, signal: AbortSignal): Promise<unknown>;
  clearProfile(signal: AbortSignal): Promise<unknown>;
  saveProxy(value: string, signal: AbortSignal): Promise<VaultAuthorizationProxy>;
  resetProxy(signal: AbortSignal): Promise<unknown>;
}

function viewUrl(path: string): string {
  return `${path}?${VAULT_VIEW_QUERY}`;
}

function sitePath(site: VaultSiteId): string {
  if (!getVaultSiteDefinition(site)) throw new TypeError("invalid_vault_site");
  return `${VAULT_ENDPOINTS.status}/${encodeURIComponent(site)}`;
}

function sessionPath(reference: VaultSessionReference): string {
  if (!getVaultSiteDefinition(reference.site) || (reference.kind !== "managed_browser" && reference.kind !== "oauth") || !/^[0-9a-f]{32}$/.test(reference.sessionId)) throw new TypeError("invalid_vault_session_reference");
  if ((reference.kind === "oauth") !== (reference.site === "pixiv")) throw new TypeError("invalid_vault_session_reference");
  return reference.kind === "oauth"
    ? VAULT_ENDPOINTS.pixivOAuthSession
    : `${sitePath(reference.site)}/login/${encodeURIComponent(reference.sessionId)}`;
}
function readSessionPath(reference: VaultSessionReference): string {
  if (!getVaultSiteDefinition(reference.site) || (reference.kind !== "managed_browser" && reference.kind !== "oauth") || !/^[0-9a-f]{32}$/.test(reference.sessionId)) throw new TypeError("invalid_vault_session_reference");
  if ((reference.kind === "oauth") !== (reference.site === "pixiv")) throw new TypeError("invalid_vault_session_reference");
  return reference.kind === "oauth" ? sitePath("pixiv") : `${sitePath(reference.site)}/login/${encodeURIComponent(reference.sessionId)}`;
}

export function createVaultService(api: ApiClient): VaultService {
  const service: VaultService = {
    async readStatus(signal) {
      const payload = await api.get(viewUrl(VAULT_ENDPOINTS.status), { signal });
      return Object.freeze({
        snapshot: sanitizeVaultSnapshot(payload),
        session: extractVaultSessionFromSnapshot(payload),
      });
    },
    async readSite(site, signal) {
      const payload = await api.get(viewUrl(sitePath(site)), { signal });
      return sanitizeVaultSiteRead(payload, site);
    },
    async readSession(reference, signal) {
      const payload = await api.get(viewUrl(readSessionPath(reference)), { signal });
      return sanitizeVaultSiteRead(payload, reference.site);
    },
    async authorize(site, signal) {
      const definition = getVaultSiteDefinition(site);
      if (!definition?.authorizeAction) throw new TypeError("unsupported_vault_authorization");
      const path = definition.authorizeAction === "oauth"
        ? VAULT_ENDPOINTS.pixivOAuthStart
        : `${sitePath(site)}/login/start`;
      return api.post(viewUrl(path), undefined, { signal });
    },
    async cancel(reference, signal) {
      return api.delete(viewUrl(sessionPath(reference)), { signal });
    },
    async clearSite(site, signal) {
      const definition = getVaultSiteDefinition(site);
      if (!definition || definition.method === "anonymous") throw new TypeError("unsupported_vault_clear");
      return api.delete(viewUrl(sitePath(site)), { signal });
    },
    async clearProfile(signal) {
      return api.delete(viewUrl(VAULT_ENDPOINTS.browserProfile), { signal });
    },
    saveProxy(value, signal) {
      const request = api.put(viewUrl(VAULT_ENDPOINTS.proxy), buildAuthorizationProxyPayload(value), { signal });
      return request.then(sanitizeAuthorizationProxy);
    },
    async resetProxy(signal) {
      return api.delete(viewUrl(VAULT_ENDPOINTS.proxy), { signal });
    },
  };
  return Object.freeze(service);
}

export { extractVaultSessionReference };
