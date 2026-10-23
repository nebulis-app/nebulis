import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelSubframesArchive,
  getSubframesArchiveStatus,
  getSubframesArchiveTmpUrl,
  type SubframesArchiveStatus,
} from '../lib/api/library';

export type ArchiveJobPhase = 'idle' | 'running' | 'done' | 'error';

/**
 * Drives one server-side ZIP job (start → poll every 500 ms → download), the
 * flow the sub-frame download and the stacking export share. Unmounting or
 * cancelling stops the build on the server, not just the poll.
 */
export function useArchiveJob() {
  const [phase, setPhase] = useState<ArchiveJobPhase>('idle');
  const [status, setStatus] = useState<SubframesArchiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    stop();
    const id = jobIdRef.current;
    jobIdRef.current = null;
    if (id) void cancelSubframesArchive(id).catch(() => {});
    setPhase('idle');
    setStatus(null);
  }, [stop]);

  useEffect(() => () => {
    stop();
    const id = jobIdRef.current;
    if (id) void cancelSubframesArchive(id).catch(() => {});
  }, [stop]);

  const poll = useCallback(async (jobId: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const s = await getSubframesArchiveStatus(jobId);
      if (jobIdRef.current !== jobId) return;
      setStatus(s);
      if (s.status === 'done' && s.token) {
        stop();
        jobIdRef.current = null;
        setPhase('done');
        const a = document.createElement('a');
        a.href = getSubframesArchiveTmpUrl(s.token);
        a.click();
      } else if (s.status === 'error' || s.status === 'cancelled') {
        stop();
        jobIdRef.current = null;
        setError(s.error ?? null);
        setPhase(s.status === 'error' ? 'error' : 'idle');
      }
    } catch {
      // A network hiccup: keep polling.
    } finally {
      inFlightRef.current = false;
    }
  }, [stop]);

  const start = useCallback(async (begin: () => Promise<{ jobId: string; filesTotal: number }>) => {
    setError(null);
    setPhase('running');
    setStatus(null);
    try {
      const { jobId, filesTotal } = await begin();
      jobIdRef.current = jobId;
      setStatus({ status: 'running', filesTotal, filesDone: 0, elapsedMs: 0 });
      timerRef.current = setInterval(() => void poll(jobId), 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : null);
      setPhase('error');
    }
  }, [poll]);

  return { phase, status, error, start, cancel };
}
