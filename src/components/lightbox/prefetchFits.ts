import type { QueryClient } from '@tanstack/react-query';
import { fetchBinary } from '../../lib/api/client';
import { getLibraryFitsHeaders } from '../../lib/api/library';
import { parseFits, warmFitsForView } from '../../lib/fits';

/** How long a parsed frame stays in memory once nothing is showing it. A frame is tens of megabytes decoded (a raw one
 *  holds its debayered planes too), so stepping through a night must not keep every frame for the default five minutes. */
export const FITS_GC_MS = 90_000;

/**
 * The pixel size of a FITS frame, read from its header (a few KB, nothing like the frame itself). The viewer needs it to
 * lay out a preview exactly as the real frame will sit, so the neighbours' sizes are fetched ahead under the same key.
 */
export function fitsFrameSizeQuery(filePath: string) {
  return {
    queryKey: ['fits-dims', filePath] as const,
    queryFn: async () => {
      const { values } = await getLibraryFitsHeaders(filePath);
      const width = Number(values.NAXIS1);
      const height = Number(values.NAXIS2);
      if (!(width > 0 && height > 0)) throw new Error('The header has no frame size');
      return { width, height };
    },
    staleTime: Infinity,
    retry: false,
  };
}

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
