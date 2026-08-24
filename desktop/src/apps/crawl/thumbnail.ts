export interface ThumbnailAttachment {
  update(url: string): void;
  destroy(): void;
}

export function attachThumbnail(image: HTMLImageElement, initialUrl: string): ThumbnailAttachment {
  let url = "";
  let destroyed = false;

  const clear = (): void => {
    image.removeAttribute("src");
  };
  const onError = (): void => clear();
  const onLoad = (): void => {
    if (image.src && image.src !== url) clear();
  };
  const update = (next: string): void => {
    if (destroyed || next === url) return;
    url = next;
    clear();
    if (url) image.src = url;
  };

  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("load", onLoad);
  image.addEventListener("error", onError);
  update(initialUrl);

  return Object.freeze({
    update,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
      clear();
      url = "";
    },
  });
}

export function thumbnail(image: HTMLImageElement, url: string) {
  return attachThumbnail(image, url);
}
