// 事件驱动的重拉要限频：采样器每秒推一次进度，页面不必每次都重拉详情。
// 首次立即执行，窗口内的后续调用合并成窗口结束时的一次。

type Handle = ReturnType<typeof setTimeout>;

export interface Throttled {
  (): void;
  /** 丢掉待执行的尾调用。 */
  cancel(): void;
}

export function throttle(
  run: () => void,
  ms: number,
  {
    now = Date.now,
    schedule = (callback: () => void, delay: number) => setTimeout(callback, delay),
    cancel = (handle: Handle) => clearTimeout(handle),
  }: {
    now?: () => number;
    schedule?: (callback: () => void, delay: number) => Handle;
    cancel?: (handle: Handle) => void;
  } = {},
): Throttled {
  let last = -Infinity;
  let timer: Handle | null = null;

  const fire = () => {
    timer = null;
    last = now();
    run();
  };

  const throttled = (() => {
    if (timer !== null) return;
    const wait = last + ms - now();
    if (wait <= 0) fire();
    else timer = schedule(fire, wait);
  }) as Throttled;

  throttled.cancel = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  return throttled;
}
