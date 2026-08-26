import type { ApiClient } from "../../core/api/client";
import {
  sanitizeGalleryAnnotation,
  sanitizeGalleryDirectoryPage,
  sanitizeGallerySourcePage,
  validateGalleryQuery,
  type GalleryAnnotation,
  type GalleryDirectoryPage,
  type GallerySourceSummary,
  type GalleryTxtState,
} from "./model";

export const GALLERY_PAGE_LIMIT = 60;
export const GALLERY_PAGE_LIMITS = [30, 60, 120] as const;

export const GALLERY_ENDPOINTS = Object.freeze({
  sources: "/api/v1/gallery/sources",
  directoryEntries: "/api/v1/gallery/directories",
} as const);

export interface GalleryDirectoryRequest {
  readonly directoryId: string;
  readonly includeDescendants: boolean;
  readonly txtState: GalleryTxtState | null;
  readonly query: string;
  readonly directoryCursor: string | null;
  readonly assetCursor: string | null;
}

export interface GalleryService {
  listSources(signal: AbortSignal): Promise<readonly GallerySourceSummary[]>;
  listDirectoryEntries(
    request: GalleryDirectoryRequest,
    signal: AbortSignal,
  ): Promise<GalleryDirectoryPage>;
  thumbnailUrl(assetId: string): string;
  contentUrl(assetId: string): string;
  getAnnotation(assetId: string, signal: AbortSignal): Promise<GalleryAnnotation>;
}

function endpointId(id: string): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new TypeError("invalid_gallery_id");
  }
  return encodeURIComponent(id);
}

export function directoryEntriesPath(request: GalleryDirectoryRequest): string {
  const parameters: string[] = ["view=desktop"];
  if (request.includeDescendants) parameters.push("include_descendants=true");
  if (request.txtState !== null) parameters.push(`txt_state=${encodeURIComponent(request.txtState)}`);
  const query = validateGalleryQuery(request.query);
  if (query.length > 0) parameters.push(`query=${encodeURIComponent(query)}`);
  if (request.directoryCursor !== null) {
    parameters.push(`directory_cursor=${encodeURIComponent(request.directoryCursor)}`);
  }
  if (request.assetCursor !== null) {
    parameters.push(`asset_cursor=${encodeURIComponent(request.assetCursor)}`);
  }
  // 搜索词与 TXT 筛选作为目录分页的查询参数下发（§7.1 唯一浏览端点）；
  // 搜索范围（当前目录/整个来源）由 controller 解析为目标目录与开关。
  return `${GALLERY_ENDPOINTS.directoryEntries}/${endpointId(request.directoryId)}/entries?${parameters.join("&")}`;
}

export function createGalleryService(api: ApiClient): GalleryService {
  const service: GalleryService = {
    async listSources(signal) {
      const page = sanitizeGallerySourcePage(
        await api.get(`${GALLERY_ENDPOINTS.sources}?view=desktop`, { signal }),
      );
      return page.sources;
    },
    async listDirectoryEntries(request, signal) {
      return sanitizeGalleryDirectoryPage(await api.get(directoryEntriesPath(request), { signal }));
    },
    thumbnailUrl(assetId) {
      // 后端只支持 256/512 两档（SUPPORTED_THUMBNAIL_SIZES）。
      return api.resourceUrl(`/api/v1/gallery/assets/${endpointId(assetId)}/thumbnail?size=512`);
    },
    contentUrl(assetId) {
      return api.resourceUrl(`/api/v1/gallery/assets/${endpointId(assetId)}/content`);
    },
    async getAnnotation(assetId, signal) {
      return sanitizeGalleryAnnotation(
        await api.get(`/api/v1/gallery/assets/${endpointId(assetId)}/annotation?view=desktop`, { signal }),
      );
    },
  };
  return Object.freeze(service);
}
