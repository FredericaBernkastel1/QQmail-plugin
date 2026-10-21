import { ToolFailure } from "../errors.js";

export const DEFAULT_BODY_CHARS = 4_000;
export const MAX_BODY_PAGE_CHARS = 50_000;
export const MAX_READ_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_CONCURRENT_READS = 2;
export const MAX_REQUEST_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_READ_OUTPUT_BYTES = 256 * 1024;
/** Parser rejects an oversized literal as soon as its length marker arrives. */
export const MAX_IMAP_LITERAL_BYTES = 32 * 1024 * 1024;
/** Attachment total size is independently capped; compliant servers stream these windows. */
export const IMAP_DOWNLOAD_CHUNK_BYTES = 64 * 1024;

/** Bounds owned raw MIME buffers and active parsers, not the Node process RSS. */
export class ReadResourceBudget {
  #reservedBytes = 0;
  #activeReads = 0;

  constructor(
    readonly maximumBytes = MAX_READ_SOURCE_BYTES,
    readonly maximumConcurrent = MAX_CONCURRENT_READS,
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
        !Number.isSafeInteger(maximumConcurrent) || maximumConcurrent < 1) {
      throw new Error("Invalid read resource budget");
    }
  }

  snapshot(): { reservedBytes: number; activeReads: number } {
    return { reservedBytes: this.#reservedBytes, activeReads: this.#activeReads };
  }

  async run<T>(bytes: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    checkReadCancelled(signal);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.maximumBytes - this.#reservedBytes) {
      throw new ToolFailure("READ_BYTE_BUDGET_EXCEEDED", "The shared MIME byte budget is busy or this message limit is too large. Retry after active reads finish or use a smaller parsing limit.");
    }
    if (this.#activeReads >= this.maximumConcurrent) {
      throw new ToolFailure("READ_CONCURRENCY_LIMIT", "The shared read concurrency limit is busy. Retry after active reads finish.");
    }
    this.#activeReads += 1;
    this.#reservedBytes += bytes;
    try {
      const result = await operation();
      checkReadCancelled(signal);
      return result;
    } finally {
      this.#reservedBytes -= bytes;
      this.#activeReads -= 1;
    }
  }
}

/** One process-wide pool also covers reads used when preparing replies/forwards. */
export const sharedReadBudget = new ReadResourceBudget();

export function checkReadCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ToolFailure("READ_CANCELLED", "The mail read was cancelled.");
}

/** Includes JSON escaping and UTF-8, with space reserved for the enclosing result. */
export class ReadOutputBudget {
  #usedBytes = 16 * 1024;
  constructor(readonly maximumBytes = MAX_READ_OUTPUT_BYTES) {}
  add(value: unknown): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    if (bytes > this.maximumBytes - this.#usedBytes) return false;
    this.#usedBytes += bytes;
    return true;
  }
}
