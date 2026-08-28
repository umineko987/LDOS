import type { ApiClient } from "../../core/api/client";
import {
  sanitizeGalleryAnnotation,
  sanitizeGalleryDirectoryPage,
  sanitizeGalleryFileOperationResult,
  sanitizeGalleryPurgeAllTrashResult,
  sanitizeGalleryDirectoryExportOperation,
  sanitizeGallerySourceSummary,
  sanitizeGalleryScanOperation,
  sanitizeGallerySourcePage,
  sanitizeGalleryTrashPage,
  sanitizeGallerySearchPage,
  validateGalleryQuery,
  type GalleryAnnotation,
  type GalleryDirectoryPage,
  type GalleryDirectoryExportOperation,
  type GalleryFileOperationResult,
  type GalleryPurgeAllTrashResult,
  type GallerySearchPage,
  type GallerySearchScope,
  type GallerySourceSummary,
  type GalleryScanOperation,
  type GalleryTrashPage,
  type GalleryTxtState,
} from "./model";

export const GALLERY_PAGE_LIMIT = 60;
export const GALLERY_PAGE_LIMITS = [30, 60, 120] as const;

export const GALLERY_ENDPOINTS = Object.freeze({
  sources: "/api/v1/gallery/sources",
  imports: "/api/v1/gallery/imports",
  directoryEntries: "/api/v1/gallery/directories",
  search: "/api/v1/gallery/search",
  directoryExports: "/api/v1/gallery/directory-exports",
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

export interface GallerySearchRequest {
  readonly query: string;
  readonly scope: GallerySearchScope;
  readonly sourceId: string | null;
  readonly directoryId: string | null;
  readonly includeDescendants: boolean;
  readonly txtState: GalleryTxtState | null;
  readonly assetCursor: string | null;
}

export interface GalleryService {
  listSources(signal: AbortSignal): Promise<readonly GallerySourceSummary[]>;
  importSource(rootPath: string, displayName?: string | null): Promise<GallerySourceSummary>;
  renameSource(sourceId: string, displayName: string): Promise<GallerySourceSummary>;
  relinkSource(sourceId: string, rootPath: string): Promise<GallerySourceSummary>;
  unmountSource(sourceId: string): Promise<void>;
  deleteBatchSource(sourceId: string): Promise<void>;
  startSourceScan(sourceId: string): Promise<GalleryScanOperation>;
  getSourceScan(sourceId: string, signal?: AbortSignal): Promise<GalleryScanOperation>;
  retrySourceReconciliation(sourceId: string): Promise<GallerySourceSummary>;
  listDirectoryEntries(
    request: GalleryDirectoryRequest,
    signal: AbortSignal,
  ): Promise<GalleryDirectoryPage>;
  searchAssets(
    request: GallerySearchRequest,
    signal: AbortSignal,
  ): Promise<GallerySearchPage>;
  startDirectoryExport(
    directoryIds: readonly string[],
    targetPath: string,
  ): Promise<GalleryDirectoryExportOperation>;
  getDirectoryExport(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<GalleryDirectoryExportOperation>;
  cancelDirectoryExport(operationId: string): Promise<GalleryDirectoryExportOperation>;
  thumbnailUrl(assetId: string, size: 256 | 512): string;
  contentUrl(assetId: string): string;
  getAnnotation(assetId: string, signal: AbortSignal): Promise<GalleryAnnotation>;
  saveAnnotation(
    assetId: string,
    content: string,
    expectedTxtVersion: number,
    expectedDiskVersion: string,
  ): Promise<GalleryAnnotation>;
  renameAsset(assetId: string, newStem: string): Promise<GalleryFileOperationResult>;
  trashAssets(assetIds: readonly string[], directoryIds?: readonly string[]): Promise<GalleryFileOperationResult>;
  undoTrash(operationId: string): Promise<GalleryFileOperationResult>;
  restoreTrash(operationId: string): Promise<GalleryFileOperationResult>;
  purgeTrash(operationId: string): Promise<GalleryFileOperationResult>;
  purgeAllTrash(): Promise<GalleryPurgeAllTrashResult>;
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

export function searchAssetsPath(request: GallerySearchRequest): string {
  const query = validateGalleryQuery(request.query);
  if (query.length === 0) throw new TypeError("invalid_gallery_search_query");
  if (request.scope === "directory" && request.directoryId === null) {
    throw new TypeError("gallery_search_directory_required");
  }
  if (request.scope === "source" && request.sourceId === null) {
    throw new TypeError("gallery_search_source_required");
  }
  const parameters = [
    "view=desktop",
    `scope=${encodeURIComponent(request.scope)}`,
    `query=${encodeURIComponent(query)}`,
  ];
  if (request.scope === "directory") {
    parameters.push(`directory_id=${endpointId(request.directoryId!)}`);
    if (request.includeDescendants) parameters.push("include_descendants=true");
  } else if (request.scope === "source") {
    parameters.push(`source_id=${endpointId(request.sourceId!)}`);
  }
  if (request.txtState !== null) parameters.push(`txt_state=${encodeURIComponent(request.txtState)}`);
  if (request.assetCursor !== null) parameters.push(`asset_cursor=${encodeURIComponent(request.assetCursor)}`);
  return `${GALLERY_ENDPOINTS.search}?${parameters.join("&")}`;
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
    async renameSource(sourceId, displayName) {
      const normalized = displayName.trim();
      if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
        throw new TypeError("invalid_gallery_source_display_name");
      }
      return sanitizeGallerySourceSummary(
        await api.request(`/api/v1/gallery/sources/${endpointId(sourceId)}`, "PATCH", {
          body: { display_name: normalized },
        }),
      );
    },
    async relinkSource(sourceId, rootPath) {
      if (
        typeof rootPath !== "string" ||
        rootPath.trim().length === 0 ||
        rootPath.length > 4096 ||
        /[\u0000-\u001f]/.test(rootPath)
      ) {
        throw new TypeError("invalid_gallery_relink_root_path");
      }
      return sanitizeGallerySourceSummary(
        await api.post(
          `/api/v1/gallery/sources/${endpointId(sourceId)}/relink`,
          { root_path: rootPath.trim() },
          { idempotencyKey: true },
        ),
      );
    },
    async unmountSource(sourceId) {
      await api.delete(`/api/v1/gallery/sources/${endpointId(sourceId)}`);
    },
    async deleteBatchSource(sourceId) {
      await api.delete(`/api/v1/gallery/sources/${endpointId(sourceId)}?delete_files=true`, {
        idempotencyKey: true,
      });
    },
    async startSourceScan(sourceId) {
      return sanitizeGalleryScanOperation(
        await api.post(`/api/v1/gallery/sources/${endpointId(sourceId)}/scan`),
      );
    },
    async getSourceScan(sourceId, signal) {
      return sanitizeGalleryScanOperation(
        await api.get(
          `/api/v1/gallery/sources/${endpointId(sourceId)}/scan?view=desktop`,
          signal === undefined ? undefined : { signal },
        ),
      );
    },
    async retrySourceReconciliation(sourceId) {
      return sanitizeGallerySourceSummary(
        await api.post(
          `/api/v1/gallery/sources/${endpointId(sourceId)}/reconciliation/retry`,
          undefined,
          { idempotencyKey: true },
        ),
      );
    },
    async listDirectoryEntries(request, signal) {
      return sanitizeGalleryDirectoryPage(await api.get(directoryEntriesPath(request), { signal }));
    },
    async searchAssets(request, signal) {
      return sanitizeGallerySearchPage(await api.get(searchAssetsPath(request), { signal }));
    },
    async startDirectoryExport(directoryIds, targetPath) {
      if (
        !Array.isArray(directoryIds) ||
        directoryIds.length === 0 ||
        directoryIds.length > 500 ||
        new Set(directoryIds).size !== directoryIds.length
      ) {
        throw new TypeError("invalid_gallery_directory_export_selection");
      }
      for (const directoryId of directoryIds) endpointId(directoryId);
      if (
        typeof targetPath !== "string" ||
        targetPath.trim().length === 0 ||
        targetPath.length > 4096 ||
        /[\u0000-\u001f]/.test(targetPath)
      ) {
        throw new TypeError("invalid_gallery_directory_export_target");
      }
      return sanitizeGalleryDirectoryExportOperation(
        await api.post(
          GALLERY_ENDPOINTS.directoryExports,
          { directory_ids: [...directoryIds], target_path: targetPath },
          { idempotencyKey: true },
        ),
      );
    },
    async getDirectoryExport(operationId, signal) {
      return sanitizeGalleryDirectoryExportOperation(
        await api.get(
          `${GALLERY_ENDPOINTS.directoryExports}/${endpointId(operationId)}?view=desktop`,
          signal === undefined ? undefined : { signal },
        ),
      );
    },
    async cancelDirectoryExport(operationId) {
      return sanitizeGalleryDirectoryExportOperation(
        await api.delete(
          `${GALLERY_ENDPOINTS.directoryExports}/${endpointId(operationId)}`,
          { idempotencyKey: true },
        ),
      );
    },
    thumbnailUrl(assetId, size) {
      if (size !== 256 && size !== 512) throw new TypeError("invalid_gallery_thumbnail_size");
      return api.resourceUrl(
        `/api/v1/gallery/assets/${endpointId(assetId)}/thumbnail?size=${size}`,
      );
    },
    contentUrl(assetId) {
      return api.resourceUrl(`/api/v1/gallery/assets/${endpointId(assetId)}/content`);
    },
    async getAnnotation(assetId, signal) {
      return sanitizeGalleryAnnotation(
        await api.get(`/api/v1/gallery/assets/${endpointId(assetId)}/annotation?view=desktop`, { signal }),
      );
    },
    async saveAnnotation(assetId, content, expectedTxtVersion, expectedDiskVersion) {
      return sanitizeGalleryAnnotation(
        await api.put(`/api/v1/gallery/assets/${endpointId(assetId)}/annotation`, {
          content,
          expected_txt_version: expectedTxtVersion,
          expected_disk_version: expectedDiskVersion,
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
    async trashAssets(assetIds, directoryIds = []) {
      if (
        !Array.isArray(assetIds) ||
        !Array.isArray(directoryIds) ||
        assetIds.length + directoryIds.length === 0 ||
        assetIds.length > 2000 ||
        directoryIds.length > 200 ||
        assetIds.length + directoryIds.length > 2000 ||
        new Set(assetIds).size !== assetIds.length ||
        new Set(directoryIds).size !== directoryIds.length
      ) {
        throw new TypeError("gallery_trash_selection: invalid item count");
      }
      for (const assetId of assetIds) endpointId(assetId);
      for (const directoryId of directoryIds) endpointId(directoryId);
      return sanitizeGalleryFileOperationResult(
        await api.post(`${GALLERY_ENDPOINTS.fileOperations}/trash`, {
          asset_ids: [...assetIds],
          directory_ids: [...directoryIds],
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
      return sanitizeGalleryPurgeAllTrashResult(
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
