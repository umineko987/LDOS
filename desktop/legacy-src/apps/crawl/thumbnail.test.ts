import { describe, expect, it, vi } from "vitest";

import { attachThumbnail } from "./thumbnail";

class ImageTarget extends EventTarget {
  loading = "";
  decoding = "";
  referrerPolicy = "";
  src = "";
  readonly counts = new Map<string, number>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    super.addEventListener(type, listener);
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    super.removeEventListener(type, listener);
    this.counts.set(type, Math.max(0, (this.counts.get(type) ?? 0) - 1));
  }
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
}

describe("Crawl thumbnail lifecycle", () => {
  it("keeps lazy async decoding and releases listeners plus image references", () => {
    const image = new ImageTarget();
    const attachment = attachThumbnail(image as unknown as HTMLImageElement, "https://ehgt.org/w/one.webp");
    expect(image).toMatchObject({
      loading: "lazy",
      decoding: "async",
      referrerPolicy: "no-referrer",
      src: "https://ehgt.org/w/one.webp",
    });
    attachment.update("https://ehgt.org/w/two.webp");
    expect(image.src).toBe("https://ehgt.org/w/two.webp");
    image.dispatchEvent(new Event("error"));
    expect(image.src).toBe("");
    attachment.destroy();
    attachment.destroy();
    expect(image.counts).toEqual(new Map([["load", 0], ["error", 0]]));
    expect(image.src).toBe("");
  });

  it("returns listeners and references to baseline across 20 cycles", () => {
    const image = new ImageTarget();
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const attachment = attachThumbnail(image as unknown as HTMLImageElement, `https://ehgt.org/w/${cycle}.webp`);
      attachment.destroy();
    }
    expect(image.counts).toEqual(new Map([["load", 0], ["error", 0]]));
    expect(image.src).toBe("");
  });
});
