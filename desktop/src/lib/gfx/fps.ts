// 帧率计：按固定窗口统计，读数每个窗口才变一次，避免数字每帧跳动、每帧触发界面更新。

export interface FpsMeter {
  /** 每帧调用（传 requestAnimationFrame 的时间戳）；窗口结束、读数更新时返回新的 fps，否则返回 null。 */
  tick(now: number): number | null;
  /** 换渲染器等情况下丢掉当前窗口重新计。 */
  reset(): void;
  readonly fps: number | null;
  /** 窗口内的平均帧间隔（毫秒）。 */
  readonly frameMs: number | null;
}

export function createFpsMeter(windowMs = 500): FpsMeter {
  let start: number | null = null;
  let frames = 0;
  let fps: number | null = null;
  let frameMs: number | null = null;

  return {
    tick(now) {
      if (start === null) {
        start = now;
        frames = 0;
        return null;
      }
      frames += 1;
      const elapsed = now - start;
      if (elapsed < windowMs) return null;
      fps = (frames * 1000) / elapsed;
      frameMs = elapsed / frames;
      start = now;
      frames = 0;
      return fps;
    },
    reset() {
      start = null;
      frames = 0;
      fps = null;
      frameMs = null;
    },
    get fps() {
      return fps;
    },
    get frameMs() {
      return frameMs;
    },
  };
}
