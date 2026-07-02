import { fetchJSON } from './client';

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
}

export type ByTypeStats = Record<ObjectClass, { imaged: number; total: number }>;

interface CatalogProgress {
  catalog: string;
  label: string;
  total: number;
  imagedCount: number;
  byType: ByTypeStats;
  objects: CatalogProgressObject[];
}

export const getCatalogProgress = (catalog: string) =>
  fetchJSON<CatalogProgress>(`/catalogs/${encodeURIComponent(catalog)}/progress`);
