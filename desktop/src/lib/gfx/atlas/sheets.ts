// 雪碧图缓存：按需加载缩略图大图（每张 2048² ≈ 16 MB 解码后），同时最多保留 maxSheets 张。
//
// 用 fetch → Blob → createImageBitmap，而不是 <img>：这样拿到的位图不受跨源污染，
// WebGL 能直接上传成纹理。加载失败的图记下来不再重试，渲染器画占位方块。

export interface SheetCache {
  get(index: number): ImageBitmap | null;
  /** 标记这些编号正在使用，并加载还没有的；超出上限时释放最久没用的。 */
  request(indices: readonly number[]): void;
  /** 有新图加载完成时递增。 */
  readonly version: number;
  destroy(): void;
}

export interface SheetCacheOptions {
  readonly urls: readonly string[];
  readonly load: (url: string, signal: AbortSignal) => Promise<ImageBitmap>;
  readonly onLoad: () => void;
  readonly onError?: (error: unknown) => void;
  readonly maxConcurrent?: number;
  readonly maxSheets?: number;
}

export async function fetchBitmap(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  decode: (blob: Blob) => Promise<ImageBitmap> = (blob) => createImageBitmap(blob),
): Promise<ImageBitmap> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`sprite_http_${response.status}`);
  return decode(await response.blob());
}

export function createSheetCache({
  urls,
  load,
  onLoad,
  onError,
  maxConcurrent = 2,
  maxSheets = 16,
}: SheetCacheOptions): SheetCache {
  const loaded = new Map<number, ImageBitmap>();
  const failed = new Set<number>();
  const inFlight = new Set<number>();
  const queue: number[] = [];
  /** 最近使用顺序，越靠后越新。 */
  let recent: number[] = [];
  let version = 0;
  const controller = new AbortController();

  function touch(indices: readonly number[]) {
    const used = new Set(indices);
    recent = [...recent.filter((index) => !used.has(index)), ...indices];
  }

  function evict(keep: ReadonlySet<number>) {
    while (loaded.size > maxSheets) {
      const victim = recent.find((index) => loaded.has(index) && !keep.has(index));
      if (victim === undefined) return;
      loaded.get(victim)!.close();
      loaded.delete(victim);
      recent = recent.filter((index) => index !== victim);
    }
  }

  function pump() {
    while (inFlight.size < maxConcurrent && queue.length) {
      const index = queue.shift()!;
      inFlight.add(index);
      load(urls[index]!, controller.signal).then(
        (bitmap) => {
          inFlight.delete(index);
          if (controller.signal.aborted) {
            bitmap.close();
            return;
          }
          loaded.set(index, bitmap);
          version += 1;
          evict(new Set(recent.slice(-maxSheets)));
          onLoad();
          pump();
        },
        (error: unknown) => {
          inFlight.delete(index);
          if (controller.signal.aborted) return;
          failed.add(index);
          onError?.(error);
          pump();
        },
      );
    }
  }

  return {
    get(index) {
      return loaded.get(index) ?? null;
    },
    request(indices) {
      if (controller.signal.aborted) return;
      const wanted = indices.filter((index) => Number.isInteger(index) && index >= 0 && index < urls.length);
      touch(wanted);
      for (const index of wanted) {
        if (loaded.has(index) || inFlight.has(index) || failed.has(index) || queue.includes(index)) continue;
        queue.push(index);
      }
      // 请求新的一批时，排队但已经不需要的先撤掉。
      const current = new Set(wanted);
      for (let position = queue.length - 1; position >= 0; position -= 1) {
        if (!current.has(queue[position]!)) queue.splice(position, 1);
      }
      evict(current);
      pump();
    },
    get version() {
      return version;
    },
    destroy() {
      controller.abort();
      queue.length = 0;
      for (const bitmap of loaded.values()) bitmap.close();
      loaded.clear();
    },
  };
}
