import { isCoarsePointer } from "@renderer/lib/pointer";

/**
 * On touch devices, programmatically focusing an input summons the on-screen
 * keyboard and shifts the layout. Gate autofocus behavior behind this so the
 * keyboard only appears when the user taps a field.
 */
export function shouldAutoFocus(): boolean {
  return !isCoarsePointer();
}

/**
 * Handler for Radix `onOpenAutoFocus`/`onCloseAutoFocus`: suppresses the
 * default focus behavior on touch devices.
 */
export function preventAutoFocusOnTouch(event: Event): void {
  if (!shouldAutoFocus()) {
    event.preventDefault();
  }
}
