import type { ApiClient } from "../../core/api/client";
import {
  reviewImagePath,
  mergeReviewPageChunks,
  sanitizeReviewPageChunk,
  sanitizeReviewRecentBatches,
  validateReviewId,
  type ReviewDecisionPayload,
  type ReviewFilter,
  type ReviewRecentBatch,
  type ReviewSnapshot,
} from "./model";

export const REVIEW_ENDPOINTS = Object.freeze({ crawls: "/api/v1/crawls" });
export const REVIEW_PAGE_LIMIT = 50;

export type ReviewStatusOperation = "start" | "retry" | "apply";

export interface ReviewService {
  readRecent(signal: AbortSignal): Promise<readonly ReviewRecentBatch[]>;
  readPage(batchId: string, filter: ReviewFilter, signal: AbortSignal): Promise<ReviewSnapshot>;
  writeDecisions(batchId: string, payload: ReviewDecisionPayload, signal: AbortSignal): Promise<void>;
  run(operation: ReviewStatusOperation, batchId: string, signal: AbortSignal): Promise<void>;
  imageUrl(batchId: string, imageId: string): string;
}

export function reviewPath(batchId: string, suffix = ""): string {
  return `${REVIEW_ENDPOINTS.crawls}/${encodeURIComponent(validateReviewId(batchId))}/review${suffix}`;
}

export function reviewWorkspacePath(batchId: string, filter: ReviewFilter, offset = 0): string {
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new TypeError("invalid_review_offset");
  return `${reviewPath(batchId)}?limit=${REVIEW_PAGE_LIMIT}&offset=${offset}&view=desktop${filter ? `&kind=${encodeURIComponent(filter)}` : ""}`;
}

export function createReviewService(api: ApiClient): ReviewService {
  return Object.freeze({
    async readRecent(signal: AbortSignal) {
      return sanitizeReviewRecentBatches(await api.get(`${REVIEW_ENDPOINTS.crawls}?limit=30&view=desktop`, { signal }));
    },
    async readPage(batchId: string, filter: ReviewFilter, signal: AbortSignal) {
      const chunks: ReturnType<typeof sanitizeReviewPageChunk>[] = [];
      let offset = 0;
      let total = 0;
      do {
        const response = await api.get(reviewWorkspacePath(batchId, filter, offset), { signal });
        const chunk = sanitizeReviewPageChunk(response, { batchId, filter, requestedOffset: offset });
        chunks.push(chunk);
        offset += chunk.snapshot.groupOrder.length;
        total = chunk.total;
      } while (offset < total);
      return mergeReviewPageChunks(chunks);
    },
    async writeDecisions(batchId: string, payload: ReviewDecisionPayload, signal: AbortSignal) {
      await api.put(reviewPath(batchId, "/decisions?view=desktop"), payload, { signal });
    },
    async run(operation: ReviewStatusOperation, batchId: string, signal: AbortSignal) {
      if (operation !== "start" && operation !== "retry" && operation !== "apply") {
        throw new TypeError("invalid_review_operation");
      }
      await api.post(reviewPath(batchId, `/${operation}?view=desktop`), {}, { signal });
    },
    imageUrl(batchId: string, imageId: string) {
      return api.resourceUrl(reviewImagePath(batchId, imageId));
    },
  });
}
