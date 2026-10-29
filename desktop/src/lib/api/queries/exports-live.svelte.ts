import { useQueryClient } from "@tanstack/svelte-query";

import { useEvent } from "#lib/events/context.svelte.ts";

import { invalidateExports } from "./exports.ts";

/**
 * 订阅 dataset.export.updated：这个数据集的某次导出状态变了（排队、开始、完成、失败、取消、中断）时刷新导出历史。
 * 逐文件进度走 job.updated（看 useJobs()），这里不管。只能在组件初始化时调用。
 */
export function useExportEvents(id: () => string): void {
  const client = useQueryClient();
  useEvent("dataset.export.updated", (event) => {
    if (event.dataset_id === id()) void invalidateExports(client, id());
  });
}
