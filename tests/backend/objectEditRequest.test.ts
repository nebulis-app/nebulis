import { describe, it, expect } from 'vitest';
import { editRequestFor } from '../../src/components/objectDetail/objectEditRequest';
import type { GalleryItem } from '../../src/components/GalleryModal';
import type { ProcessedImage, SessionFile } from '../../src/types';

const file = (over: Partial<SessionFile>) => ({ name: 'Stacked.jpg', path: 'M31/Stacked.jpg', date: '2026-09-12', downloadUrl: '/f/stacked', ...over } as SessionFile);
const processed = (over: Partial<ProcessedImage>) => ({ id: 'p1', objectId: 'M31_Mosaic', date: null, url: '/p/1', ...over } as ProcessedImage);

describe('editRequestFor', () => {
  it('uses the night of an original and keeps the replace-in-place target', () => {
    const items: GalleryItem[] = [{ kind: 'file', file: file({}) }];
    const target = { kind: 'telescope', path: 'M31/Stacked.jpg' } as const;
    expect(editRequestFor(items, 'M31', '/f/stacked', 'Stacked.jpg', 'telescope', target)).toEqual({
      url: '/f/stacked', name: 'Stacked.jpg', sourceKind: 'telescope', overwriteTarget: target, objectId: 'M31', date: '2026-09-12',
    });
  });

  it('offers no replacing of an original that has no night', () => {
    const items: GalleryItem[] = [{ kind: 'file', file: file({ date: null }) }];
    const r = editRequestFor(items, 'M31', '/f/stacked', 'Stacked.jpg', 'telescope', { kind: 'telescope', path: 'M31/Stacked.jpg' });
    expect(r.date).toBeNull();
    expect(r.overwriteTarget).toBeUndefined();
  });

  it('edits a processed image under the object that owns it, which can be a variant', () => {
    const items: GalleryItem[] = [{ kind: 'processed', img: processed({}) }];
    const r = editRequestFor(items, 'M31', '/p/1', 'final', 'processed', { kind: 'processed', id: 'p1' });
    expect(r.objectId).toBe('M31_Mosaic');
    expect(r.date).toBeNull();
    // A processed image can always be replaced, night or not.
    expect(r.overwriteTarget).toEqual({ kind: 'processed', id: 'p1' });
  });

  it('falls back to the page object with no night when the picture is not found', () => {
    const r = editRequestFor([], 'M31', '/nope', 'x', 'processed', undefined);
    expect(r).toMatchObject({ objectId: 'M31', date: null });
  });
});
