import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getActiveSite } from '../lib/api/sites';
import { windowPrefsOf, type ImagingWindowPrefs } from '../lib/imagingWindow';

/**
 * The active site's imaging window settings (src/lib/imagingWindow.ts), for components that work out "tonight"
 * for an object and are not themselves showing a particular site. The server falls back to the same site when a
 * request names none, so the browser and the server agree. Until the site loads this is the default window.
 */
export function useActiveWindowPrefs(): ImagingWindowPrefs {
  const { data: site } = useQuery({ queryKey: ['active-site'], queryFn: getActiveSite, staleTime: 60_000 });
  return useMemo(
    () => windowPrefsOf(site),
    [site?.darkness, site?.windowStartOffsetMin, site?.windowEndOffsetMin], // eslint-disable-line react-hooks/exhaustive-deps -- `site` itself changes identity on every refetch
  );
}
