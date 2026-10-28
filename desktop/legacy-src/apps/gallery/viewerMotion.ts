// A visual bridge only: controller state, focus and input never wait for it.
const EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

function imageRect(image: HTMLImageElement, aspect: number): DOMRect | null {
  const style = getComputedStyle(image);
  if (style.objectFit !== "contain" || style.visibility === "hidden") return null;
  const box = image.getBoundingClientRect();
  const ratio = image.naturalWidth / image.naturalHeight || aspect;
  if (!ratio || !box.width || !box.height) return null;
  const width = Math.min(box.width, box.height * ratio);
  const height = width / ratio;
  const rect = new DOMRect(box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, width, height);
  const viewport = image.closest(".gallery-grid-scroll, .gallery-list-scroll, .gallery-viewer__stage")?.getBoundingClientRect();
  // Don't fly toward a recycled/offscreen tile, or expose a cropped zoomed image.
  if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return null;
  if (viewport && (rect.left < viewport.left - 1 || rect.right > viewport.right + 1 || rect.top < viewport.top - 1 || rect.bottom > viewport.bottom + 1)) return null;
  return rect;
}

export function prepareViewerMotion(gallery: HTMLElement, openingAssetId: string | null): { play: () => void; cancel: () => void } {
  const host = gallery.parentElement;
  const opening = openingAssetId !== null;
  const viewer = host?.querySelector<HTMLElement>("[data-gallery-viewer-asset]");
  const assetId = openingAssetId ?? viewer?.dataset.galleryViewerAsset;
  const thumbnail = () => assetId ? gallery.querySelector<HTMLImageElement>(`[data-gallery-asset="${CSS.escape(assetId)}"] img`) : null;
  const source = opening ? thumbnail() : viewer?.querySelector<HTMLImageElement>(".gallery-viewer__stage img");
  const aspect = source ? source.naturalWidth / source.naturalHeight : 0;
  const from = source?.complete && source.naturalWidth ? imageRect(source, aspect) : null;
  const src = source?.currentSrc;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const forced = matchMedia("(forced-colors: active)");
  const allowed = () => document.documentElement.dataset.motion !== "off"
    && document.documentElement.dataset.motionEffective !== "off"
    && !reduced.matches && !forced.matches && !document.hidden;
  const animations: Animation[] = [];
  const layers: HTMLElement[] = [];
  let hiddenImage: HTMLImageElement | null = null;
  let priorVisibility = "";
  let observer: MutationObserver | null = null;
  let cancelled = false;

  function cancel(): void {
    if (cancelled) return;
    cancelled = true;
    for (const animation of animations) animation.cancel();
    for (const layer of layers) layer.remove();
    if (hiddenImage) hiddenImage.style.visibility = priorVisibility;
    observer?.disconnect();
    reduced.removeEventListener("change", cancel);
    forced.removeEventListener("change", cancel);
    document.removeEventListener("visibilitychange", cancel);
    window.removeEventListener("resize", cancel);
    window.removeEventListener("keydown", cancel, true);
    window.removeEventListener("pointerdown", cancel, true);
    window.removeEventListener("wheel", cancel, true);
  }

  function animate(element: HTMLElement, frames: Keyframe[], duration: number): Animation {
    const animation = element.animate(frames, { duration, easing: EASING, fill: "both" });
    animations.push(animation);
    return animation;
  }

  function play(): void {
    if (cancelled || !allowed() || !gallery.isConnected) return;
    const currentViewer = host?.querySelector<HTMLElement>("[data-gallery-viewer-asset]");
    if (opening && currentViewer?.dataset.galleryViewerAsset !== assetId) return;
    const destination = opening ? currentViewer?.querySelector<HTMLImageElement>(".gallery-viewer__stage img") : thumbnail();
    const to = destination ? imageRect(destination, aspect) : null;
    const duration = opening ? 280 : 210;

    observer = new MutationObserver(() => { if (!allowed()) cancel(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion", "data-motion-effective"] });
    reduced.addEventListener("change", cancel);
    forced.addEventListener("change", cancel);
    document.addEventListener("visibilitychange", cancel);
    window.addEventListener("resize", cancel);
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("wheel", cancel, { capture: true, passive: true });

    let completion: Animation;
    if (opening && currentViewer) {
      completion = animate(currentViewer, [{ opacity: 0 }, { opacity: 1 }], duration);
    } else {
      const backdrop = document.createElement("div");
      backdrop.className = "gallery-motion-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      document.body.append(backdrop);
      layers.push(backdrop);
      completion = animate(backdrop, [{ opacity: 1 }, { opacity: 0 }], duration);
    }

    if (from && to && src && destination) {
      const image = document.createElement("img");
      image.className = "gallery-motion-image";
      image.alt = "";
      image.setAttribute("aria-hidden", "true");
      image.crossOrigin = "anonymous";
      image.src = src;
      Object.assign(image.style, { left: `${to.x}px`, top: `${to.y}px`, width: `${to.width}px`, height: `${to.height}px` });
      document.body.append(image);
      layers.push(image);
      hiddenImage = destination;
      priorVisibility = destination.style.visibility;
      destination.style.visibility = "hidden";
      completion = animate(image, [
        { transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width}, ${from.height / to.height})` },
        { transform: "translate(0, 0) scale(1, 1)" },
      ], duration);
    }
    void completion.finished.then(cancel, cancel);
  }

  return { play, cancel };
}
