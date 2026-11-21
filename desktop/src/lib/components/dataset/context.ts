import { createContext } from "svelte";

import type { DatasetDetail, DatasetKind, DatasetStage, FunnelStage } from "#lib/api/queries/datasets.ts";
import type { RailStage } from "#lib/domain/funnel.ts";

/**
 * 数据集外框（routes/datasets/[id]/+layout.svelte）给阶段页的上下文。属性都是响应式的 getter，
 * 在模板或 $derived 里读即可：
 *
 *   const dataset = useDataset();
 *   const input = $derived(dataset.stage("dedup")?.input ?? 0);
 *
 * 详情查询（含漏斗）由外框持有并订阅 dataset.updated / dataset.stage.updated，阶段页不用再订阅。
 * 写操作返回新漏斗时调 `applyFunnel(queryClient, funnel)`，轨道计数立即更新。
 */
export interface DatasetContext {
  /** 路由参数里的数据集 ID。 */
  readonly id: string;
  /** 详情；首次加载中或失败时是 undefined。 */
  readonly detail: DatasetDetail | undefined;
  readonly loading: boolean;
  /** 加载失败的错误（ApiError），没有错误时为 null。 */
  readonly error: unknown;
  readonly name: string;
  readonly kind: DatasetKind | undefined;
  /** 触发词（空字符串表示没设）。 */
  readonly triggerWord: string;
  /** 后端原样的漏斗。 */
  readonly funnel: readonly FunnelStage[];
  /** 轨道用的五段：计数（output = 下一段的输入）、去掉的张数、状态。 */
  readonly stages: readonly RailStage[];
  /** 某一段的轨道数据；`stage(name).input` 就是这段要处理的张数。 */
  stage(name: DatasetStage): RailStage | undefined;
}

export const [useDataset, setDataset] = createContext<DatasetContext>();

/** 新建 / 编辑数据集对话框的字段。 */
export interface DatasetFormValues {
  readonly name: string;
  readonly kind: DatasetKind;
  readonly triggerWord: string;
}
