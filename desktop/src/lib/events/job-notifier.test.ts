import { afterEach, describe, expect, it, vi } from "vitest";

import { sanitizeJob, type Job } from "#lib/api/queries/jobs.ts";

import { createJobNotifier } from "./job-notifier.ts";

function job(id: string, status: Job["status"] = "succeeded"): Job {
  return sanitizeJob({ id, kind: "crawl.batch", title: id, status, message: "", ref: {}, started_at: 1, updated_at: 2 });
}

function setup(filter?: (job: Job) => boolean) {
  const clock = { now: 0 };
  const timers: { run: () => void; ms: number }[] = [];
  const shown: string[] = [];
  const summaries: [number, number][] = [];
  const cancel = vi.fn();
  const notifier = createJobNotifier({
    show: (item) => shown.push(item.id),
    summarize: (count, failed) => summaries.push([count, failed]),
    filter,
    windowMs: 5_000,
    burst: 3,
    now: () => clock.now,
    schedule: (run, ms) => {
      timers.push({ run, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel,
  });
  return { clock, timers, shown, summaries, notifier, cancel };
}

describe("createJobNotifier", () => {
  afterEach(() => vi.useRealTimers());

  it("窗口内前几条立即提示，其余在窗口结束时汇总", () => {
    const { clock, timers, shown, summaries, notifier } = setup();
    notifier.notify(job("a"));
    clock.now = 1_000;
    notifier.notify(job("b"));
    notifier.notify(job("c"));
    notifier.notify(job("d", "failed"));
    notifier.notify(job("e"));
    expect(shown).toEqual(["a", "b", "c"]);
    expect(timers.map((timer) => timer.ms)).toEqual([4_000]);

    clock.now = 5_000;
    timers[0]!.run();
    expect(summaries).toEqual([[2, 1]]);

    // 汇总之后重新计窗口：紧接着的一条仍然可以单独提示。
    notifier.notify(job("f"));
    expect(shown).toEqual(["a", "b", "c", "f"]);
  });

  it("只积压了一条时，窗口结束时单独提示它", () => {
    const { timers, shown, summaries, notifier } = setup();
    for (const id of ["a", "b", "c", "d"]) notifier.notify(job(id));
    timers[0]!.run();
    expect(shown).toEqual(["a", "b", "c", "d"]);
    expect(summaries).toEqual([]);
  });

  it("窗口过去后计数清零", () => {
    const { clock, shown, timers, notifier } = setup();
    for (const id of ["a", "b", "c"]) notifier.notify(job(id));
    clock.now = 6_000;
    notifier.notify(job("d"));
    expect(shown).toEqual(["a", "b", "c", "d"]);
    expect(timers).toHaveLength(0);
  });

  it("filter 返回 false 的任务不提示", () => {
    const { shown, notifier } = setup((item) => item.status !== "cancelled");
    notifier.notify(job("a", "cancelled"));
    notifier.notify(job("b"));
    expect(shown).toEqual(["b"]);
  });

  it("dispose 取消待汇总的提示", () => {
    const { timers, summaries, notifier, cancel } = setup();
    for (const id of ["a", "b", "c", "d", "e"]) notifier.notify(job(id));
    notifier.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    notifier.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    expect(timers).toHaveLength(1);
    expect(summaries).toEqual([]);
  });

  it("默认参数使用真实时钟和计时器", () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const summaries: number[] = [];
    const notifier = createJobNotifier({ show: (item) => shown.push(item.id), summarize: (count) => summaries.push(count) });
    for (const id of ["a", "b", "c", "d", "e"]) notifier.notify(job(id));
    vi.advanceTimersByTime(5_000);
    expect(shown).toEqual(["a", "b", "c"]);
    expect(summaries).toEqual([2]);
    for (const id of ["f", "g", "h", "i"]) notifier.notify(job(id));
    notifier.dispose();
  });
});
