import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { objectThumbnailDiskCacheKey } from '../../server/lib/library/gallery';

describe('objectThumbnailDiskCacheKey', () => {
  it('is deterministic for the same inputs (prewarm key === route key)', () => {
    const a = objectThumbnailDiskCacheKey('/lib/M31/master.jpg', 400, 400, 1234567);
    const b = objectThumbnailDiskCacheKey('/lib/M31/master.jpg', 400, 400, 1234567);
    expect(a).toBe(b);
  });

  it('matches the documented sha256/base64url formula', () => {
    const expected = createHash('sha256')
      .update('/lib/M31/master.jpg:400x400:1234567')
      .digest('base64url');
    expect(objectThumbnailDiskCacheKey('/lib/M31/master.jpg', 400, 400, 1234567)).toBe(expected);
  });

  it('changes when the source mtime changes (busts an in-place overwrite)', () => {
    const before = objectThumbnailDiskCacheKey('/lib/M31/master.jpg', 400, 400, 1);
    const after = objectThumbnailDiskCacheKey('/lib/M31/master.jpg', 400, 400, 2);
    expect(before).not.toBe(after);
  });

  it('stays a fixed length regardless of how long the source path runs', () => {
    const short = objectThumbnailDiskCacheKey('/a.jpg', 400, 400, 1);
    const long = objectThumbnailDiskCacheKey('/' + 'x'.repeat(4000) + '.jpg', 400, 400, 1);
    expect(long.length).toBe(short.length);
  });
});
