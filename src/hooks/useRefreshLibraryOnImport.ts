import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ImportStatus } from '../lib/api/library';

/** Every query whose answer changes when files land in the library. */
export const LIBRARY_QUERY_KEYS = [
  'library-objects',
  'library-object-filters',
  'library-sessions',
  'library-storage',
  'all-library-images',
  'gallery-image',
  'observations',
  'observation',
  'observation-files',
  'processedImages',
  'processed-images-all',
  'all-processed-images',
  'stacked-images',
  'object-media',
  'wall-image-choices',
] as const;

/**
 * Refreshes the library views when an import finishes.
 *
 * The client keeps server data for 30 s and never refetches on focus (a refetch triggers a full server walk), so after a
 * first import the Library and Gallery kept showing "empty" until the user navigated away and back. A run is noticed by
 * `running` going from true to false, or by `lastRun` moving, which catches a short import that began and ended between
 * two 15 s polls.
 */
export function useRefreshLibraryOnImport(status: ImportStatus | undefined): void {
  const queryClient = useQueryClient();
  const previous = useRef<{ running: boolean; lastRun: string | null } | null>(null);

  useEffect(() => {
    if (!status) return;
    const before = previous.current;
    previous.current = { running: status.running, lastRun: status.lastRun };
    if (!before) return;
    const finished = before.running && !status.running;
    const newRun = !status.running && status.lastRun !== null && status.lastRun !== before.lastRun;
    if (!finished && !newRun) return;
    for (const key of LIBRARY_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
  }, [status, queryClient]);
}
