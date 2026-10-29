// 任务结束提示的限流：一个窗口内最多弹 `burst` 条，多出来的在窗口结束时并成一条汇总。
// 批量任务（几十个 caption 写入、连续扫描）不会刷屏，单个任务仍然立刻有反馈。

import type { Job } from "#lib/api/queries/jobs.ts";

type Handle = ReturnType<typeof setTimeout>;

export interface JobNotifierOptions {
  /** 单条提示。 */
  show(job: Job): void;
  /** 汇总提示：`count` 条结束，其中 `failed` 条失败。 */
  summarize(count: number, failed: number): void;
  /** 返回 false 的任务不提示。 */
  filter?: (job: Job) => boolean;
  windowMs?: number;
  burst?: number;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => Handle;
  cancel?: (handle: Handle) => void;
}

export interface JobNotifier {
  notify(job: Job): void;
  /** 丢掉待汇总的提示并停掉计时器（外壳卸载时调用）。 */
  dispose(): void;
}

export function createJobNotifier({
  show,
  summarize,
  filter = () => true,
  windowMs = 5_000,
  burst = 3,
  now = Date.now,
  schedule = (run, ms) => setTimeout(run, ms),
  cancel = (handle) => clearTimeout(handle),
}: JobNotifierOptions): JobNotifier {
  let shown: number[] = [];
  let pending: Job[] = [];
  let timer: Handle | null = null;

  function flush() {
    timer = null;
    const batch = pending;
    pending = [];
    shown = [now()];
    if (batch.length === 1) show(batch[0]!);
    else if (batch.length > 1) summarize(batch.length, batch.filter((job) => job.status === "failed").length);
  }

  return {
    notify(job) {
      if (!filter(job)) return;
      const at = now();
      shown = shown.filter((time) => at - time < windowMs);
      if (!pending.length && shown.length < Math.max(1, burst)) {
        shown.push(at);
        show(job);
        return;
      }
      pending.push(job);
      timer ??= schedule(flush, Math.max(0, shown[0]! + windowMs - at));
    },
    dispose() {
      if (timer !== null) cancel(timer);
      timer = null;
      pending = [];
    },
  };
}
