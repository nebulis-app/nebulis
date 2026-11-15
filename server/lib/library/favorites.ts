/**
 * Library — favorites domain.
 *
 * Per-user toggles for "favorite object" and "favorite image" rows. Backed by
 * the `favorites` and `imageFavorites` tables; userId='' is the open-access
 * sentinel used when auth is disabled.
 */
import db from '../db.js';
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

/**
 * A favorite belongs to a picture, but it is stored under the file's path. When the file moves or is replaced
 * (marked as processed, sent back to a night's images, saved over in the editor) every user's favorite follows it
 * to the new path, so the star does not vanish with the old name. A user who already favorited the new path keeps
 * that one; the old rows are dropped either way.
 */
export function moveImageFavorites(oldPath: string, newPath: string): void {
  if (oldPath === newPath) return;
  db.transaction(() => {
    stmts.moveImageFavorites.run(newPath, oldPath);
    stmts.deleteImageFavoritesAt.run(oldPath);
  })();
}

/** Forget the favorites on a file that has been deleted, so a later file reusing the path does not inherit a star. */
export function dropImageFavorites(imagePath: string): void {
  stmts.deleteImageFavoritesAt.run(imagePath);
}
