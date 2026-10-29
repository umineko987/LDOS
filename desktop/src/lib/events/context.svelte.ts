import { createContext } from "svelte";

import type { DomainEventKind, EventBus, EventHandler } from "./bus.ts";

/** 外壳在 setApi 旁边 `setEvents(createEventBus())`；SSE 连接和页面共用这一个总线。 */
export const [useEvents, setEvents] = createContext<EventBus>();

/** 随组件挂载订阅、卸载取消。只能在组件初始化时调用；处理器里读的状态不会被追踪。 */
export function useEvent<K extends DomainEventKind>(kind: K, handler: EventHandler<K>): void {
  const bus = useEvents();
  $effect(() => bus.subscribe(kind, (data) => handler(data)));
}
