import { describe, expect, it } from "vitest";

import { createFpsMeter } from "./fps.ts";

describe("createFpsMeter", () => {
  it("每个窗口结束时给出一次读数", () => {
    const meter = createFpsMeter(500);
    expect(meter.fps).toBeNull();
    expect(meter.tick(0)).toBeNull();
    let reading: number | null = null;
    for (let frame = 1; frame <= 25; frame += 1) {
      reading = meter.tick(frame * 20);
      if (frame < 25) expect(reading).toBeNull();
    }
    expect(reading).toBe(50);
    expect(meter.fps).toBe(50);
    expect(meter.frameMs).toBe(20);

    // 下一个窗口从上次读数的时间点开始。
    for (let frame = 1; frame <= 13; frame += 1) reading = meter.tick(500 + frame * 40);
    expect(reading).toBe(25);
  });

  it("reset 之后重新开始计", () => {
    const meter = createFpsMeter(100);
    meter.tick(0);
    meter.tick(120);
    expect(meter.fps).not.toBeNull();
    meter.reset();
    expect(meter.fps).toBeNull();
    expect(meter.frameMs).toBeNull();
    expect(meter.tick(1000)).toBeNull();
    expect(meter.tick(1050)).toBeNull();
    expect(meter.tick(1100)).toBeCloseTo(20, 5);
  });
});
