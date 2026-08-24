export interface FocusTarget {
  readonly isConnected?: boolean;
  focus(options?: FocusOptions): void;
}

export function restoreFocus(target: FocusTarget | null | undefined): boolean {
  if (!target || target.isConnected === false) return false;
  target.focus({ preventScroll: true });
  return true;
}

export function nextDirectionalIndex(current: number, count: number, key: string): number | null {
  if (count < 1) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return (current + 1 + count) % count;
  if (key === "ArrowUp" || key === "ArrowLeft") return (current - 1 + count) % count;
  return null;
}

export function trappedTabIndex(current: number, count: number, shiftKey: boolean): number | null {
  if (count < 1) return null;
  if (shiftKey && current <= 0) return count - 1;
  if (!shiftKey && current >= count - 1) return 0;
  return null;
}

export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}
