import type { QueryClient } from '@tanstack/react-query';
import { fetchBinary } from '../../lib/api/client';
import { parseFits, warmFitsForView } from '../../lib/fits';

/** How long a parsed frame stays in memory once nothing is showing it. A frame is tens of megabytes decoded (a raw one
 *  holds its debayered planes too), so stepping through a night must not keep every frame for the default five minutes. */
export const FITS_GC_MS = 90_000;

/**
 * Loads, parses and prepares the frames next to the one on screen, under the same cache key the viewer reads, so
 * stepping to a neighbour finds it ready. Fire and forget: a failure here only means the viewer loads it itself.
 */
export function prefetchFits(queryClient: QueryClient, urls: string[], stretch: number) {
  for (const url of urls) {
    void queryClient
      .prefetchQuery({
        queryKey: ['fits-binary', url],
        queryFn: async ({ signal }) => parseFits(await fetchBinary(url, signal)),
        staleTime: Infinity,
        gcTime: FITS_GC_MS,
        retry: false,
      })
      .then(() => {
        const data = queryClient.getQueryData<ReturnType<typeof parseFits>>(['fits-binary', url]);
        if (data) warmFitsForView(data, stretch);
      });
  }
}
