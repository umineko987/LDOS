import type { ApplicationId, WindowRect } from "../applications/definitions";
import { dragWindowRect, resizeWindowRect, type ResizeDirection, type WindowViewport } from "./geometry";

export type WindowInteractionMode = "move" | ResizeDirection;

export interface AnimationFramePort {
  request(callback: FrameRequestCallback): number;
  cancel(frameId: number): void;
}

export interface WindowInteractionEngine {
  begin(input: {
    readonly appId: ApplicationId;
    readonly mode: WindowInteractionMode;
    readonly rect: WindowRect;
    readonly viewport: WindowViewport;
    readonly element: HTMLElement;
    readonly handle: HTMLElement;
    readonly event: PointerEvent;
  }): boolean;
  isActive(): boolean;
  cancel(): boolean;
  destroy(): void;
}

interface InteractionSession {
  readonly appId: ApplicationId;
  readonly mode: WindowInteractionMode;
  readonly startRect: WindowRect;
  readonly viewport: WindowViewport;
  readonly element: HTMLElement;
  readonly handle: HTMLElement;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly originalTransform: string;
  readonly originalWidth: string;
  readonly originalHeight: string;
  latestX: number;
  latestY: number;
  frameId: number | null;
}

function interactionRect(session: InteractionSession): WindowRect {
  const deltaX = session.latestX - session.startX;
  const deltaY = session.latestY - session.startY;
  return session.mode === "move"
    ? dragWindowRect(session.startRect, { x: deltaX, y: deltaY }, session.viewport)
    : resizeWindowRect(session.startRect, { x: deltaX, y: deltaY }, session.mode, session.viewport);
}

function projectInteraction(session: InteractionSession): void {
  const rect = interactionRect(session);
  if (session.mode === "move") {
    const deltaX = rect.x - session.startRect.x;
    const deltaY = rect.y - session.startRect.y;
    session.element.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
    return;
  }
  if (session.mode !== "bottom") session.element.style.width = `${rect.w}px`;
  if (session.mode !== "right") session.element.style.height = `${rect.h}px`;
}

export function createWindowInteractionEngine({
  events,
  frames,
  commit,
}: {
  readonly events: EventTarget;
  readonly frames: AnimationFramePort;
  readonly commit: (appId: ApplicationId, rect: WindowRect) => void;
}): WindowInteractionEngine {
  let active: InteractionSession | null = null;
  let destroyed = false;

  const scheduleProjection = (session: InteractionSession): void => {
    if (session.frameId !== null) return;
    session.frameId = frames.request(() => {
      session.frameId = null;
      projectInteraction(session);
    });
  };

  const updatePointer = (event: PointerEvent): InteractionSession | null => {
    if (!active || event.pointerId !== active.pointerId) return null;
    active.latestX = event.clientX;
    active.latestY = event.clientY;
    return active;
  };

  const cleanup = (session: InteractionSession): void => {
    if (session.frameId !== null) {
      frames.cancel(session.frameId);
      session.frameId = null;
    }
    events.removeEventListener("pointermove", onPointerMove);
    events.removeEventListener("pointerup", onPointerUp);
    events.removeEventListener("pointercancel", onPointerCancel);
    events.removeEventListener("keydown", onKeydown);
    events.removeEventListener("blur", onBlur);
    session.handle.removeEventListener("lostpointercapture", onLostPointerCapture);
    if (session.handle.hasPointerCapture(session.pointerId)) session.handle.releasePointerCapture(session.pointerId);
    session.element.style.transform = session.originalTransform;
    session.element.style.width = session.originalWidth;
    session.element.style.height = session.originalHeight;
    session.element.removeAttribute("data-window-interacting");
    active = null;
  };

  const cancelActive = (): boolean => {
    if (!active) return false;
    cleanup(active);
    return true;
  };

  function onPointerMove(rawEvent: Event): void {
    const event = rawEvent as PointerEvent;
    const session = updatePointer(event);
    if (!session) return;
    event.preventDefault();
    scheduleProjection(session);
  }

  function onPointerUp(rawEvent: Event): void {
    const session = updatePointer(rawEvent as PointerEvent);
    if (!session) return;
    const rect = interactionRect(session);
    cleanup(session);
    commit(session.appId, Object.freeze({ ...rect }));
  }

  function onPointerCancel(rawEvent: Event): void {
    const event = rawEvent as PointerEvent;
    if (!active || event.pointerId !== active.pointerId) return;
    cancelActive();
  }

  function onLostPointerCapture(rawEvent: Event): void {
    const event = rawEvent as PointerEvent;
    if (!active || event.pointerId !== active.pointerId) return;
    cancelActive();
  }

  function onKeydown(rawEvent: Event): void {
    const event = rawEvent as KeyboardEvent;
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancelActive();
  }

  function onBlur(): void {
    cancelActive();
  }

  return Object.freeze({
    begin({ appId, mode, rect, viewport, element, handle, event }) {
      if (destroyed || active || !event.isPrimary || event.button !== 0) return false;
      event.preventDefault();
      const session: InteractionSession = {
        appId,
        mode,
        startRect: Object.freeze({ ...rect }),
        viewport: Object.freeze({ ...viewport }),
        element,
        handle,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        latestX: event.clientX,
        latestY: event.clientY,
        originalTransform: element.style.transform,
        originalWidth: element.style.width,
        originalHeight: element.style.height,
        frameId: null,
      };
      active = session;
      element.setAttribute("data-window-interacting", mode);
      events.addEventListener("pointermove", onPointerMove);
      events.addEventListener("pointerup", onPointerUp);
      events.addEventListener("pointercancel", onPointerCancel);
      events.addEventListener("keydown", onKeydown);
      events.addEventListener("blur", onBlur);
      handle.addEventListener("lostpointercapture", onLostPointerCapture);
      handle.setPointerCapture(event.pointerId);
      return true;
    },
    isActive: () => active !== null,
    cancel: cancelActive,
    destroy() {
      if (destroyed) return;
      cancelActive();
      destroyed = true;
    },
  } satisfies WindowInteractionEngine);
}
