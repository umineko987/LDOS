// caption 批次写入后的反馈：带「撤销」的 toast，以及撤销本身。打标页和标签工作室共用。
//
// 写入和撤销在后端各是一个任务（captions:{batch_id}、captions:undo:{batch_id}），外壳会在任务结束时
// 弹通用提示；这里给了带撤销的 toast，所以把对应任务静音，已经弹出的通用提示也收掉。

import { useQueryClient } from "@tanstack/svelte-query";
import { toast } from "svelte-sonner";

import { useApi } from "#lib/api/context.ts";
import { apiErrorMessage } from "#lib/api/messages.ts";
import { invalidateCaptions, undoCaptionBatch, type CaptionBatchResult } from "#lib/api/queries/captions.ts";
import { useJobs } from "#lib/events/jobs.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

export interface CaptionFeedback {
  /** 写入完成：toast 显示 `message`，有批次时带撤销。 */
  written(result: CaptionBatchResult, message: string): Promise<void>;
  /** 撤销一个批次；成功返回 true。 */
  undo(batchId: string, options?: { lockHeld?: boolean }): Promise<boolean>;
}

export function useCaptionFeedback(
  id: () => string,
  options: {
    refresh?: () => Promise<unknown>;
    runUndo?: (task: () => Promise<boolean>) => Promise<boolean | undefined>;
  } = {},
): CaptionFeedback {
  const api = useApi();
  const client = useQueryClient();
  const jobs = useJobs();

  function quiet(jobId: string) {
    jobs.silence(jobId);
    toast.dismiss(`job:${jobId}`);
  }

  const pendingUndo = new Set<string>();
  const refresh = (ownerId: string) => options.refresh?.() ?? invalidateCaptions(client, ownerId);

  async function undo(batchId: string, { lockHeld = false } = {}): Promise<boolean> {
    if (pendingUndo.has(batchId)) return false;
    if (!lockHeld && options.runUndo) return (await options.runUndo(() => undoBatch(batchId, true))) ?? false;
    return undoBatch(batchId, !lockHeld);
  }

  async function undoBatch(batchId: string, offerRetry: boolean): Promise<boolean> {
    const ownerId = id();
    pendingUndo.add(batchId);
    try {
      const result = await undoCaptionBatch(api, batchId);
      quiet(`captions:undo:${batchId}`);
      const { restored, conflicts, failed } = result.stats;
      // 有图暂时没恢复（来源离线等）：批次还能撤销，重试只做剩下的。
      if (!result.undone) {
        toast.warning(m.captions_undo_incomplete({ restored, failed }), offerRetry ? {
          action: { label: m.common_retry(), onClick: () => void undo(batchId) },
        } : undefined);
      } else if (conflicts) toast.warning(m.captions_undo_partial({ restored, skipped: conflicts }));
      else toast(m.captions_undone({ count: restored }));
      return result.undone;
    } catch (error) {
      toast.error(m.captions_undo_failed({ reason: apiErrorMessage(error) }));
      return false;
    } finally {
      try {
        await refresh(ownerId);
      } finally {
        pendingUndo.delete(batchId);
      }
    }
  }

  async function written(result: CaptionBatchResult, message: string) {
    const batchId = result.batch_id;
    const refreshing = refresh(id());
    if (batchId) {
      quiet(`captions:${batchId}`);
      toast(message, {
        description: result.stats.conflicts ? m.captions_conflicts({ count: result.stats.conflicts }) : undefined,
        action: { label: m.captions_undo(), onClick: () => void undo(batchId) },
      });
    } else toast(message);
    await refreshing;
  }

  return { written, undo };
}
