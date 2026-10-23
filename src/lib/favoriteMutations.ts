/**
 * Variable shapes of the favorite-toggle mutations, plus guards for reading
 * them back out of `useMutationState`.
 *
 * `useMutationState` filters by mutation key, so its `select` callback sees
 * every matching mutation's `state.variables` as `unknown` — TanStack can't
 * know which `useMutation` call produced them. The guards narrow that back to
 * the shape the owning `mutationFn` declares instead of asserting it.
 */

/** Variables of the `['toggle-object-favorite']` mutation (ObjectCard). */
export interface ObjectFavoriteVars {
  objectId: string;
  next: boolean;
}

/** Variables of the `['toggle-image-favorite']` mutation (image grids). */
export interface ImageFavoriteVars {
  imagePath: string;
  isFavorite: boolean;
}

export function isObjectFavoriteVars(v: unknown): v is ObjectFavoriteVars {
  return typeof v === 'object' && v !== null
    && 'objectId' in v && typeof v.objectId === 'string'
    && 'next' in v && typeof v.next === 'boolean';
}

export function isImageFavoriteVars(v: unknown): v is ImageFavoriteVars {
  return typeof v === 'object' && v !== null
    && 'imagePath' in v && typeof v.imagePath === 'string'
    && 'isFavorite' in v && typeof v.isFavorite === 'boolean';
}
