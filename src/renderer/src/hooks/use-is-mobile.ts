import { useSyncExternalStore } from "react";

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
