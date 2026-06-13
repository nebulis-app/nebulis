/**
 * Library — favorites domain.
 *
 * Per-user toggles for "favorite object" and "favorite image" rows. Backed by
 * the `favorites` and `imageFavorites` tables; userId='' is the open-access
 * sentinel used when auth is disabled.
 */
import { stmts } from './objects.js';

// ─── Object favorites ───────────────────────────────────────────────────────

export function getFavorites(userId: string): string[] {
  return stmts.getAllFavorites.all(userId).map(r => r.objectId);
}

export function setFavorite(objectId: string, userId: string, favorite: boolean): void {
  if (favorite) {
    stmts.addFavorite.run(objectId, userId);
  } else {
    stmts.removeFavorite.run(objectId, userId);
  }
}

// ─── Image favorites ────────────────────────────────────────────────────────

export function getImageFavorites(userId: string): string[] {
  return stmts.getAllImageFavorites.all(userId).map(r => r.imagePath);
}

export function setImageFavorite(imagePath: string, userId: string, favorite: boolean): void {
  if (favorite) {
    stmts.addImageFavorite.run(imagePath, userId);
  } else {
    stmts.removeImageFavorite.run(imagePath, userId);
  }
}
