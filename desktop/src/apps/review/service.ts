import type { ApiClient } from "../../core/api/client";
import {
  reviewImagePath,
  sanitizeReviewPage,
  sanitizeReviewRecentBatches,
  validateReviewId,
  type ReviewDecisionPayload,
  type ReviewFilter,
  type ReviewRecentBatch,
  type ReviewSnapshot,
} from "./model";

export const REVIEW_ENDPOINTS = Object.freeze({ crawls: "/api/v1/crawls" });

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

export function reviewWorkspacePath(batchId: string, filter: ReviewFilter): string {
  return `${reviewPath(batchId)}?all=true${filter ? `&kind=${encodeURIComponent(filter)}` : ""}`;
}

export function createReviewService(api: ApiClient): ReviewService {
  return Object.freeze({
    async readRecent(signal: AbortSignal) {
      return sanitizeReviewRecentBatches(await api.get(`${REVIEW_ENDPOINTS.crawls}?limit=30`, { signal }));
    },
    async readPage(batchId: string, filter: ReviewFilter, signal: AbortSignal) {
      const response = await api.get(reviewWorkspacePath(batchId, filter), { signal });
      return sanitizeReviewPage(response, { batchId, filter, requestedOffset: 0 });
    },
    async writeDecisions(batchId: string, payload: ReviewDecisionPayload, signal: AbortSignal) {
      await api.put(reviewPath(batchId, "/decisions"), payload, { signal });
    },
    async run(operation: ReviewStatusOperation, batchId: string, signal: AbortSignal) {
      if (operation !== "start" && operation !== "retry" && operation !== "apply") {
        throw new TypeError("invalid_review_operation");
      }
      await api.post(reviewPath(batchId, `/${operation}`), {}, { signal });
    },
    imageUrl(batchId: string, imageId: string) {
      return api.resourceUrl(reviewImagePath(batchId, imageId));
    },
  });
}
