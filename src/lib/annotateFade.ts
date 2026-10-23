import type { AnnotateQuality } from './api/annotate';

/**
 * An estimated position is only good to a few arcminutes (the telescope was not pointed exactly at its target).
 * That is invisible with the whole frame in view and a long way off once the picture is zoomed in, so past this
 * multiple of the fit zoom an estimate is faded. A real solution is exact at any zoom and is never faded.
 */
export const ESTIMATE_FADE_ZOOM_RATIO = 2;

export function fadesEstimate(quality: AnnotateQuality, zoomRatio: number): boolean {
  return quality === 'approximate' && zoomRatio > ESTIMATE_FADE_ZOOM_RATIO;
}

/** How far in the picture is, as a multiple of the zoom that fits it: 1 at fit. */
export function zoomRatio(zoom: number, fitZoom: number): number {
  return fitZoom > 0 ? zoom / fitZoom : 1;
}
