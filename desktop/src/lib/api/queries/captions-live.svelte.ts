import { useQueryClient } from "@tanstack/svelte-query";

import { useEvent } from "#lib/events/context.svelte.ts";

import { captionKeys } from "./captions.ts";
import { taggerKeys } from "./tagger.ts";

/**
 * 订阅 caption 相关事件，让 caption 列表、批次历史和打标候选失效（都带 ETag，没变时只是一次 304）：
 * - captions.updated：这个数据集的 caption 被写过；
 * - dataset.updated：成员或决定变了，tag 阶段的输入可能跟着变；
 * - resync：事件有断档，全部重拉。
 * 打标页调用；只能在组件初始化时调用。
 */
export function useCaptionEvents(id: () => string): void {
  const client = useQueryClient();
  useEvent("captions.updated", (event) => {
    if (event.dataset_id === id()) void client.invalidateQueries({ queryKey: captionKeys.dataset(event.dataset_id) });
  });
  useEvent("dataset.updated", (event) => {
    if (event.dataset_id !== id()) return;
    void client.invalidateQueries({ queryKey: captionKeys.list(event.dataset_id) });
    void client.invalidateQueries({ queryKey: taggerKeys.candidatesAll(event.dataset_id) });
  });
  useEvent("resync", () => {
    void client.invalidateQueries({ queryKey: captionKeys.all });
    void client.invalidateQueries({ queryKey: [...taggerKeys.all, "candidates"] });
  });
}
