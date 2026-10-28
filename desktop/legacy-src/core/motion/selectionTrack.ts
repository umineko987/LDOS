// Presentation only: the existing buttons retain selection, keyboard and focus ownership.
export function selectionTrack(element: HTMLElement): () => void {
  let frame = 0;
  const place = () => {
    const selected = element.querySelector<HTMLElement>('[aria-current="page"], [aria-current="true"], [aria-selected="true"]');
    if (!selected || !element.clientWidth) {
      delete element.dataset.selectionTrack;
      return;
    }
    const host = element.getBoundingClientRect();
    const target = selected.getBoundingClientRect();
    element.style.setProperty("--selection-x", `${target.left - host.left + element.scrollLeft - element.clientLeft}px`);
    element.style.setProperty("--selection-y", `${target.top - host.top + element.scrollTop - element.clientTop}px`);
    element.style.setProperty("--selection-width", `${target.width}px`);
    element.style.setProperty("--selection-height", `${target.height}px`);
    if (!element.dataset.selectionTrack) {
      // First placement is immediate; subsequent choices slide from the current position.
      element.dataset.selectionTrack = "placing";
      void element.offsetHeight;
      element.dataset.selectionTrack = "ready";
    }
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(place);
  };
  const mutations = new MutationObserver(schedule);
  mutations.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current", "aria-selected"] });
  const size = new ResizeObserver(schedule);
  size.observe(element);
  place();
  return () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    size.disconnect();
    delete element.dataset.selectionTrack;
  };
}
