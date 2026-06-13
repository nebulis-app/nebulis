import type { LibraryImage } from '../../lib/api/library';
import { assertNever } from '../../lib/utils';

export type SlotState = { active: 0 | 1; s0: LibraryImage; s1: LibraryImage };

export type SlotAction =
  | { type: 'ADVANCE'; next: LibraryImage }
  | { type: 'RESET'; s0: LibraryImage; s1: LibraryImage }
  | { type: 'PATCH_FAV'; path: string; isFavorite: boolean };

export function slotReducer(state: SlotState, action: SlotAction): SlotState {
  switch (action.type) {
    case 'ADVANCE': {
      // The INACTIVE slot receives the new image and becomes active in one dispatch.
      const next: 0 | 1 = state.active === 0 ? 1 : 0;
      return {
        active: next,
        s0: next === 0 ? action.next : state.s0,
        s1: next === 1 ? action.next : state.s1,
      };
    }
    case 'RESET':
      return { active: 0, s0: action.s0, s1: action.s1 };
    case 'PATCH_FAV': {
      const patch = (img: LibraryImage) =>
        img.path === action.path ? { ...img, isFavorite: action.isFavorite } : img;
      return { ...state, s0: patch(state.s0), s1: patch(state.s1) };
    }
    default:
      return assertNever(action);
  }
}
