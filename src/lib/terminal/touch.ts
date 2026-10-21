/**
 * Turns touch on a terminal into scrolling and taps: a vertical drag scrolls (through Gespenst's wheel path, so
 * full-screen programs with mouse reporting scroll too) and glides on after a flick, and a completed tap focuses
 * the terminal (opening the soft keyboard) and can follow a link. Gespenst alone would treat every touch drag as a
 * mouse selection. Ported from AgentsInTheCloud (MIT) packages/cli-agent/src/client/index.ts (touch scrolling)
 * and packages/observable-terminal/src/client/index.ts (TerminalTouchFocus).
 */

export type TouchPoint = { identifier: number; screenX: number; screenY: number; clientX: number; clientY: number };
export type TouchLikeEvent = {
  touches: ArrayLike<TouchPoint>;
  changedTouches: ArrayLike<TouchPoint>;
  timeStamp: number;
  preventDefault(): void;
};
export type TouchGestureHandlers = {
  /** Scroll by `deltaY` CSS pixels (positive moves toward newer output) at the given point. */
  scroll(deltaY: number, clientX: number, clientY: number): void;
  tap(clientX: number, clientY: number): void;
  frame?: (callback: (now: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
};

type Track = { id: number; startX: number; startY: number; y: number; x: number; time: number; velocity: number; scrolling: boolean };

/** Slop before a drag counts as a scroll, and the most a tap may move. */
const SCROLL_SLOP_PX = 6;
const TAP_SLOP_PX = 10;

export class TerminalTouchGesture {
  declare private handlers: TouchGestureHandlers;
  declare private track: Track | undefined;
  declare private momentum: number;

  constructor(handlers: TouchGestureHandlers) {
    this.handlers = handlers;
    this.track = undefined;
    this.momentum = 0;
  }

  start(event: TouchLikeEvent): void {
    this.stopMomentum();
    const point = event.touches[0];
    this.track = event.touches.length === 1 && point
      ? { id: point.identifier, startX: point.screenX, startY: point.screenY, x: point.clientX, y: point.clientY, time: event.timeStamp, velocity: 0, scrolling: false }
      : undefined;
  }

  move(event: TouchLikeEvent): void {
    const track = this.track;
    const point = event.touches[0];
    if (!track || event.touches.length !== 1 || !point || point.identifier !== track.id) { this.track = undefined; return; }
    // Screen coordinates exclude keyboard-induced viewport panning.
    const dx = point.screenX - track.startX;
    const dy = point.screenY - track.startY;
    if (!track.scrolling && Math.abs(dy) > SCROLL_SLOP_PX && Math.abs(dy) > Math.abs(dx)) track.scrolling = true;
    if (track.scrolling) {
      event.preventDefault();
      const delta = track.y - point.clientY;
      this.handlers.scroll(delta, point.clientX, point.clientY);
      track.velocity = delta / Math.max(1, event.timeStamp - track.time);
    }
    track.x = point.clientX;
    track.y = point.clientY;
    track.time = event.timeStamp;
  }

  end(event: TouchLikeEvent): void {
    const track = this.track;
    this.track = undefined;
    if (!track) return;
    if (track.scrolling) {
      event.preventDefault();
      if (event.timeStamp - track.time < 80 && Math.abs(track.velocity) > 0.05) this.glide(track.velocity, track.x, track.y);
      return;
    }
    const point = event.changedTouches[0];
    if (event.touches.length !== 0 || event.changedTouches.length !== 1 || !point || point.identifier !== track.id
      || Math.hypot(point.screenX - track.startX, point.screenY - track.startY) > TAP_SLOP_PX) return;
    event.preventDefault();
    this.handlers.tap(point.clientX, point.clientY);
  }

  cancel(): void { this.track = undefined; this.stopMomentum(); }

  private stopMomentum(): void {
    if (this.momentum) (this.handlers.cancelFrame ?? cancelAnimationFrame)(this.momentum);
    this.momentum = 0;
  }

  private glide(velocity: number, x: number, y: number): void {
    const frame = this.handlers.frame ?? requestAnimationFrame;
    let last = (this.handlers.now ?? (() => performance.now()))();
    const step = (now: number): void => {
      const elapsed = Math.min(now - last, 40);
      last = now;
      velocity *= Math.exp(-elapsed / 180);
      if (Math.abs(velocity) < 0.02) { this.momentum = 0; return; }
      this.handlers.scroll(velocity * elapsed, x, y);
      this.momentum = frame(step);
    };
    this.momentum = frame(step);
  }
}
