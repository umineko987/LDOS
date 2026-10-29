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
  written(result: CaptionBatchResult, message: string): void;
  /** 撤销一个批次；成功返回 true。 */
  undo(batchId: string): Promise<boolean>;
}

export function useCaptionFeedback(id: () => string): CaptionFeedback {
  const api = useApi();
  const client = useQueryClient();
  const jobs = useJobs();

  function quiet(jobId: string) {
    jobs.silence(jobId);
    toast.dismiss(`job:${jobId}`);
  }

  async function undo(batchId: string): Promise<boolean> {
    const datasetId = id();
    try {
      const result = await undoCaptionBatch(api, batchId);
      quiet(`captions:undo:${batchId}`);
      const { restored, conflicts, failed } = result.stats;
      if (conflicts || failed) toast.warning(m.captions_undo_partial({ restored, skipped: conflicts + failed }));
      else toast(m.captions_undone({ count: restored }));
      return true;
    } catch (error) {
      toast.error(m.captions_undo_failed({ reason: apiErrorMessage(error) }));
      return false;
    } finally {
      void invalidateCaptions(client, datasetId);
    }
  }

  function written(result: CaptionBatchResult, message: string) {
    const batchId = result.batch_id;
    void invalidateCaptions(client, id());
    if (!batchId) {
      toast(message);
      return;
    }
    quiet(`captions:${batchId}`);
    toast(message, {
      description: result.stats.conflicts ? m.captions_conflicts({ count: result.stats.conflicts }) : undefined,
      action: { label: m.captions_undo(), onClick: () => void undo(batchId) },
    });
  }

  return { written, undo };
}
