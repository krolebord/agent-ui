import type { Terminal } from "@xterm/xterm";

const MOMENTUM_DECAY_PER_MS = 0.9955;
const MIN_FLING_VELOCITY = 0.05;
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
    return 17;
  };

  const dispatchLines = (lines: number) => {
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
