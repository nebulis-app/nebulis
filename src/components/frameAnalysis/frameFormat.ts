import { Cloud, Spline, Aperture, Plane, MoonStar, AudioWaveform } from 'lucide-react';
import { formatNumber } from '../../lib/formatLocale';
import type { FrameFlag, FrameGrade, FrameMetrics, FrameReason, FrameVerdict } from '../../lib/api/frameAnalysis';

export type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export const FLAG_ORDER: FrameFlag[] = ['clouds', 'trails', 'soft', 'streak', 'noStars', 'noisy'];

export const FLAG_ICONS: Record<FrameFlag, typeof Cloud> = {
  clouds: Cloud,
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
      const sentence = t(`${base}.clouds`, { stars: n0(r.stars), typical: n0(r.typical), percent: n0(r.percentFewer) });
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
  }
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

