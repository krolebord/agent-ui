import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { getPastedFile } from "@renderer/lib/clipboard-files";
import { isCoarsePointer } from "@renderer/lib/pointer";
import { insertAtSelection } from "@renderer/lib/text-insert";
import { cn } from "@renderer/lib/utils";
import { LoaderCircle, Paperclip } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface SessionPromptBoxProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  placeholder: string;
  autoFocus?: boolean;
  handoffControl?: ReactNode;
  modeControl?: ReactNode;
  onAttachFiles?: (files: File[]) => Promise<string[]>;
  attachDisabledReason?: string | null;
}

export function SessionPromptBox({
  id,
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  autoFocus,
  handoffControl,
  modeControl,
  onAttachFiles,
  attachDisabledReason,
}: SessionPromptBoxProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const [pendingUploads, setPendingUploads] = useState(0);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const attachFiles = async (files: File[]) => {
    if (!onAttachFiles || files.length === 0) return;
    setPendingUploads((count) => count + 1);
    try {
      const paths = await onAttachFiles(files);
      if (paths.length === 0) return;
      const textarea = textareaRef.current;
      const current = valueRef.current;
      const next = insertAtSelection(
        current,
        textarea?.selectionStart ?? current.length,
        textarea?.selectionEnd ?? current.length,
        paths.join(" "),
      );
      onChange(next.value);
      requestAnimationFrame(() => {
        textarea?.focus();
        textarea?.setSelectionRange(next.caret, next.caret);
      });
    } finally {
      setPendingUploads((count) => count - 1);
    }
  };

  const hasFooter = Boolean(onAttachFiles || handoffControl || modeControl);

  return (
    <div className="border-input focus-within:border-ring focus-within:ring-ring/50 rounded-md border transition-[color,box-shadow] focus-within:ring-[3px]">
      <Textarea
        ref={textareaRef}
        id={id}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !isCoarsePointer()) {
            event.preventDefault();
            onSubmit();
          } else if (event.key === "Escape" && onCancel) {
            event.preventDefault();
            onCancel();
          }
        }}
        onPaste={(event) => {
          if (!onAttachFiles) return;
          const file = getPastedFile(event.clipboardData);
          if (!file) return;
          event.preventDefault();
          if (attachDisabledReason) {
            toast.error(attachDisabledReason);
            return;
          }
          void attachFiles([file]);
        }}
        aria-label={placeholder}
        className={cn(
          "min-h-22 md:min-h-19 border-0 shadow-none focus-visible:border-0 focus-visible:ring-0",
          hasFooter && "rounded-b-none",
        )}
      />
      {hasFooter ? (
        <div className="border-input bg-secondary/40 flex items-center gap-1.5 rounded-b-md border-t px-1.5 py-1">
          {onAttachFiles ? (
            <>
              <Button
                type="button"
                variant="ghost"
                className="text-muted-foreground size-8 shrink-0 px-0"
                aria-label="Attach files"
                title={attachDisabledReason ?? "Attach files"}
                disabled={pendingUploads > 0 || Boolean(attachDisabledReason)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
              >
                {pendingUploads > 0 ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Paperclip className="size-3.5" />
                )}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  void attachFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </>
          ) : null}
          {handoffControl}
          {modeControl ? (
            <div className="ml-auto min-w-0">{modeControl}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
