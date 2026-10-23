import { fetchJSON } from './client';
import type { WallOverrides, WallSpan } from '../catalogWallOverrides';
export type { WallSpan } from '../catalogWallOverrides';

export type ObjectClass = 'galaxy' | 'nebula' | 'cluster' | 'other';

export interface CatalogProgressObject {
  number: number | null;
  id: string;
  ngcName: string | null;
  name: string;
  type: string;
  typeClass: ObjectClass;
  constellation: string | null;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  ra: number | null;
  dec: number | null;
  isImaged: boolean;
  libraryObjectId: string | null;
  sessionCount: number;
  /** Set when the object was not imaged itself but sits inside the frame of one
   *  that was (M43 when M42 was shot). `libraryObjectId` is then the host's. */
  imagedVia: Array<{ objectId: string; name: string; sepDeg: number }> | null;
}

export type ByTypeStats = Record<ObjectClass, { imaged: number; total: number }>;

interface CatalogProgress {
  catalog: string;
  label: string;
  total: number;
  imagedCount: number;
  /** Part of imagedCount credited through another object's frame. */
  imagedInFrameCount: number;
  byType: ByTypeStats;
  objects: CatalogProgressObject[];
}

export const getCatalogProgress = (catalog: string) =>
  fetchJSON<CatalogProgress>(`/catalogs/${encodeURIComponent(catalog)}/progress`);

export interface WallImage {
  /** Library-relative path, served by `/library/file/thumbnail`. */
  path: string;
  kind: 'processed' | 'telescope';
  aspect: number;
}

export interface WallTile {
  id: string;
  number: number | null;
  name: string;
  typeClass: ObjectClass;
  majorAxisArcmin: number | null;
  libraryObjectId: string | null;
  /** True when the tile shows the user's own picture; false renders a number cell. */
  imaged: boolean;
  /** Imaged only through another object's frame. */
  inFrame: boolean;
  /** Other catalog ids sharing this tile's frame ("M42 · M43"). */
  mergedIds: string[];
  image: WallImage | null;
  span: WallSpan;
  lastSessionDate: string | null;
  sessionCount: number;
}

export interface CatalogWall {
  catalog: string;
  label: string;
  total: number;
  imagedCount: number;
  tiles: WallTile[];
  /** The user's saved edits, keyed by tile id. */
  overrides: WallOverrides;
}

export const getCatalogWall = (catalog: string) =>
  fetchJSON<CatalogWall>(`/catalogs/${encodeURIComponent(catalog)}/wall`);

export interface WallImageChoice { path: string; kind: 'processed' | 'telescope'; label: string; aspect: number }

/** The object's own pictures a tile could show (processed first). */
export const getWallImageChoices = (objectId: string) =>
  fetchJSON<{ images: WallImageChoice[] }>(`/catalogs/wall/images/${encodeURIComponent(objectId)}`)
    .then(r => r.images);

/** Save a whole edit session: `set` replaces those tiles' edits, `clear` removes them. */
export const saveWallOverrides = (catalog: string, body: { set: WallOverrides; clear: string[] }) =>
  fetchJSON<{ overrides: WallOverrides }>(`/catalogs/${encodeURIComponent(catalog)}/wall/overrides`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const resetWallOverrides = (catalog: string) =>
  fetchJSON<{ overrides: WallOverrides }>(`/catalogs/${encodeURIComponent(catalog)}/wall/overrides`, {
    method: 'DELETE',
  });
