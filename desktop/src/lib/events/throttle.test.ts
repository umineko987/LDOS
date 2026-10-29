import { afterEach, describe, expect, it, vi } from "vitest";

import { throttle } from "./throttle.ts";

describe("throttle", () => {
  afterEach(() => vi.useRealTimers());

  it("首次立即执行，窗口内的调用合并成一次尾调用", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const throttled = throttle(run, 1_000);
    throttled();
    expect(run).toHaveBeenCalledTimes(1);
    throttled();
    throttled();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    throttled();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("cancel 丢掉尾调用", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const throttled = throttle(run, 1_000);
    throttled();
    throttled();
    throttled.cancel();
    throttled.cancel();
    vi.advanceTimersByTime(2_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
