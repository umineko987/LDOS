import { useQueryClient } from "@tanstack/svelte-query";
import { untrack } from "svelte";

import { useEvent } from "#lib/events/context.svelte.ts";

import { invalidateTriage, isTriageEvent, refreshAfterTriage, type TriagePhase, type TriageStage } from "./triage.ts";

/**
 * 订阅 dataset.stage.updated：这个数据集这一段的运行状态变了（建审核、分析完、自动落地、失败）时刷新分诊查询。
 * 数据集外框已经刷新详情和漏斗，这里只管分诊自己的键。只能在组件初始化时调用。
 */
export function useTriageEvents(id: () => string, stage: TriageStage): void {
  const client = useQueryClient();
  useEvent("dataset.stage.updated", (event) => {
    if (isTriageEvent(event, id(), stage)) void invalidateTriage(client, id(), stage);
  });
}

/**
 * 运行结束（分析中 → 别的状态）时刷新整个数据集：自动落地改了漏斗。
 * 推送正常时外框已经刷新过；推送断开、靠摘要轮询发现结束时靠这里补上。只能在组件初始化时调用。
 */
export function useTriageSettled(id: () => string, phase: () => TriagePhase): void {
  const client = useQueryClient();
  let previous: TriagePhase | null = null;
  $effect(() => {
    const next = phase();
    if (previous === "running" && next !== "running") void untrack(() => refreshAfterTriage(client, id(), null));
    previous = next;
  });
}
