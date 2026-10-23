import fs from 'fs';
import { createHash } from 'crypto';

/**
 * Streaming SHA-256 of a file, so a multi-gigabyte FITS does not have to fit in memory.
 *
 * Its own module so the one place that decides "is this copy really there" and the
 * tests that count how often it hashes can share it without an import cycle.
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    // No encoding is set on the stream, so every chunk is a Buffer; check rather than assert.
    const bytes: unknown = chunk;
    if (!Buffer.isBuffer(bytes)) throw new TypeError(`sha256File: unexpected non-Buffer chunk reading ${filePath}`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}
