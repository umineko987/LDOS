/**
 * 缩略图预取队列（G2-4）。
 *
 * 网格与查看器里的 `<img loading="lazy">` 只在进入视口时才发起请求，
 * 冷缓存下用户会撞上逐张的生成延迟。这里用低并发的 `Image` 预热
 * 浏览器 HTTP 缓存（与真实 `<img>` 走同一条缓存路径），让后续的
 * 懒加载命中缓存。队列只做"尽快但不风暴"的预热：
 *
 * - 每 URL 终身只尝试一次（成功或失败都记为已尝试，避免坏资源重试风暴）；
 * - 并发受限（默认 2），不与用户正在看的图抢占后端解码线程；
 * - 不做内存缓存——浏览器磁盘缓存 + ETag 才是唯一存储。
 */

export interface PrefetchImage {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

export type PrefetchImageFactory = () => PrefetchImage;

const createBrowserImage: PrefetchImageFactory = () => new Image() as unknown as PrefetchImage;

export interface ThumbnailPrefetchQueue {
  /** 追加待预热 URL（已尝试过的会静默跳过）。 */
  enqueue(urls: readonly string[]): void;
  /** 尚未开始预热的 URL 数量（测试与诊断用）。 */
  backlogCount(): number;
  /** 正在加载中的数量（测试与诊断用）。 */
  inFlightCount(): number;
}

export function createThumbnailPrefetchQueue(options?: {
  concurrency?: number;
  createImage?: PrefetchImageFactory;
}): ThumbnailPrefetchQueue {
  const concurrency = options?.concurrency ?? 2;
  const createImage = options?.createImage ?? createBrowserImage;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("invalid_thumbnail_prefetch_concurrency");
  }
  const attempted = new Set<string>();
  const backlog: string[] = [];
  let inFlight = 0;

  function pump(): void {
    while (inFlight < concurrency && backlog.length > 0) {
      const url = backlog.shift();
      if (url === undefined || attempted.has(url)) continue;
      attempted.add(url);
      inFlight += 1;
      const image = createImage();
      const settle = (): void => {
        inFlight -= 1;
        pump();
      };
      image.onload = settle;
      image.onerror = settle;
      image.src = url;
    }
  }

  return {
    enqueue(urls) {
      if (!Array.isArray(urls)) throw new TypeError("invalid_thumbnail_prefetch_urls");
      for (const url of urls) {
        if (typeof url !== "string" || url.length === 0) {
          throw new TypeError("invalid_thumbnail_prefetch_url");
        }
        if (!attempted.has(url) && !backlog.includes(url)) backlog.push(url);
      }
      pump();
    },
    backlogCount() {
      return backlog.length;
    },
    inFlightCount() {
      return inFlight;
    },
  };
}

/** 应用级共享队列：网格分页、目录封面与查看器相邻项都走这里。 */
const sharedQueue = createThumbnailPrefetchQueue();

export function enqueueThumbnailPrefetch(urls: readonly string[]): void {
  sharedQueue.enqueue(urls);
}
