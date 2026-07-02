import { useSyncExternalStore } from "react";

// Keep in sync with Tailwind's `md` breakpoint (768px): the mobile layout
// applies below it, `max-md:`/`md:` utilities handle the CSS-only cases.
const MOBILE_QUERY = "(max-width: 767px)";

const mediaQuery = window.matchMedia(MOBILE_QUERY);

function subscribe(callback: () => void) {
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
}

function getSnapshot() {
  return mediaQuery.matches;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
