import { describe, it, expect } from 'vitest';
import { slotReducer, type SlotState } from '../../src/components/gallery/galleryReducer';
import type { LibraryImage } from '../../src/lib/api';

function img(path: string, isFavorite = false): LibraryImage {
  return {
    path,
    name: path,
    objectId: 'M42',
    type: 'fit',
    size: 100,
    mtime: '2024-10-15T20:00:00Z',
    isFavorite,
  } as LibraryImage;
}

describe('slotReducer', () => {
  const a = img('a.jpg');
  const b = img('b.jpg');
  const c = img('c.jpg');
  const d = img('d.jpg');

  const initial: SlotState = { active: 0, s0: a, s1: b };

  describe('ADVANCE', () => {
    it('flips active slot from 0 to 1 and writes the new image into slot 1', () => {
      const next = slotReducer(initial, { type: 'ADVANCE', next: c });
      expect(next.active).toBe(1);
      expect(next.s0).toBe(a); // unchanged
      expect(next.s1).toBe(c); // newly written
    });

    it('flips active slot from 1 to 0 and writes the new image into slot 0', () => {
      const state: SlotState = { active: 1, s0: a, s1: b };
      const next = slotReducer(state, { type: 'ADVANCE', next: c });
      expect(next.active).toBe(0);
      expect(next.s0).toBe(c); // newly written
      expect(next.s1).toBe(b); // unchanged
    });

    it('chains advances so each new image lands in the previously-inactive slot', () => {
      let state = initial;
      state = slotReducer(state, { type: 'ADVANCE', next: c }); // active=1
      state = slotReducer(state, { type: 'ADVANCE', next: d }); // active=0
      expect(state.active).toBe(0);
      expect(state.s0).toBe(d);
      expect(state.s1).toBe(c);
    });
  });

  describe('RESET', () => {
    it('replaces both slots and sets active to 0', () => {
      const state: SlotState = { active: 1, s0: a, s1: b };
      const next = slotReducer(state, { type: 'RESET', s0: c, s1: d });
      expect(next).toEqual({ active: 0, s0: c, s1: d });
    });
  });

  describe('PATCH_FAV', () => {
    it('patches isFavorite on the slot whose path matches', () => {
      const next = slotReducer(initial, { type: 'PATCH_FAV', path: 'a.jpg', isFavorite: true });
      expect(next.s0.isFavorite).toBe(true);
      expect(next.s1.isFavorite).toBe(false);
      expect(next.active).toBe(0); // unchanged
    });

    it('patches both slots when both reference the same path', () => {
      const state: SlotState = { active: 0, s0: a, s1: a };
      const next = slotReducer(state, { type: 'PATCH_FAV', path: 'a.jpg', isFavorite: true });
      expect(next.s0.isFavorite).toBe(true);
      expect(next.s1.isFavorite).toBe(true);
    });

    it('does not mutate the original state objects', () => {
      const state: SlotState = { active: 0, s0: a, s1: b };
      slotReducer(state, { type: 'PATCH_FAV', path: 'a.jpg', isFavorite: true });
      expect(state.s0.isFavorite).toBe(false);
      expect(a.isFavorite).toBe(false);
    });

    it('returns equivalent state when no slot matches', () => {
      const next = slotReducer(initial, { type: 'PATCH_FAV', path: 'never.jpg', isFavorite: true });
      expect(next.s0.isFavorite).toBe(false);
      expect(next.s1.isFavorite).toBe(false);
    });
  });
});
