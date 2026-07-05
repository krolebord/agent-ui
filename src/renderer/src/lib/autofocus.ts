const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

/**
 * On touch devices, programmatically focusing an input summons the on-screen
 * keyboard and shifts the layout. Gate autofocus behavior behind this so the
 * keyboard only appears when the user taps a field.
 */
export function shouldAutoFocus(): boolean {
  return !coarsePointerQuery.matches;
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
