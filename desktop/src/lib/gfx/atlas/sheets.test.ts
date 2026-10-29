import { describe, expect, it, vi } from "vitest";

import { createSheetCache, fetchBitmap } from "./sheets.ts";

function bitmap(name: string) {
  return { name, close: vi.fn() } as unknown as ImageBitmap & { name: string; close: ReturnType<typeof vi.fn> };
}

interface Pending {
  readonly url: string;
  resolve(value: ImageBitmap): void;
  reject(error: unknown): void;
}

function harness(options: { maxConcurrent?: number; maxSheets?: number } = {}) {
  const pending: Pending[] = [];
  const onLoad = vi.fn();
  const onError = vi.fn();
  const cache = createSheetCache({
    urls: ["/s/0", "/s/1", "/s/2", "/s/3"],
    load: (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
    onLoad,
    onError,
    ...options,
  });
  return { cache, pending, onLoad, onError };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sheet cache", () => {
  it("按需加载，并发有上限，加载完通知并递增版本", async () => {
    const { cache, pending, onLoad } = harness({ maxConcurrent: 1 });
    cache.request([0, 1, 1, 7, -1]);
    expect(pending.map((item) => item.url)).toEqual(["/s/0"]);
    const first = bitmap("0");
    pending[0]!.resolve(first);
    await flush();
    expect(cache.get(0)).toBe(first);
    expect(cache.version).toBe(1);
    expect(onLoad).toHaveBeenCalledOnce();
    expect(pending.map((item) => item.url)).toEqual(["/s/0", "/s/1"]);
    // 已加载、加载中的不会重复请求。
    cache.request([0, 1]);
    expect(pending).toHaveLength(2);
    expect(cache.get(3)).toBeNull();
  });

  it("新的一批请求撤掉排队中但不再需要的", async () => {
    const { cache, pending } = harness({ maxConcurrent: 1 });
    cache.request([0, 1, 2]);
    cache.request([0, 3]);
    pending[0]!.resolve(bitmap("0"));
    await flush();
    expect(pending.map((item) => item.url)).toEqual(["/s/0", "/s/3"]);
  });

  it("超过上限时释放最久没用的图", async () => {
    const { cache, pending } = harness({ maxSheets: 2, maxConcurrent: 4 });
    const sheets = [bitmap("0"), bitmap("1"), bitmap("2")];
    cache.request([0, 1]);
    pending[0]!.resolve(sheets[0]!);
    pending[1]!.resolve(sheets[1]!);
    await flush();
    cache.request([2, 1]);
    pending[2]!.resolve(sheets[2]!);
    await flush();
    expect(cache.get(0)).toBeNull();
    expect(sheets[0]!.close).toHaveBeenCalledOnce();
    expect(cache.get(1)).toBe(sheets[1]);
    expect(cache.get(2)).toBe(sheets[2]);
  });

  it("失败的图不再重试；销毁后释放全部并忽略迟到的结果", async () => {
    const { cache, pending, onError, onLoad } = harness({ maxConcurrent: 4 });
    cache.request([0, 1, 2]);
    pending[0]!.reject(new Error("boom"));
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    cache.request([0]);
    expect(pending).toHaveLength(3);

    const loaded = bitmap("1");
    pending[1]!.resolve(loaded);
    await flush();
    cache.destroy();
    expect(loaded.close).toHaveBeenCalledOnce();
    const late = bitmap("2");
    pending[2]!.resolve(late);
    await flush();
    expect(late.close).toHaveBeenCalledOnce();
    expect(cache.get(2)).toBeNull();
    expect(onLoad).toHaveBeenCalledTimes(1);
    cache.request([3]);
    expect(pending).toHaveLength(3);
  });

  it("销毁后迟到的失败不报错", async () => {
    const { cache, pending, onError } = harness();
    cache.request([0]);
    cache.destroy();
    pending[0]!.reject(new Error("aborted"));
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("fetchBitmap", () => {
  it("取回 Blob 再解码；非 2xx 抛错", async () => {
    const decoded = bitmap("x");
    const decode = vi.fn(async () => decoded);
    const signal = new AbortController().signal;
    const ok = vi.fn(async () => new Response(new Blob(["png"]), { status: 200 }));
    await expect(fetchBitmap("http://127.0.0.1/s/0", signal, ok, decode)).resolves.toBe(decoded);
    expect(ok).toHaveBeenCalledWith("http://127.0.0.1/s/0", { signal });
    expect(decode).toHaveBeenCalledOnce();

    const missing = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(fetchBitmap("/s/1", signal, missing, decode)).rejects.toThrow("sprite_http_404");
  });
});
