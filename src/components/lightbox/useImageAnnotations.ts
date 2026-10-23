import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, skipToken } from '@tanstack/react-query';
import {
  getAnnotations, installPlateSolver, startAnnotationSolve, type AnnotationData,
} from '../../lib/api/annotate';

const POLL_MS = 1500;
const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * Annotation data for one image, kept fresh while a solve or the solver install
 * is in flight.
 *
 * The first answer is always immediate (approximate, or a cached solve). When
 * the plate solver is installed and the image is not yet solved, a background
 * solve is requested once per path and the query polls until it lands, so the
 * rings quietly move from "approximate" to "solved". A failed solve is not
 * retried automatically: that would loop on a frame with too few stars.
 */
export function useImageAnnotations(path: string | null | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  const key = ['annotations', path] as const;

  const query = useQuery<AnnotationData>({
    queryKey: key,
    queryFn: path ? () => getAnnotations(path) : skipToken,
    enabled: enabled && !!path,
    staleTime: 30_000,
    refetchInterval: q => {
      const d = q.state.data;
      if (!d) return false;
      const installing = d.solver.state === 'downloading' || d.solver.state === 'extracting';
      return d.solve.state === 'running' || installing ? POLL_MS : false;
    },
  });
  const data = query.data;

  const solveMutation = useMutation({
    mutationFn: (p: string) => startAnnotationSolve(p),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  // One automatic solve request per path per mount of this hook.
  const requested = useRef<Set<string>>(new Set());
  const { mutate: requestSolve } = solveMutation;
  useEffect(() => {
    if (!enabled || !path || !data) return;
    if (!data.solver.ready || data.quality === 'solved') return;
    if (data.solve.state !== 'idle' || requested.current.has(path)) return;
    requested.current.add(path);
    requestSolve(path);
  }, [enabled, path, data, requestSolve]);

  const installMutation = useMutation({
    mutationFn: installPlateSolver,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  // Which ring's details card is open. Keyed by path so stepping to another
  // image closes it instead of carrying a stale pick onto a different frame.
  const [selection, setSelection] = useState<{ path: string | null; id: string | null }>({ path: null, id: null });
  const selectedId = enabled && selection.path === (path ?? null) ? selection.id : null;
  const select = useCallback(
    (id: string | null) => setSelection({ path: path ?? null, id }),
    [path],
  );

  // Rings the viewer unchecked in the panel. Keyed by path, like the selection,
  // so a choice never carries onto a different frame.
  const [hiddenState, setHiddenState] = useState<{ path: string | null; ids: ReadonlySet<string> }>({ path: null, ids: new Set() });
  const hiddenIds: ReadonlySet<string> = hiddenState.path === (path ?? null) ? hiddenState.ids : EMPTY_IDS;
  const setShown = useCallback((id: string, on: boolean) => {
    setHiddenState(prev => {
      const ids = new Set(prev.path === (path ?? null) ? prev.ids : []);
      if (on) ids.delete(id); else ids.add(id);
      return { path: path ?? null, ids };
    });
    if (!on) setSelection(prev => (prev.id === id ? { path: prev.path, id: null } : prev));
  }, [path]);
  const setAllShown = useCallback((on: boolean) => {
    setHiddenState({ path: path ?? null, ids: on ? new Set() : new Set(data?.annotations.map(a => a.id) ?? []) });
    if (!on) setSelection({ path: path ?? null, id: null });
  }, [path, data]);

  /** What gets drawn and burned into exports: everything found except what was unchecked. */
  const visibleData = useMemo(
    () => (data && hiddenIds.size > 0 ? { ...data, annotations: data.annotations.filter(a => !hiddenIds.has(a.id)) } : data),
    [data, hiddenIds],
  );

  const retrySolve = useCallback(() => {
    if (!path) return;
    requested.current.add(path);
    requestSolve(path);
  }, [path, requestSolve]);

  return {
    data,
    visibleData,
    hiddenIds,
    setShown,
    setAllShown,
    isLoading: query.isLoading,
    error: query.error,
    install: installMutation.mutate,
    installPending: installMutation.isPending,
    retrySolve,
    selectedId,
    select,
  };
}
