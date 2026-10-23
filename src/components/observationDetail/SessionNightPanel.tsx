/**
 * The sky on the night of a session, for the hero: the object's altitude over
 * that night with the stretch you were imaging shaded, and the two things that
 * most often explain how the night went, cloud and Moon.
 *
 * Glass over the hero, which is dark in every theme, like the object hero's
 * Tonight panel. The Details section below keeps the full weather table; this
 * is the part worth seeing next to the title.
 */
import { useTranslation } from 'react-i18next';
import { Telescope } from 'lucide-react';
import { AltitudeChart } from '../AltitudeChart';
import { cloudVerdict } from '../../lib/cloudVerdict';
import { useTheme } from '../../hooks/useTheme';

interface Props {
  /** Decimal hours. */
  raHours: number;
  /** Decimal degrees. */
  decDegrees: number;
  lat: number;
  lon: number;
  /** When the first frame was taken. Picks the night. */
  start: Date;
  /** The stretches the synced subframes show the telescope was actually
   *  capturing. Null when there are none to read, and the shading falls back
   *  to the span from `start` to `end`. */
  captureSpans: { start: Date; end: Date }[] | null;
  /** When the last frame was. Null when the session is a single moment. */
  end: Date | null;
  /** Already formatted "20:14 - 23:41". */
  timeRange: string | null;
  cloudCover: number | null | undefined;
  moonIllumination: number | null | undefined;
  minAlt?: number;
  /** Offered when no subframes are synced, so the capture time can only be
   *  guessed. Opens the Subframes tab. */
  onSyncSubframes?: (() => void) | null;
}

export function SessionNightPanel({
  raHours, decDegrees, lat, lon, start, end, captureSpans, timeRange, cloudCover, moonIllumination, minAlt = 20, onSyncSubframes,
}: Props) {
  const { t } = useTranslation('observations');
  const { isNight } = useTheme();

  // Mid-session is the fairest single moment to quote an altitude at.
  const focusAt = end && end > start ? new Date((start.getTime() + end.getTime()) / 2) : start;
  const verdict = cloudCover != null ? cloudVerdict(cloudCover, t, isNight) : null;

  return (
    <section className="rounded-2xl bg-slate-950/55 p-4 ring-1 ring-inset ring-white/10 backdrop-blur-md">
      <div className="mb-3 flex items-center gap-2">
        <Telescope className="h-4 w-4 shrink-0 text-white/50" />
        <h2 className="font-display text-[0.875rem] font-semibold tracking-tight text-white">
          {t('observationDetail.nightPanel.title')}
        </h2>
      </div>

      <AltitudeChart
        ra={raHours}
        dec={decDegrees}
        lat={lat}
        lon={lon}
        minAlt={minAlt}
        moonIllumination={moonIllumination ?? undefined}
        at={start}
        focusAt={focusAt}
        highlights={captureSpans ?? (end && end > start ? [{ start, end }] : undefined)}
        highlightTone={captureSpans ? 'green' : 'amber'}
        isDark
        viewWidth={380}
        viewHeight={96}
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.75rem] text-white/65">
        {timeRange && (
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <span className={`h-2 w-2 rounded-sm ${captureSpans ? 'bg-emerald-400/70' : 'bg-amber-400/70'}`} aria-hidden="true" />
            {t('observationDetail.nightPanel.imaged', { range: timeRange })}
          </span>
        )}
        {verdict && cloudCover != null && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: verdict.hex }} aria-hidden="true" />
            {t('observationDetail.nightPanel.cloud', { label: verdict.label, percent: Math.round(cloudCover) })}
          </span>
        )}
        {moonIllumination != null && (
          <span className="tabular-nums">
            {t('observationDetail.nightPanel.moon', { percent: Math.round(moonIllumination) })}
          </span>
        )}
      </div>
      {!captureSpans && onSyncSubframes && (
        <button
          type="button"
          onClick={onSyncSubframes}
          className="mt-2 text-[0.75rem] font-medium text-amber-300/90 transition hover:text-amber-200 hover:underline"
        >
          {t('observationDetail.nightPanel.syncHint')}
        </button>
      )}
    </section>
  );
}
