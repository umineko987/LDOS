import { describe, expect, it, vi } from "vitest";

import { ViewerImages } from "./viewer-images.ts";
import type { ViewerItem } from "./viewer-model.ts";

class DeferredImage {
  src = "";
  crossOrigin = "";
  decoding = "";
  fetchPriority = "";
  isConnected = false;
  readonly decoded = Promise.withResolvers<void>();
  readonly decode = vi.fn(() => this.decoded.promise);
  readonly removeAttribute = vi.fn(() => {
    this.src = "";
    this.decoded.reject(new Error("image request cancelled"));
  });

  get element(): HTMLImageElement {
    return this as unknown as HTMLImageElement;
  }
}

const item = (id: string, thumb?: string): ViewerItem => ({ id, name: id, src: `/${id}.png`, thumb });
// decode() → cache promise → selected image callback.
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture() {
  const created: DeferredImage[] = [];
  const images = new ViewerImages(() => {
    const image = new DeferredImage();
    created.push(image);
    return image.element;
  });
  const request = (src: string) => created.findLast((image) => image.src === src)!;
  const show = vi.fn<(image: HTMLImageElement, original: boolean) => void>();
  const fail = vi.fn();
  return { created, images, request, show, fail };
}

describe("ViewerImages", () => {
  it("保留画面直到目标解码完成，缩略图和原图之间不清空画面", async () => {
    const { images, request, show, fail } = fixture();
    let displayed = "previous";
    show.mockImplementation((image) => { displayed = image.src; });
    images.select(item("next", "/next-thumb.png"), [], show, fail);
    await flush();
    expect(displayed).toBe("previous");
    request("/next-thumb.png").decoded.resolve();
    await flush();
    expect(displayed).toBe("/next-thumb.png");
    expect(show).toHaveBeenLastCalledWith(request("/next-thumb.png").element, false);
    request("/next.png").decoded.resolve();
    await flush();
    expect(displayed).toBe("/next.png");
    expect(show).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenLastCalledWith(request("/next.png").element, true);
    expect(fail).not.toHaveBeenCalled();
  });

  it("左右邻图提前解码，切过去复用同一个节点并提升请求优先级", async () => {
    const { created, images, request, show, fail } = fixture();
    const [left, center, right] = [item("left"), item("center"), item("right")];
    images.select(center, [left, right], show, fail);
    for (const image of created) {
      expect(image.crossOrigin).toBe("anonymous");
      expect(image.decoding).toBe("async");
      expect(image.decode).toHaveBeenCalledOnce();
      image.decoded.resolve();
    }
    await flush();
    expect(show).toHaveBeenCalledTimes(1);
    expect(request(left.src).fetchPriority).toBe("low");
    images.select(left, [center, right], show, fail);
    await flush();
    expect(show).toHaveBeenLastCalledWith(request(left.src).element, true);
    expect(request(left.src).fetchPriority).toBe("high");
    images.select(right, [left, center], show, fail);
    await flush();
    expect(show).toHaveBeenLastCalledWith(request(right.src).element, true);
    expect(created).toHaveLength(3);
  });

  it("原图先完成时，迟到的缩略图不会把画面换回低清", async () => {
    const { images, request, show, fail } = fixture();
    images.select(item("full", "/thumb.png"), [], show, fail);
    request("/full.png").decoded.resolve();
    await flush();
    request("/thumb.png").decoded.resolve();
    await flush();
    expect(show).toHaveBeenCalledExactlyOnceWith(request("/full.png").element, true);
  });

  it("快速切换时，旧图的迟到结果和错误都不能覆盖当前选择", async () => {
    const { images, request, show, fail } = fixture();
    const [first, second, third] = [item("first"), item("second"), item("third")];
    const cancelFirst = images.select(first, [second, third], show, fail);
    images.select(second, [first, third], show, fail);
    images.select(third, [first, second], show, fail);
    cancelFirst();
    request(first.src).decoded.resolve();
    request(second.src).decoded.reject(new Error("old request failed"));
    await flush();
    expect(show).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    request(third.src).decoded.resolve();
    await flush();
    expect(show).toHaveBeenCalledExactlyOnceWith(request(third.src).element, true);
  });

  it("释放窗口外的预取，但保留仍在屏幕上的上一帧", async () => {
    const { images, request, show, fail } = fixture();
    const [old, neighbor, next] = [item("old"), item("neighbor"), item("next")];
    images.select(old, [neighbor], show, fail);
    const visible = request(old.src);
    const pending = request(neighbor.src);
    visible.decoded.resolve();
    await flush();
    visible.isConnected = true;
    images.select(next, [], show, fail);
    expect(visible.removeAttribute).not.toHaveBeenCalled();
    expect(pending.removeAttribute).toHaveBeenCalledWith("src");
    images.clear();
    await flush();
    expect(show).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
  });

  it("关闭后不交付图片，再打开不会受已取消的同 URL 请求影响", async () => {
    const { created, images, request, show, fail } = fixture();
    const current = item("reopen");
    images.select(current, [], show, fail);
    images.clear();
    images.select(current, [], show, fail);
    await flush();
    expect(show).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    request(current.src).decoded.resolve();
    await flush();
    images.select(current, [], show, fail);
    await flush();
    expect(created).toHaveLength(2);
    expect(show).toHaveBeenLastCalledWith(request(current.src).element, true);
  });

  it("缩略图失败仍可显示原图；原图失败报错并允许再次浏览时重试", async () => {
    const { created, images, request, show, fail } = fixture();
    const current = item("retry", "/thumb.png");
    images.select(current, [], show, fail);
    request("/thumb.png").decoded.reject(new Error("no thumbnail"));
    await flush();
    expect(fail).not.toHaveBeenCalled();
    request(current.src).decoded.reject(new Error("bad image"));
    await flush();
    expect(fail).toHaveBeenCalledOnce();
    images.select(current, [], show, fail);
    request(current.src).decoded.resolve();
    await flush();
    expect(created).toHaveLength(4);
    expect(show).toHaveBeenCalledExactlyOnceWith(request(current.src).element, true);
  });
});
