export function getPastedFile(
  clipboardData: Pick<DataTransfer, "getData" | "items"> | null,
): File | null {
  if (!clipboardData) {
    return null;
  }

  if (clipboardData.getData("text/plain")) {
    return null;
  }

  for (const item of clipboardData.items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        return file;
      }
    }
  }

  return null;
}
