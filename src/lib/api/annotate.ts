import { fetchJSON } from './client';

/** Mirrors AnnotateQuality in server/lib/annotate/annotateService.ts. */
export type AnnotateQuality = 'solved' | 'header' | 'approximate' | 'unavailable';

export interface FrameAnnotation {
  id: string;
  label: string;
  designation: string | null;
  typeCode: string;
  type: string;
  magnitude: number | null;
  /** Centre and draw radius, in pixels of the `imageWidth` x `imageHeight` grid. */
  x: number;
  y: number;
  r: number;
  rTrue: number;
  /** Bigger than a ring may be on this frame: the ring marks a region. */
  oversized: boolean;
  isTarget: boolean;
}

export interface SolverStatus {
  supported: boolean;
  binaryInstalled: boolean;
  dbInstalled: boolean;
  ready: boolean;
  state: 'idle' | 'downloading' | 'extracting' | 'error';
  step: string | null;
  progress: number;
  error: string | null;
}

export interface SolveJobState {
  state: 'idle' | 'running' | 'failed';
  message: string | null;
}

export type UnavailableReason = 'mosaic' | 'no-position' | 'unknown-field' | 'no-sky' | 'edited';

export interface AnnotationData {
  quality: AnnotateQuality;
  /** Set only when `quality` is 'unavailable'. */
  reason: UnavailableReason | null;
  imageWidth: number;
  imageHeight: number;
  pixelScaleArcsec: number | null;
  annotations: FrameAnnotation[];
  solver: SolverStatus;
  solve: SolveJobState;
}

const q = (path: string) => `path=${encodeURIComponent(path)}`;

export const getAnnotations = (path: string) =>
  fetchJSON<AnnotationData>(`/annotate?${q(path)}`);

export const startAnnotationSolve = (path: string) =>
  fetchJSON<SolveJobState>(`/annotate/solve?${q(path)}`, { method: 'POST' });

export const installPlateSolver = () =>
  fetchJSON<SolverStatus>('/annotate/solver/install', { method: 'POST' });
