import { describe, expect, it } from "vitest";

import { createThumbnailPrefetchQueue, type PrefetchImage } from "./thumbnailPrefetch";

interface Harness {
  images: PrefetchImage[];
  settle(index: number): void;
  createImage: () => PrefetchImage;
}

function harness(): Harness {
  const images: PrefetchImage[] = [];
  return {
    images,
    settle(index: number) {
      images[index].onload?.();
    },
    createImage: () => {
      const image: PrefetchImage = { src: "", onload: null, onerror: null };
      images.push(image);
      return image;
    },
  };
}

describe("thumbnail prefetch queue", () => {
  it("prefetches immediately up to the concurrency limit", () => {
    const h = harness();
    const queue = createThumbnailPrefetchQueue({ concurrency: 2, createImage: h.createImage });
    queue.enqueue(["a", "b", "c"]);
    expect(h.images.map((image) => image.src)).toEqual(["a", "b"]);
    expect(queue.backlogCount()).toBe(1);
    expect(queue.inFlightCount()).toBe(2);
  });

  it("pumps the backlog as loads settle", () => {
    const h = harness();
    const queue = createThumbnailPrefetchQueue({ concurrency: 2, createImage: h.createImage });
    queue.enqueue(["a", "b", "c"]);
    h.settle(0);
    expect(h.images.map((image) => image.src)).toEqual(["a", "b", "c"]);
    h.settle(1);
    h.settle(2);
    expect(queue.inFlightCount()).toBe(0);
    expect(queue.backlogCount()).toBe(0);
  });

  it("never retries a URL after success or failure", () => {
    const h = harness();
    const queue = createThumbnailPrefetchQueue({ concurrency: 1, createImage: h.createImage });
    queue.enqueue(["a"]);
    h.images[0].onerror?.();
    queue.enqueue(["a", "b"]);
    expect(h.images.map((image) => image.src)).toEqual(["a", "b"]);
    h.settle(1);
    queue.enqueue(["a", "b"]);
    expect(h.images).toHaveLength(2);
  });

  it("ignores duplicate URLs inside one enqueue batch", () => {
    const h = harness();
    const queue = createThumbnailPrefetchQueue({ concurrency: 4, createImage: h.createImage });
    queue.enqueue(["a", "a", "a"]);
    expect(h.images.map((image) => image.src)).toEqual(["a"]);
  });

  it("rejects invalid input", () => {
    const queue = createThumbnailPrefetchQueue({ createImage: harness().createImage });
    expect(() => queue.enqueue([""])).toThrow(TypeError);
    expect(() => queue.enqueue([42 as unknown as string])).toThrow(TypeError);
  });
});
