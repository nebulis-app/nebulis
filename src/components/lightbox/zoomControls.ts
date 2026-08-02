import { useCallback, useMemo, useState } from 'react';
import type { ZoomPan } from './useZoomPan';

/**
 * What the lightbox toolbar needs from whatever is doing the zooming.
 *
 * Two things implement this: `useZoomPan` for `<img>` content, and
 * `useFitsZoomControls` for the canvas `FitsViewer`. Both express zoom in
 * natural image pixels, so `zoomPercent` means the same thing in both and the
 * toolbar does not have to care which is mounted.
 */
export interface ZoomControls {
  zoomPercent: number;
  isFit: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  setFit: () => void;
  setActualSize: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

/** Multiplicative step, so a click feels the same at 20% and at 800%. */
const STEP = 1.25;

export function zoomControlsFromPan(zp: ZoomPan): ZoomControls {
  return {
    zoomPercent: zp.zoomPercent,
    isFit: zp.isFit,
    canZoomIn: zp.canZoomIn,
    canZoomOut: zp.canZoomOut,
    setFit: zp.setFit,
    setActualSize: zp.setActualSize,
    zoomIn: () => zp.zoomBy(STEP),
    zoomOut: () => zp.zoomBy(1 / STEP),
  };
}

/**
 * Zoom controls for `FitsViewer`, which owns its own canvas sizing.
 *
 * `FitsViewer` already scales its canvas as `fitsData.width * zoom`, so zoom 1
 * is genuinely 1:1 and no conversion is needed. It reports the fit scale back
 * through `onFitZoomComputed`, which is what makes a correct percentage
 * readout possible while in fit mode.
 */
export function useFitsZoomControls() {
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitZoom, setFitZoom] = useState(1);
  const [stretch, setStretch] = useState(0.5);

  const effective = zoom ?? fitZoom;

  const reset = useCallback(() => { setZoom(null); setStretch(0.5); }, []);

  const controls = useMemo<ZoomControls>(() => ({
    zoomPercent: Math.round(effective * 100),
    isFit: zoom === null,
    canZoomIn: effective < 16,
    canZoomOut: effective > 0.05,
    setFit: () => setZoom(null),
    setActualSize: () => setZoom(1),
    zoomIn: () => setZoom(Math.min(16, effective * STEP)),
    zoomOut: () => setZoom(Math.max(0.05, effective / STEP)),
  }), [effective, zoom]);

  return { controls, zoom, setZoom, setFitZoom, stretch, setStretch, reset };
}
