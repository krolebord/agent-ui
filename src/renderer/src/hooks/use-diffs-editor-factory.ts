import type { EditorFactory } from "@pierre/diffs/edit";
import { useCallback, useEffect, useRef, useState } from "react";

export function useDiffsEditorFactory<LAnnotation>() {
  const [createEditor, setCreateEditor] = useState<EditorFactory<
    LAnnotation,
    undefined
  > | null>(null);
  const [loadError, setLoadError] = useState(false);
  const mounted = useRef(false);

  const load = useCallback(() => {
    setLoadError(false);
    void import("@pierre/diffs/edit")
      .then(({ Editor: DiffsEditor }) => {
        if (!mounted.current) return;
        const factory: EditorFactory<LAnnotation, undefined> = (
          editorType,
          options,
          editStateKey,
        ) => new DiffsEditor(editorType, options, editStateKey);
        setCreateEditor(() => factory);
      })
      .catch(() => {
        if (mounted.current) setLoadError(true);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return { createEditor, loadError, retry: load };
}
