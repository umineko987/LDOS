import type { ApiClient } from "../../core/api/client";
import {
  sanitizeGalleryAnnotation,
  sanitizeGalleryDirectoryPage,
  sanitizeGalleryFileOperationResult,
  sanitizeGallerySourcePage,
  sanitizeGallerySourceSummary,
  sanitizeGalleryTrashPage,
  validateGalleryQuery,
  type GalleryAnnotation,
  type GalleryDirectoryPage,
  type GalleryFileOperationResult,
  type GallerySourceSummary,
  type GalleryTrashPage,
  type GalleryTxtState,
} from "./model";

export const GALLERY_PAGE_LIMIT = 60;
export const GALLERY_PAGE_LIMITS = [30, 60, 120] as const;

export const GALLERY_ENDPOINTS = Object.freeze({
  sources: "/api/v1/gallery/sources",
  imports: "/api/v1/gallery/imports",
  directoryEntries: "/api/v1/gallery/directories",
  fileOperations: "/api/v1/gallery/file-operations",
  trash: "/api/v1/gallery/trash",
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
  importSource(rootPath: string, displayName?: string | null): Promise<GallerySourceSummary>;
  listDirectoryEntries(
    request: GalleryDirectoryRequest,
    signal: AbortSignal,
  ): Promise<GalleryDirectoryPage>;
  thumbnailUrl(assetId: string): string;
  contentUrl(assetId: string): string;
  getAnnotation(assetId: string, signal: AbortSignal): Promise<GalleryAnnotation>;
  saveAnnotation(
    assetId: string,
    content: string,
    expectedTxtVersion: number,
  ): Promise<GalleryAnnotation>;
  renameAsset(assetId: string, newStem: string): Promise<GalleryFileOperationResult>;
  trashAssets(assetIds: readonly string[]): Promise<GalleryFileOperationResult>;
  undoTrash(operationId: string): Promise<GalleryFileOperationResult>;
  restoreTrash(operationId: string): Promise<GalleryFileOperationResult>;
  purgeTrash(operationId: string): Promise<GalleryFileOperationResult>;
  purgeAllTrash(): Promise<GalleryFileOperationResult>;
  listTrash(
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<GalleryTrashPage>;
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
    async importSource(rootPath, displayName) {
      if (typeof rootPath !== "string" || rootPath.trim().length === 0 || rootPath.length > 4096) {
        throw new TypeError("invalid_import_root_path");
      }
      const body: Record<string, string> = { root_path: rootPath.trim() };
      if (displayName !== undefined && displayName !== null) {
        if (typeof displayName !== "string" || displayName.length > 200) {
          throw new TypeError("invalid_import_display_name");
        }
        if (displayName.length > 0) body.display_name = displayName;
      }
      return sanitizeGallerySourceSummary(
        await api.post(GALLERY_ENDPOINTS.imports, body),
      );
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
    async saveAnnotation(assetId, content, expectedTxtVersion) {
      return sanitizeGalleryAnnotation(
        await api.put(`/api/v1/gallery/assets/${endpointId(assetId)}/annotation`, {
          content,
          expected_txt_version: expectedTxtVersion,
        }),
      );
    },
    async renameAsset(assetId, newStem) {
      return sanitizeGalleryFileOperationResult(
        await api.post(`/api/v1/gallery/assets/${endpointId(assetId)}/rename`, {
          new_stem: newStem,
        }),
      );
    },
    async trashAssets(assetIds) {
      if (assetIds.length === 0 || assetIds.length > 2000) {
        throw new TypeError("gallery_trash_assets: invalid asset id count");
      }
      return sanitizeGalleryFileOperationResult(
        await api.post(`${GALLERY_ENDPOINTS.fileOperations}/trash`, {
          asset_ids: [...assetIds],
        }),
      );
    },
    async undoTrash(operationId) {
      return sanitizeGalleryFileOperationResult(
        await api.post(`${GALLERY_ENDPOINTS.fileOperations}/${endpointId(operationId)}/undo`),
      );
    },
    async restoreTrash(operationId) {
      return sanitizeGalleryFileOperationResult(
        await api.post(`${GALLERY_ENDPOINTS.trash}/${endpointId(operationId)}/restore`),
      );
    },
    async purgeTrash(operationId) {
      return sanitizeGalleryFileOperationResult(
        await api.delete(`${GALLERY_ENDPOINTS.trash}/${endpointId(operationId)}`),
      );
    },
    async purgeAllTrash() {
      return sanitizeGalleryFileOperationResult(
        await api.delete(GALLERY_ENDPOINTS.trash),
      );
    },
    async listTrash(cursor, signal) {
      const parameters = ["view=desktop"];
      if (cursor !== null) parameters.push(`cursor=${encodeURIComponent(cursor)}`);
      return sanitizeGalleryTrashPage(
        await api.get(`${GALLERY_ENDPOINTS.trash}?${parameters.join("&")}`, { signal }),
      );
    },
  };
  return Object.freeze(service);
}
