import type { FileDiffOptions } from "@pierre/diffs";

const COMPACT_FILE_DIFF_UNSAFE_CSS = `
[data-diff] {
  --diffs-gap-block: 0;
  --diffs-gap-inline: 6px;
  --diffs-gap-fallback: 4px;
  --diffs-font-size: 12px;
  --diffs-line-height: 18px;
}

[data-diffs-header='default'] {
  min-height: 28px;
  padding-inline: 8px;
  font-size: 12px;
}

[data-diffs-header='default'] [data-header-content] {
  gap: 6px;
}

[data-diffs-header='default'] [data-metadata] {
  gap: 0.5ch;
  font-size: 11px;
}

[data-separator='line-info-basic'] {
  height: 22px;
}

[data-separator='line-info-basic'] [data-separator-wrapper] {
  height: 22px;
}

[data-separator='line-info-basic'] [data-expand-index] [data-separator-wrapper] {
  grid-template-columns: 22px auto;
}

[data-separator='line-info-basic']
  [data-expand-index]
  [data-separator-wrapper][data-separator-multi-button] {
  grid-template-columns: 22px 22px auto;
}

[data-separator='line-info-basic'] [data-expand-button] {
  min-width: 22px;
  border-right-width: 1px;
}

[data-separator='line-info-basic'] [data-separator-content] {
  font-size: 11px;
  padding-inline: 6px;
}

[data-separator='line-info-basic'] [data-icon] {
  width: 12px;
  height: 12px;
}
`;

export const COMPACT_FILE_DIFF_OPTIONS = {
  hunkSeparators: "line-info-basic",
  unsafeCSS: COMPACT_FILE_DIFF_UNSAFE_CSS,
} as const satisfies FileDiffOptions<undefined>;
