/**
 * A terminal's bounded replay buffer: the most recent PTY output as UTF-8 bytes, kept as a list of chunks so
 * appending costs O(chunk) instead of re-encoding the whole buffer. Small chunks are packed into fixed blocks so
 * keystroke echo does not cost one allocation each. Trimming drops the oldest bytes on a UTF-8 code point
 * boundary and marks the buffer truncated.
 */

/** Chunks below this size are copied into a shared block; larger ones are kept as they arrive. */
const BLOCK_BYTES = 16 * 1024;

export class ReplayBuffer {
  readonly limit: number;
  private chunks: Buffer[] = [];
  /** The block small chunks are packed into; always the logical tail when set. */
  private block: Buffer | undefined;
  private blockLength = 0;
  private length = 0;
  private trimmed = false;

  constructor(limit: number) {
    if (limit < BLOCK_BYTES) throw new RangeError(`Replay limit must be at least ${BLOCK_BYTES} bytes.`);
    this.limit = limit;
  }

  get byteLength(): number { return this.length; }
  get truncated(): boolean { return this.trimmed; }

  /** Appends output that ends on a code point boundary (node-pty decodes UTF-8 before emitting). */
  append(bytes: Uint8Array): void {
    if (!bytes.length) return;
    if (bytes.length >= this.limit) {
      // Keep a copy of only the tail, so a huge chunk is not retained whole.
      const tail = Buffer.from(bytes.subarray(codePointStart(bytes, bytes.length - this.limit)));
      this.chunks = tail.length ? [tail] : [];
      this.block = undefined;
      this.blockLength = 0;
      this.trimmed ||= this.length > 0 || tail.length < bytes.length;
      this.length = tail.length;
      return;
    }
    if (bytes.length < BLOCK_BYTES) {
      if (!this.block || this.blockLength + bytes.length > BLOCK_BYTES) {
        this.seal();
        this.block = Buffer.allocUnsafe(BLOCK_BYTES);
      }
      this.block.set(bytes, this.blockLength);
      this.blockLength += bytes.length;
    } else {
      this.seal();
      this.chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }
    this.length += bytes.length;
    if (this.length > this.limit) this.trim(this.length - this.limit);
  }

  /** The retained bytes, oldest first, in one buffer. */
  bytes(): Buffer {
    this.seal();
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.length)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  /** The retained output as text. */
  text(): string { return this.bytes().toString("utf8"); }

  /** Freezes the open block, copying only its used bytes, so later appends start a new one. */
  private seal(): void {
    if (!this.block) return;
    this.chunks.push(Buffer.from(this.block.subarray(0, this.blockLength)));
    this.block = undefined;
    this.blockLength = 0;
  }

  /** Drops the oldest bytes. The excess never exceeds the sealed chunks: the open block is at most
   * BLOCK_BYTES, below the limit, and is left in place so small appends keep packing. */
  private trim(excess: number): void {
    this.trimmed = true;
    while (excess > 0) {
      const first = this.chunks[0]!;
      if (first.length <= excess) {
        this.chunks.shift();
        this.length -= first.length;
        excess -= first.length;
        continue;
      }
      const start = codePointStart(first, excess);
      this.chunks[0] = first.subarray(start);
      this.length -= start;
      if (!this.chunks[0].length) this.chunks.shift();
      excess = 0;
    }
  }
}

/** The first index at or after `index` that does not continue a code point. */
function codePointStart(bytes: Uint8Array, index: number): number {
  while (index < bytes.length && (bytes[index]! & 0xc0) === 0x80) index++;
  return index;
}
