import { useQueryClient } from "@tanstack/svelte-query";

import { useEvent } from "#lib/events/context.svelte.ts";

import { invalidateForDatasetEvent } from "./datasets.ts";

/**
 * 订阅数据集事件，让对应查询失效。给了 `id` 时只处理这个数据集的事件（resync 总是处理）。
 * 数据集外框（datasets/[id]/+layout）和首页各调一次；阶段页不用再调。只能在组件初始化时调用。
 */
export function useDatasetEvents(id?: () => string | undefined): void {
  const client = useQueryClient();
  const relevant = (datasetId: string) => id === undefined || id() === datasetId;
  useEvent("dataset.updated", (event) => {
    if (relevant(event.dataset_id)) invalidateForDatasetEvent(client, "dataset.updated", event);
  });
  useEvent("dataset.stage.updated", (event) => {
    if (relevant(event.dataset_id)) invalidateForDatasetEvent(client, "dataset.stage.updated", event);
  });
  useEvent("resync", (event) => invalidateForDatasetEvent(client, "resync", event));
}
