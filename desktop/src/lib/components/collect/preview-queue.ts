type Card = {
  img: HTMLImageElement;
  url: string;
  index: number;
  visible: boolean;
  state: "waiting" | "loading" | "done";
};

/** Leave src unset until admitted: native lazy loading alone can start dozens of requests. */
export class PreviewQueue {
  private limit = 0;
  private cards = new Map<HTMLImageElement, Card>();
  private observer?: IntersectionObserver;
  private scheduled = false;

  setLimit(limit: number) {
    this.limit = limit;
    this.schedule();
  }

  image(url: string, index: number) {
    return (img: HTMLImageElement) => {
      this.observer ??= new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const card = this.cards.get(entry.target as HTMLImageElement);
          if (card) card.visible = entry.isIntersecting;
        }
        this.schedule();
      });
      const card: Card = { img, url, index, visible: false, state: "waiting" };
      this.cards.set(img, card);
      this.observer.observe(img);
      const finish = () => {
        card.state = "done";
        this.schedule();
      };
      img.addEventListener("load", finish);
      img.addEventListener("error", finish);
      return () => {
        img.removeEventListener("load", finish);
        img.removeEventListener("error", finish);
        this.observer!.unobserve(img);
        this.cards.delete(img);
        img.removeAttribute("src");
        if (!this.cards.size) {
          this.observer!.disconnect();
          this.observer = undefined;
        }
        this.schedule();
      };
    };
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      let free = this.limit;
      let lastVisible = -1;
      for (const card of this.cards.values()) {
        if (card.visible) lastVisible = Math.max(lastVisible, card.index);
        if (card.state === "loading") free--;
      }
      if (free <= 0 || lastVisible < 0) return;
      // Visible cards first. At rest, prefetch no further than one window beyond the viewport.
      for (const visible of [true, false]) {
        for (const card of this.cards.values()) {
          if (card.state !== "waiting" || card.visible !== visible) continue;
          if (!visible && (card.index <= lastVisible || card.index > lastVisible + this.limit)) continue;
          card.state = "loading";
          card.img.src = card.url;
          if (--free === 0) return;
        }
      }
    });
  }
}
