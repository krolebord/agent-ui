export function insertAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  text: string,
): { value: string; caret: number } {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = /^\s/.test(after) ? "" : " ";
  const inserted = `${lead}${text}${trail}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
