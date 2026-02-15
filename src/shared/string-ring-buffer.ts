interface StringRingBufferOptions {
  maxTotalSize: number;
}

export class StringRingBuffer {
  private readonly maxTotalSize: number;
  private chunks: string[] = [];
  private head = 0;
  private totalSize = 0;

  constructor(options: StringRingBufferOptions) {
    if (
      !Number.isFinite(options.maxTotalSize) ||
      options.maxTotalSize <= 0 ||
      !Number.isInteger(options.maxTotalSize)
    ) {
      throw new Error("maxTotalSize must be a positive integer.");
    }

    this.maxTotalSize = options.maxTotalSize;
  }

  push(value: string): void {
    if (!value) {
      return;
    }

    if (value.length >= this.maxTotalSize) {
      const nextValue = value.slice(value.length - this.maxTotalSize);
      this.chunks = [nextValue];
      this.head = 0;
      this.totalSize = nextValue.length;
      return;
    }

    this.chunks.push(value);
    this.totalSize += value.length;

    while (
      this.totalSize > this.maxTotalSize &&
      this.head < this.chunks.length
    ) {
      const overflow = this.totalSize - this.maxTotalSize;
      const headChunk = this.chunks[this.head];

      if (headChunk.length <= overflow) {
        this.totalSize -= headChunk.length;
        this.head += 1;
        continue;
      }

      this.chunks[this.head] = headChunk.slice(overflow);
      this.totalSize -= overflow;
      break;
    }

    this.compactIfNeeded();
  }

  getFullContent(): string {
    if (this.head === 0) {
      return this.chunks.join("");
    }

    return this.chunks.slice(this.head).join("");
  }

  getContent(): string {
    return this.getFullContent();
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.totalSize = 0;
  }

  getTotalSize(): number {
    return this.totalSize;
  }

  private compactIfNeeded(): void {
    if (this.head < 1024 || this.head * 2 < this.chunks.length) {
      return;
    }

    this.chunks = this.chunks.slice(this.head);
    this.head = 0;
  }
}
