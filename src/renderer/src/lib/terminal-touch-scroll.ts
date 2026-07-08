import type { Terminal } from "@xterm/xterm";

// xterm.js has no built-in touch scrolling. This translates vertical touch
// pans into scroll actions: direct scrollLines() for normal-buffer scrollback
// (see dispatchLines for why wheel events don't work there), and synthetic
// line-mode WheelEvents dispatched at xterm's screen element otherwise, so
// xterm's own wheel routing produces arrow-key sequences in the alternate
// buffer (how Claude CLI scrolls its transcript) and wheel mouse reporting
// when an app enables mouse tracking.
//
// Integer line-mode deltas are used instead of pixel deltas because xterm
// damps small pixel deltas (×0.3 under 50px, tuned for physical mice), which
// would make touch panning feel sluggish.

const MOMENTUM_DECAY_PER_MS = 0.9955;
const MIN_FLING_VELOCITY = 0.05; // lines per ms
const VELOCITY_SAMPLE_WINDOW_MS = 100;

export function attachTouchScroll(
  terminal: Terminal,
  container: HTMLElement,
): () => void {
  let trackedTouchId: number | null = null;
  let lastY = 0;
  let pendingLines = 0;
  let isPanning = false;
  let momentumFrame: number | null = null;
  let samples: Array<{ time: number; y: number }> = [];

  const cellHeight = () => {
    const screen = terminal.element?.querySelector(".xterm-screen");
    if (screen instanceof HTMLElement && screen.clientHeight > 0) {
      return screen.clientHeight / terminal.rows;
    }
    return 17; // ~13px monospace line; only hit before first render
  };

  const dispatchLines = (lines: number) => {
    // Normal-buffer scrollback can't be driven by synthetic wheel events:
    // xterm 6's viewport reads Chromium's legacy wheelDeltaY (which Chromium
    // derives as -deltaY, ignoring deltaMode), so a line-mode delta collapses
    // to under a pixel of scroll. Scroll the buffer directly instead. When an
    // app enables mouse tracking, keep the wheel path so it gets reported.
    if (
      terminal.buffer.active.type === "normal" &&
      terminal.modes.mouseTrackingMode === "none"
    ) {
      terminal.scrollLines(lines);
      return;
    }
    const target =
      terminal.element?.querySelector(".xterm-screen") ?? terminal.element;
    target?.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: lines,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  const flushPending = () => {
    const whole = Math.trunc(pendingLines);
    if (whole !== 0) {
      pendingLines -= whole;
      dispatchLines(whole);
    }
  };

  const stopMomentum = () => {
    if (momentumFrame !== null) {
      cancelAnimationFrame(momentumFrame);
      momentumFrame = null;
    }
  };

  const startMomentum = (initialVelocity: number) => {
    let velocity = initialVelocity;
    let lastTime = performance.now();

    const step = (now: number) => {
      const elapsed = now - lastTime;
      lastTime = now;
      velocity *= MOMENTUM_DECAY_PER_MS ** elapsed;
      if (Math.abs(velocity) < MIN_FLING_VELOCITY) {
        momentumFrame = null;
        return;
      }
      pendingLines += velocity * elapsed;
      flushPending();
      momentumFrame = requestAnimationFrame(step);
    };

    momentumFrame = requestAnimationFrame(step);
  };

  const onTouchStart = (event: TouchEvent) => {
    stopMomentum();
    if (event.touches.length !== 1) {
      trackedTouchId = null;
      return;
    }
    const touch = event.touches[0];
    trackedTouchId = touch.identifier;
    lastY = touch.clientY;
    pendingLines = 0;
    isPanning = false;
    samples = [{ time: performance.now(), y: touch.clientY }];
  };

  const onTouchMove = (event: TouchEvent) => {
    if (trackedTouchId === null) {
      return;
    }
    const touch = Array.from(event.changedTouches).find(
      (t) => t.identifier === trackedTouchId,
    );
    if (!touch) {
      return;
    }

    // Finger up (negative dy) reveals content below → positive wheel delta,
    // matching native touch scrolling direction.
    const dy = lastY - touch.clientY;
    lastY = touch.clientY;

    if (!isPanning && Math.abs(dy) < 1) {
      return;
    }
    isPanning = true;
    event.preventDefault();

    const now = performance.now();
    samples.push({ time: now, y: touch.clientY });
    samples = samples.filter((s) => now - s.time <= VELOCITY_SAMPLE_WINDOW_MS);

    pendingLines += dy / cellHeight();
    flushPending();
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (
      trackedTouchId === null ||
      !Array.from(event.changedTouches).some(
        (t) => t.identifier === trackedTouchId,
      )
    ) {
      return;
    }
    trackedTouchId = null;
    if (!isPanning || samples.length < 2) {
      return;
    }

    const first = samples[0];
    const last = samples[samples.length - 1];
    const elapsed = last.time - first.time;
    if (elapsed <= 0) {
      return;
    }
    const velocity = (first.y - last.y) / elapsed / cellHeight();
    if (Math.abs(velocity) >= MIN_FLING_VELOCITY) {
      startMomentum(velocity);
    }
  };

  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: false });
  container.addEventListener("touchend", onTouchEnd, { passive: true });
  container.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return () => {
    stopMomentum();
    container.removeEventListener("touchstart", onTouchStart);
    container.removeEventListener("touchmove", onTouchMove);
    container.removeEventListener("touchend", onTouchEnd);
    container.removeEventListener("touchcancel", onTouchEnd);
  };
}
