// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { editSourceFromUrl } from '../../src/lib/imageEditSource';

describe('editSourceFromUrl', () => {
  it('reads a library file URL, with its cache stamp', () => {
    expect(editSourceFromUrl('/api/v1/library/file?path=M42%2FStacked%20M42.jpg&v=1730000000'))
      .toEqual({ kind: 'telescope', path: 'M42/Stacked M42.jpg' });
    expect(editSourceFromUrl('/api/library/file?path=M42/a.jpg')).toEqual({ kind: 'telescope', path: 'M42/a.jpg' });
  });

  it('reads a processed image URL', () => {
    expect(editSourceFromUrl('/api/v1/library/processed-images/proc_17_ab12?v=99'))
      .toEqual({ kind: 'processed', id: 'proc_17_ab12' });
  });

  it.each([
    ['an external image', 'https://example.com/library/file?path=M42/a.jpg'],
    ['a file URL with no path', '/api/v1/library/file'],
    ['a thumbnail', '/api/v1/library/file/thumbnail?path=M42%2Fa.jpg'],
    ['something else entirely', '/api/v1/forecast'],
  ])('does not claim %s', (_name, url) => {
    expect(editSourceFromUrl(url)).toBeNull();
  });
});
