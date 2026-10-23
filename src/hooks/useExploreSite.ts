import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSites, getActiveSite, type ObservingSite } from '../lib/api/sites';

const STORAGE_KEY = 'nebulis-explore-site';

function readStored(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

/**
 * Which observing site Explore computes visibility for. Picking one here is a
 * view choice, not a settings change: it is remembered in this browser and
 * sent as `siteId` on every Explore call, and never touches the server's
 * active site (which the Planner and Forecast own). A stored id that no
 * longer exists falls back to the active site.
 */
export function useExploreSite() {
  const sitesQuery = useQuery({ queryKey: ['sites'], queryFn: getSites, staleTime: 60_000 });
  const activeQuery = useQuery({ queryKey: ['active-site'], queryFn: getActiveSite, staleTime: 60_000 });
  const [picked, setPicked] = useState<string | null>(readStored);

  const sites: ObservingSite[] = sitesQuery.data ?? [];
  const site = sites.find(s => s.id === picked) ?? activeQuery.data ?? null;
  const ready = sitesQuery.isSuccess && activeQuery.isSuccess;

  const setSiteId = useCallback((id: string) => {
    setPicked(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* private mode: the pick just won't persist */ }
  }, []);

  return {
    sites,
    site,
    /** Undefined until sites have loaded, so callers can hold their queries. */
    siteId: site?.id ?? null,
    ready,
    setSiteId,
  };
}
