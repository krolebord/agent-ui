export const MAX_PASTED_FILE_BYTES = 25 * 1024 * 1024;

export const MAX_PASTED_FILE_MB = Math.floor(
  MAX_PASTED_FILE_BYTES / (1024 * 1024),
);
