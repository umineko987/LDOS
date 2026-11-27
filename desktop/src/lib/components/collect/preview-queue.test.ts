import { afterEach, expect, it, vi } from "vitest";

import { PreviewQueue } from "./preview-queue.ts";

afterEach(() => vi.unstubAllGlobals());

it("admits visible cards first, bounds lookahead, and drains in-flight work when capacity shrinks", async () => {
  let visibility!: (entries: { target: EventTarget; isIntersecting: boolean }[]) => void;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: typeof visibility) { visibility = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const starts: number[] = [];
  const images = Array.from({ length: 12 }, (_, index) => new class extends EventTarget {
    set src(_: string) { starts.push(index); }
    removeAttribute() {}
  }());
  const queue = new PreviewQueue();
  const cleanups = images.map((img, i) => queue.image(`/image/${i}`, i)(img as unknown as HTMLImageElement));
  visibility([1, 2, 3].map(i => ({ target: images[i], isIntersecting: true })));
  queue.setLimit(2);
  await Promise.resolve();
  expect(starts).toEqual([1, 2]);
  queue.setLimit(1);
  images[1].dispatchEvent(new Event("load"));
  await Promise.resolve();
  expect(starts).toEqual([1, 2]);
  images[2].dispatchEvent(new Event("error"));
  await Promise.resolve();
  expect(starts).toEqual([1, 2, 3]);
  for (const i of [3, 4]) {
    images[i].dispatchEvent(new Event("load"));
    await Promise.resolve();
  }
  expect(starts).toEqual([1, 2, 3, 4]); // only one card beyond the viewport
  visibility([{ target: images[9], isIntersecting: true }]);
  await Promise.resolve();
  expect(starts.at(-1)).toBe(9);
  cleanups.forEach(cleanup => cleanup());
  await Promise.resolve();
  expect(starts).toHaveLength(5);
});
