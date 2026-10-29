import { useQueryClient } from "@tanstack/svelte-query";

import { useEvent } from "#lib/events/context.svelte.ts";

import { invalidateTriage, isTriageEvent, type TriageStage } from "./triage.ts";

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
