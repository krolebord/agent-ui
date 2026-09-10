import { isCoarsePointer } from "@renderer/lib/pointer";

export function shouldAutoFocus(): boolean {
  return !isCoarsePointer();
}

export function preventAutoFocusOnTouch(event: Event): void {
  if (!shouldAutoFocus()) {
    event.preventDefault();
  }
}
