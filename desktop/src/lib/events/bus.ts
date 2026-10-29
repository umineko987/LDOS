// 领域事件的进程内分发。SSE 连接（events/sse.ts）把校验过的服务端事件交给 dispatch，
// 页面和查询用 subscribe / useEvent 订阅，收到后让对应的 TanStack 查询失效。
// 载荷照抄后端各处 publish 的字段；后端新增事件时在 DomainEvents 里加一行。

import type { components } from "#lib/api/schema.d.ts";

export type Job = components["schemas"]["JobResponse"];

export interface DomainEvents {
  "job.updated": { readonly job: Job };
  "dataset.updated": { readonly dataset_id: string; readonly reason?: string };
  /** 清洗 / 去重运行（带 run_id、review_id）和导出（带 export_id）都会发。 */
  "dataset.stage.updated": {
    readonly dataset_id: string;
    readonly stage: string;
    readonly status: string;
    readonly run_id?: string;
    readonly review_id?: string;
    readonly export_id?: string;
  };
  "dataset.export.updated": { readonly dataset_id: string; readonly export_id: string; readonly status: string };
  "captions.updated": {
    readonly dataset_id: string;
    readonly batch_id: string;
    readonly changed: number;
    readonly reason: string;
  };
  "atlas.updated": { readonly dataset_id: string; readonly status: string; readonly run_id: string };
  /** 补发出现断档：订阅方丢掉本地推导的状态，重拉自己关心的查询（任务列表要重拉 /jobs）。 */
  resync: { readonly last_event_id: string; readonly reason: string };
}

export type DomainEventKind = keyof DomainEvents;

export type EventHandler<K extends DomainEventKind> = (data: DomainEvents[K]) => void;

export interface EventBus {
  /** 返回取消订阅的函数。同一个处理器重复订阅只算一次。 */
  subscribe<K extends DomainEventKind>(kind: K, handler: EventHandler<K>): () => void;
  /** 依次调用订阅者；某个订阅者抛错不影响其余订阅者。 */
  dispatch<K extends DomainEventKind>(kind: K, data: DomainEvents[K]): void;
}

export function createEventBus(onError: (error: unknown) => void = reportError): EventBus {
  const handlers = new Map<DomainEventKind, Set<(data: never) => void>>();
  return {
    subscribe(kind, handler) {
      let set = handlers.get(kind);
      if (!set) handlers.set(kind, (set = new Set()));
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    dispatch(kind, data) {
      // 先拷贝：处理器里取消订阅或新增订阅不影响这一轮。
      for (const handler of [...(handlers.get(kind) ?? [])]) {
        try {
          (handler as EventHandler<typeof kind>)(data);
        } catch (error) {
          onError(error);
        }
      }
    },
  };
}

function reportError(error: unknown): void {
  console.error(error);
}
