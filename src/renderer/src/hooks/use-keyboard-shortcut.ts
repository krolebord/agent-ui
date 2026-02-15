import { useEffect, useRef } from "react";

type KeyboardShortcutOptions = {
  key: string;
  callback: () => void;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  enabled?: boolean;
};

export function useKeyboardShortcut({
  key,
  callback,
  meta = false,
  shift = false,
  alt = false,
  enabled = true,
}: KeyboardShortcutOptions): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!enabled) return;
      if (event.key.toLowerCase() !== key.toLowerCase()) return;

      const metaPressed = event.metaKey || event.ctrlKey;
      if (metaPressed !== meta) return;
      if (event.shiftKey !== shift) return;
      if (event.altKey !== alt) return;

      event.preventDefault();
      event.stopPropagation();
      callbackRef.current();
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [key, meta, shift, alt, enabled]);
}
