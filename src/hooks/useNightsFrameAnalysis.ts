import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { getFrameAnalysis, queueFrameMeasuring, type FrameAnalysisReport } from '../lib/api/frameAnalysis';

export interface NightsFrameAnalysis {
  /** Every night's report has loaded. */
  loaded: boolean;
  /** Nights with raw frames that have no analysis yet and are not being measured. */
  unmeasuredNights: string[];
  /** Frames still to measure across those nights. */
  unmeasuredFrames: number;
  /** The server is measuring frames of at least one night. */
  measuring: boolean;
  done: number;
  total: number;
}

/**
 * Frame Analysis state of several nights at once, for the stacking export: which nights still need measuring (an
 * unmeasured frame counts as kept, so the keep / reject decisions only mean something once a night is measured),
 * how far the server's background worker has got, and `measure()` to queue the missing frames.
 * Shares the `['frame-analysis', objectId, night, false]` cache with the night's frame list. Calls `onSettled` when
 * the worker finishes, so the caller can rebuild whatever depends on the grades.
 */
export function useNightsFrameAnalysis(objectId: string, nights: string[], onSettled?: () => void) {
  const queryClient = useQueryClient();
  const results = useQueries({
    queries: nights.map(night => ({
      queryKey: ['frame-analysis', objectId, night, false],
      queryFn: ({ signal }: { signal: AbortSignal }) => getFrameAnalysis(objectId, night, { signal }),
      refetchInterval: (q: { state: { data?: FrameAnalysisReport } }) => ((q.state.data?.pending ?? 0) > 0 ? 1500 : false),
    })),
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = useMemo<NightsFrameAnalysis>(() => {
    const unmeasuredNights: string[] = [];
    let unmeasuredFrames = 0;
    let measuring = false;
    let done = 0;
    let total = 0;
    results.forEach((r, i) => {
      const report = r.data;
      if (!report) return;
      const missing = report.total - report.measured - Object.keys(report.failures).length;
      if (report.pending > 0) {
        measuring = true;
        done += report.measured;
        total += report.total;
      } else if (missing > 0) {
        unmeasuredNights.push(nights[i]);
        unmeasuredFrames += missing;
      }
    });
    return { loaded: results.every(r => !!r.data), unmeasuredNights, unmeasuredFrames, measuring, done, total };
  }, [results, nights]);

  // Fire onSettled on the running -> finished transition only.
  const wasMeasuring = useRef(false);
  useEffect(() => {
    if (wasMeasuring.current && !state.measuring) onSettled?.();
    wasMeasuring.current = state.measuring;
  }, [state.measuring, onSettled]);

  const measure = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      for (const night of state.unmeasuredNights) await queueFrameMeasuring(objectId, night);
      await Promise.all(state.unmeasuredNights.map(night =>
        queryClient.invalidateQueries({ queryKey: ['frame-analysis', objectId, night, false] })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [objectId, queryClient, state.unmeasuredNights]);

  return { ...state, starting, error, measure };
}
