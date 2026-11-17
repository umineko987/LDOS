import type { ViewerItem } from "./viewer-model.ts";

type Entry = { image: HTMLImageElement; ready: Promise<HTMLImageElement> };

/** 保留邻图的解码结果；只有可绘制的图片才交给查看器替换当前画面。 */
export class ViewerImages {
  private readonly entries = new Map<string, Entry>();
  private cancelSelection = () => {};

  constructor(private readonly createImage: () => HTMLImageElement = () => new Image()) {}

  select(
    item: ViewerItem,
    neighbors: readonly ViewerItem[],
    show: (image: HTMLImageElement, original: boolean) => void,
    fail: () => void,
  ): () => void {
    this.cancelSelection();
    let active = true;
    let originalSettled = false;
    const cancel = () => { active = false; };
    this.cancelSelection = cancel;

    const keep = new Set([item.src, ...neighbors.map((neighbor) => neighbor.src)]);
    if (item.thumb) keep.add(item.thumb);
    for (const [src, entry] of this.entries) {
      if (!keep.has(src)) this.release(src, entry);
    }

    void this.load(item.src, "high").ready.then(
      (image) => {
        if (!active) return;
        originalSettled = true;
        show(image, true);
      },
      () => {
        if (!active) return;
        originalSettled = true;
        fail();
      },
    );
    if (item.thumb && item.thumb !== item.src) {
      void this.load(item.thumb, "high").ready.then(
        (image) => {
          if (active && !originalSettled) show(image, false);
        },
        () => {}, // 缩略图失败不阻断原图。
      );
    }
    for (const neighbor of neighbors) this.load(neighbor.src, "low");
    return cancel;
  }

  clear(): void {
    this.cancelSelection();
    for (const [src, entry] of this.entries) this.release(src, entry);
  }

  private load(src: string, priority: "high" | "low"): Entry {
    const cached = this.entries.get(src);
    if (cached) {
      if (priority === "high") cached.image.fetchPriority = "high";
      return cached;
    }
    const image = this.createImage();
    // 与网格、缩略条保持相同 CORS 模式，才能复用本地后端的响应。
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.fetchPriority = priority;
    image.src = src;
    const entry = { image, ready: image.decode().then(() => image) };
    this.entries.set(src, entry);
    void entry.ready.catch(() => {
      // 允许下次浏览重试；旧请求失败不能删掉同 URL 的新请求。
      if (this.entries.get(src) === entry) this.entries.delete(src);
    });
    return entry;
  }

  private release(src: string, entry: Entry): void {
    this.entries.delete(src);
    // 屏幕上的旧图由 DOM 持有，直到新图解码完成后再替换。
    if (!entry.image.isConnected) entry.image.removeAttribute("src");
  }
}
