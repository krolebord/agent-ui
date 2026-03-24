import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { Session } from "src/main/sessions/state";
import { create } from "zustand";
import { combine } from "zustand/middleware";

const MAX_RENDERED_RAW_JSON_CHARS = 200_000;

interface RawSessionStateTarget {
  sessionId: string;
  snapshot: Omit<Session, "bufferedOutput">;
}

function stripSessionBufferedOutput(
  session: Session,
): Omit<Session, "bufferedOutput"> {
  const { bufferedOutput: _bufferedOutput, ...sessionWithoutBufferedOutput } =
    session;
  return sessionWithoutBufferedOutput;
}

export const useRawSessionStateDialogStore = create(
  combine({ target: null as RawSessionStateTarget | null }, (set) => ({
    open: (session: Session) =>
      set({
        target: {
          sessionId: session.sessionId,
          snapshot: stripSessionBufferedOutput(session),
        },
      }),
    close: () => set({ target: null }),
  })),
);

export function RawSessionStateDialog() {
  const target = useRawSessionStateDialogStore((x) => x.target);
  const close = useRawSessionStateDialogStore((x) => x.close);

  const [rawJson, setRawJson] = useState("");
  const [isSerializing, setIsSerializing] = useState(false);
  const [serializeError, setSerializeError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) {
      setRawJson("");
      setIsSerializing(false);
      setSerializeError(null);
      return;
    }

    setRawJson("");
    setIsSerializing(true);
    setSerializeError(null);

    const timeoutId = window.setTimeout(() => {
      try {
        setRawJson(JSON.stringify(target.snapshot, null, 2));
      } catch {
        setSerializeError("Failed to serialize session state");
      } finally {
        setIsSerializing(false);
      }
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [target]);

  const renderedJson = useMemo(
    () =>
      rawJson.length > MAX_RENDERED_RAW_JSON_CHARS
        ? `${rawJson.slice(0, MAX_RENDERED_RAW_JSON_CHARS)}\n\n/* Output truncated for rendering. Use Copy JSON for the full payload. */`
        : rawJson,
    [rawJson],
  );

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          close();
        }
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Session state (raw JSON)</DialogTitle>
          <DialogDescription>
            Current in-memory session state for debugging and inspection
            (`bufferedOutput` excluded).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <p className="truncate text-xs text-zinc-400">
            Session ID: {target?.sessionId}
          </p>
          {isSerializing ? (
            <p className="rounded-md border border-white/10 bg-black/35 p-3 text-xs text-zinc-300">
              Preparing JSON...
            </p>
          ) : serializeError ? (
            <p className="rounded-md border border-rose-400/30 bg-rose-950/20 p-3 text-xs text-rose-300">
              {serializeError}
            </p>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-md border border-white/10 bg-black/35 p-3 text-xs leading-5 text-zinc-200">
              <code>{renderedJson}</code>
            </pre>
          )}
          {rawJson.length > MAX_RENDERED_RAW_JSON_CHARS ? (
            <p className="text-xs text-zinc-400">
              Rendering limited to{" "}
              {MAX_RENDERED_RAW_JSON_CHARS.toLocaleString()} characters to keep
              the dialog responsive.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            Close
          </Button>
          <Button
            type="button"
            disabled={isSerializing || !!serializeError || rawJson.length === 0}
            onClick={() => {
              void navigator.clipboard.writeText(rawJson);
              toast.success("Session state copied");
            }}
          >
            Copy JSON
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
