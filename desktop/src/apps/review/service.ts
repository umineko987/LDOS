import type { ApiClient } from "../../core/api/client";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
import {
  reviewImagePath,
  mergeReviewPageChunks,
  sanitizeReviewPageChunk,
  sanitizeModelSetup,
  sanitizeReviewOperation,
  validateReviewId,
  type ModelSetupSnapshot,
  type ReviewFilter,
  type ReviewOperationResult,
  type ReviewSnapshot,
} from "./model";

export const REVIEW_ENDPOINTS = Object.freeze({
  reviews: "/api/v1/gallery/reviews",
  models: "/api/v1/setup/models",
});
export const REVIEW_PAGE_LIMIT = 50;

export function normalizeModelProxyUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate) return "";
  if (candidate.length > 300 || /[\u0000-\u0020\u007f]/u.test(candidate)) {
    throw new TypeError("invalid_model_proxy_format");
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError("invalid_model_proxy_format");
  }
  const authority = candidate.slice(candidate.indexOf("://") + 3).split(/[/?#]/u, 1)[0] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const hasExplicitPort = hostPort.startsWith("[")
    ? /^\[[^\]]+\]:\d+$/u.test(hostPort)
    : /^[^:]+:\d+$/u.test(hostPort);
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || !parsed.hostname
    || !hasExplicitPort
    || !["", "/"].includes(parsed.pathname)
    || parsed.search
    || parsed.hash
  ) {
    throw new TypeError("invalid_model_proxy_format");
  }
  return candidate;
}
export type ReviewStatusOperation = "retry";

export interface ReviewService {
  readModelSetup(signal: AbortSignal): Promise<ModelSetupSnapshot>;
  installModels(proxyUrl: string, signal: AbortSignal): Promise<ModelSetupSnapshot>;
  readPage(reviewId: string, filter: ReviewFilter, signal: AbortSignal): Promise<ReviewSnapshot>;
  adoptGroup(reviewId: string, groupId: string, selectedImageIds: readonly string[], version: number, signal: AbortSignal): Promise<ReviewOperationResult>;
  finishReview(reviewId: string, signal: AbortSignal): Promise<void>;
  run(operation: ReviewStatusOperation, reviewId: string, version: number, signal: AbortSignal): Promise<ReviewOperationResult>;
  imageUrl(reviewId: string, imageId: string): string;
}

export function reviewPath(reviewId: string, suffix = ""): string {
  return `${REVIEW_ENDPOINTS.reviews}/${encodeURIComponent(validateReviewId(reviewId))}${suffix}`;
}

export function reviewWorkspacePath(reviewId: string, filter: ReviewFilter, offset = 0): string {
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new TypeError("invalid_review_offset");
  return `${reviewPath(reviewId)}?limit=${REVIEW_PAGE_LIMIT}&offset=${offset}&view=desktop${filter ? `&kind=${encodeURIComponent(filter)}` : ""}`;
}

export function createReviewService(api: ApiClient): ReviewService {
  return Object.freeze({
    async readModelSetup(signal: AbortSignal) {
      return sanitizeModelSetup(await api.get(REVIEW_ENDPOINTS.models, { signal }));
    },
    async installModels(proxyUrl: string, signal: AbortSignal) {
      const normalizedProxy = normalizeModelProxyUrl(proxyUrl);
      return sanitizeModelSetup(await api.post(`${REVIEW_ENDPOINTS.models}/install`, { proxy_url: normalizedProxy }, { signal }));
    },
    async readPage(reviewId: string, filter: ReviewFilter, signal: AbortSignal) {
      const chunks: ReturnType<typeof sanitizeReviewPageChunk>[] = [];
      let offset = 0;
      let total = 0;
      do {
        const response = await api.get(reviewWorkspacePath(reviewId, filter, offset), { signal });
        const chunk = sanitizeReviewPageChunk(response, { reviewId, filter, requestedOffset: offset });
        if (chunks.length && (chunk.snapshot.reviewId !== chunks[0].snapshot.reviewId || chunk.snapshot.version !== chunks[0].snapshot.version)) throw Object.assign(new Error("review_page_changed"), { code: "review_page_changed", status: 409 });
        chunks.push(chunk);
        offset += chunk.snapshot.groupOrder.length;
        total = chunk.total;
      } while (offset < total);
      return mergeReviewPageChunks(chunks);
    },
    async adoptGroup(reviewId: string, groupId: string, selectedImageIds: readonly string[], version: number, signal: AbortSignal) {
      if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("invalid_review_version");
      if (!selectedImageIds.every((id) => typeof id === "string" && SAFE_ID.test(id))) throw new TypeError("invalid_review_selection");
      const payload = { version, selected_image_ids: [...new Set(selectedImageIds)] };
      return sanitizeReviewOperation(
        await api.post(reviewPath(reviewId, `/groups/${encodeURIComponent(groupId)}/adopt`), payload, { signal }),
        reviewId,
      );
    },
    async finishReview(reviewId: string, signal: AbortSignal) {
      await api.post(reviewPath(reviewId, "/finish"), {}, { signal });
    },
    async run(operation: ReviewStatusOperation, reviewId: string, version: number, signal: AbortSignal) {
      if (operation !== "retry") throw new TypeError("invalid_review_operation");
      if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("invalid_review_version");
      return sanitizeReviewOperation(await api.post(reviewPath(reviewId, `/${operation}`), {}, { signal }), reviewId);
    },
    imageUrl(reviewId: string, imageId: string) {
      return api.resourceUrl(reviewImagePath(reviewId, imageId));
    },
  });
}
