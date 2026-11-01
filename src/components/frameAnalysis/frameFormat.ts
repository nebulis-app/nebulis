import { Cloud, Spline, Aperture, Plane, MoonStar, AudioWaveform, EyeOff, Droplets } from 'lucide-react';
import { formatNumber } from '../../lib/formatLocale';
import type { FrameFlag, FrameGrade, FrameMetrics, FrameReason, FrameVerdict } from '../../lib/api/frameAnalysis';

export type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export const FLAG_ORDER: FrameFlag[] = ['clouds', 'faint', 'trails', 'soft', 'streak', 'spots', 'noStars', 'noisy'];

export const FLAG_ICONS: Record<FrameFlag, typeof Cloud> = {
  clouds: Cloud,
  faint: EyeOff,
  spots: Droplets,
  trails: Spline,
  soft: Aperture,
  streak: Plane,
  noStars: MoonStar,
  noisy: AudioWaveform,
};

export const n1 = (v: number): string => formatNumber(v, { maximumFractionDigits: 1 });
export const n0 = (v: number): string => formatNumber(v, { maximumFractionDigits: 0 });

export const BASE = 'observationDetail.frameAnalysisModal';

/** One plain sentence for a finding, with the numbers behind it. `t` must be bound to the `observations` namespace. */
export function reasonText(t: TFunc, r: FrameReason): string {
  const base = `${BASE}.reasons`;
  switch (r.flag) {
    case 'noStars':
      return t(`${base}.noStars`, { stars: n0(r.stars), typical: n0(r.typical) });
    case 'clouds': {
      const sentence = r.percentDimmer != null
        ? t(`${base}.cloudsDimmer`, { percent: n0(r.percentDimmer) })
        : t(`${base}.clouds`, { stars: n0(r.stars), typical: n0(r.typical), percent: n0(r.percentFewer) });
      return r.brighterSky ? `${sentence} ${t(`${base}.cloudsBrighter`)}` : sentence;
    }
    case 'trails': {
      const kind = r.plain ? 'trailsPlain' : 'trailsSlight';
      return r.angle === null
        ? t(`${base}.${kind}`, { ratio: n1(r.ratio) })
        : t(`${base}.${kind}Angle`, { ratio: n1(r.ratio), angle: n0(r.angle) });
    }
    case 'soft':
      return t(`${base}.soft`, { fwhm: n1(r.fwhm), typical: n1(r.typical) });
    case 'streak':
      return t(`${base}.streak`, { angle: n0(r.angle) });
    case 'noisy':
      return t(`${base}.noisy`, { percent: n0(r.percentAbove) });
    case 'faint': {
      const sentence = r.targetPercent !== null
        ? t(`${base}.faintTarget`, { percent: n0(r.percent), target: n0(r.targetPercent) })
        : t(`${base}.faint`, { percent: n0(r.percent) });
      return r.brighterSky ? `${sentence} ${t(`${base}.faintBrighter`)}` : sentence;
    }
    case 'spots':
      return t(r.otherNights ? `${base}.spotsOtherNights` : `${base}.spotsThisNight`, { count: r.count });
  }
}

/**
 * What the Object value means for one frame. The value is the object's brighter part over the sky around it in
 * units of the sky's noise: under 1 it is lost in a single frame, and stacking N frames raises it by about √N, so
 * a faint frame also says how many like it would reach 3.
 */
export function targetLevelText(t: TFunc, snr: number): string {
  const base = 'observationDetail.frameList.targetLevel';
  const value = formatNumber(snr, { maximumFractionDigits: snr < 10 ? 1 : 0 });
  if (snr <= 0.05) return t(`${base}.none`, { value });
  if (snr < 1) return t(`${base}.faint`, { value, frames: n0(Math.ceil((3 / snr) ** 2)) });
  if (snr < 3) return t(`${base}.barely`, { value });
  if (snr <= 10) return t(`${base}.clear`, { value });
  return t(`${base}.plain`, { value });
}

export interface FrameRowData {
  path: string;
  name: string;
  thumbUrl: string | null;
  downloadUrl: string;
  metrics: FrameMetrics | null;
  verdict: FrameVerdict | null;
}


export function gradeColor(grade: FrameGrade, isDark: boolean): string {
  const c: Record<FrameGrade, string> = {
    good: isDark ? 'text-emerald-400' : 'text-emerald-600',
    fair: isDark ? 'text-amber-400' : 'text-amber-600',
    bad: isDark ? 'text-red-400' : 'text-red-600',
  };
  return c[grade];
}

