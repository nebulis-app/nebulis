import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, skipToken } from '@tanstack/react-query';
import {
  getAnnotations, getSolarSystemAnnotations, installPlateSolver, startAnnotationSolve, type AnnotationData, type SolarSystemData,
} from '../../lib/api/annotate';

const POLL_MS = 1500;
const EMPTY_IDS: ReadonlySet<string> = new Set();

export type AnnotationLayer = 'notable' | 'solarSystem';
export type AnnotationLayers = Record<AnnotationLayer, boolean>;

/** Remembered per browser. Asteroids start off: turning them on is what asks the outside service. */
const LAYERS_KEY = 'nebulis_annotation_layers';
const DEFAULT_LAYERS: AnnotationLayers = { notable: true, solarSystem: false };

function readLayers(): AnnotationLayers {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      const r = raw as Partial<Record<AnnotationLayer, unknown>>;
      return {
        notable: typeof r.notable === 'boolean' ? r.notable : DEFAULT_LAYERS.notable,
        solarSystem: typeof r.solarSystem === 'boolean' ? r.solarSystem : DEFAULT_LAYERS.solarSystem,
      };
    }
  } catch { /* defaults */ }
  return DEFAULT_LAYERS;
}

function writeLayers(layers: AnnotationLayers): void {
  try { localStorage.setItem(LAYERS_KEY, JSON.stringify(layers)); } catch { /* not remembered */ }
}

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
  const base = query.data;

  // Layers: the built-in notable objects arrive with the rings; asteroids and comets are a second request, made only
  // while that layer is on and the positions are exact enough for points.
  const [layers, setLayersState] = useState<AnnotationLayers>(readLayers);
  const setLayer = useCallback((layer: AnnotationLayer, on: boolean) => {
    setLayersState(prev => {
      const next = { ...prev, [layer]: on };
      writeLayers(next);
      return next;
    });
  }, []);
  const exact = base?.quality === 'solved' || base?.quality === 'header';
  const solarQuery = useQuery<SolarSystemData>({
    queryKey: ['annotations-solar-system', path],
    queryFn: path ? () => getSolarSystemAnnotations(path) : skipToken,
    enabled: enabled && !!path && layers.solarSystem && exact,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const solarSystem = layers.solarSystem && exact ? solarQuery.data ?? null : null;

  /** The rings of every layer that is on: what the panel lists, the overlay draws and an export burns in. */
  const data = useMemo<AnnotationData | undefined>(() => {
    if (!base) return base;
    const own = layers.notable ? base.annotations : base.annotations.filter(a => a.layer !== 'notable');
    const extra = solarSystem?.annotations ?? [];
    return own === base.annotations && extra.length === 0 ? base : { ...base, annotations: [...own, ...extra] };
  }, [base, layers.notable, solarSystem]);

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
    layers,
    setLayer,
    /** The asteroid and comet lookup for this picture, while that layer is on and the picture is solved. */
    solarSystem,
    solarSystemLoading: layers.solarSystem && exact && solarQuery.isLoading,
    solarSystemError: layers.solarSystem && exact ? solarQuery.error : null,
    /** Notable objects in the frame, whether the layer is on or not, so the panel only offers the switch when it does something. */
    hasNotable: !!base?.annotations.some(a => a.layer === 'notable'),
    error: query.error,
    install: installMutation.mutate,
    installPending: installMutation.isPending,
    retrySolve,
    selectedId,
    select,
  };
}
