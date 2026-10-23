/**
 * Which telescope shot this session, with an admin popover to reassign it.
 *
 * Styled for the session hero, which is dark imagery in every theme, so it
 * takes the glass treatment the Catalogs panels use rather than branching on
 * isDark. The reassign popover is the one part that drops back onto a solid
 * surface: a translucent menu over a photograph is unreadable.
 */
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Pencil, Wand2 } from 'lucide-react';
import { reassignSessionTelescope, setSessionOptics } from '../../lib/api/telescopes';
import type { SessionOptics } from '../../types';
import { opticsLabel, formatFocal } from '../../lib/rigLabel';
import type { TelescopeProfile } from '../../lib/api/telescopes';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useTheme } from '../../hooks/useTheme';
import { nightSafeColor } from '../../lib/nightSafeColor';

export function TelescopeChip({
  objectId,
  date,
  telescope,
  telescopes,
  isAdmin,
  optics,
}: {
  objectId: string;
  date: string;
  telescope: TelescopeProfile;
  telescopes: TelescopeProfile[];
  isAdmin: boolean;
  /** Optical train of the night (see sessionOptics.ts); shown after the
   *  telescope name and picked in the same popover. */
  optics?: SessionOptics;
}) {
  const { t } = useTranslation('observations');
  const { isNight } = useTheme();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useClickOutside(wrapRef, () => setOpen(false), { enabled: open, closeOnEscape: true });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['observation', objectId, date] });
    queryClient.invalidateQueries({ queryKey: ['observations'] });
    queryClient.invalidateQueries({ queryKey: ['library-sessions', objectId] });
  };
  const reassign = useMutation({
    mutationFn: (newTelescopeId: string) => reassignSessionTelescope(objectId, date, newTelescopeId),
    onSuccess: () => {
      setOpen(false);
      refresh();
      queryClient.invalidateQueries({ queryKey: ['telescopes'] });
    },
  });
  const pickOptics = useMutation({
    mutationFn: (configId: string | null) => setSessionOptics(objectId, date, configId),
    onSuccess: () => {
      setOpen(false);
      refresh();
    },
  });
  const train = opticsLabel(optics);
  const configs = telescope.opticalConfigs ?? [];
  const chosen = optics?.source === 'manual' ? optics.configId : null;
  // What "automatic" resolves to, shown next to it so the user knows what
  // clearing a choice gives back.
  const autoHint = optics?.fileFocalMm != null
    ? t('observationDetail.telescopeChip.opticsAutoFits', { focal: formatFocal(optics.fileFocalMm) })
    : configs.length === 1
      ? configs[0]!.name
      : t('observationDetail.telescopeChip.opticsAutoNone');

  return (
    <span ref={wrapRef} className="relative inline-flex items-center">
      <Link
        to={`/observations?telescopeId=${encodeURIComponent(telescope.id)}`}
        className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-2.5 py-1
          text-[0.7188rem] font-medium text-white/80 ring-1 ring-inset ring-white/15 backdrop-blur-md
          transition-colors hover:bg-white/15 hover:text-white
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        title={t('observationDetail.telescopeChip.capturedOn', { name: telescope.name })}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: nightSafeColor(telescope.color, isNight) }}
          aria-hidden="true"
        />
        {telescope.name}
        {train && (
          <span
            className="text-white/55"
            title={optics?.source ? t(`observationDetail.telescopeChip.opticsSource.${optics.source}`) : undefined}
          >
            · {train}
          </span>
        )}
      </Link>

      {isAdmin && (
        <button
          onClick={() => setOpen(o => !o)}
          className="ml-1 rounded-md p-1 text-white/40 transition hover:bg-white/10 hover:text-white
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          title={t('observationDetail.telescopeChip.reassignTitle')}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-56 rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl">
          <div className="px-2 py-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-500">
            {t('observationDetail.telescopeChip.reassignTo')}
          </div>
          {telescopes.map((scope, i) => (
            <button
              key={scope.id}
              onClick={() => reassign.mutate(scope.id)}
              disabled={reassign.isPending || scope.id === telescope.id}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs
                text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: nightSafeColor(scope.color, isNight, i) }} />
              <span className="flex-1 truncate">{scope.name}</span>
              {scope.id === telescope.id && <CheckCircle2 className="h-3 w-3 text-teal-500" />}
            </button>
          ))}
          {configs.length > 0 && (
            <>
              <div className="mt-2 border-t border-slate-800 px-2 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-500">
                {t('observationDetail.telescopeChip.opticsTitle')}
              </div>
              <button
                onClick={() => pickOptics.mutate(null)}
                disabled={pickOptics.isPending || chosen === null}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs
                  text-slate-300 transition hover:bg-slate-800 disabled:opacity-60"
              >
                <Wand2 className="h-3 w-3 shrink-0 text-slate-500" />
                <span className="flex-1 truncate">
                  {t('observationDetail.telescopeChip.opticsAuto')}
                  <span className="ml-1 text-slate-500">({autoHint})</span>
                </span>
                {chosen === null && <CheckCircle2 className="h-3 w-3 text-teal-500" />}
              </button>
              {configs.map(c => (
                <button
                  key={c.id}
                  onClick={() => pickOptics.mutate(c.id)}
                  disabled={pickOptics.isPending || chosen === c.id}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs
                    text-slate-300 transition hover:bg-slate-800 disabled:opacity-60"
                >
                  <span className="w-3 shrink-0" />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">{formatFocal(c.focalLengthMm)}</span>
                  {chosen === c.id && <CheckCircle2 className="h-3 w-3 text-teal-500" />}
                </button>
              ))}
            </>
          )}
          {(reassign.isError || pickOptics.isError) && (
            <div className="mt-1 px-2 py-1 text-[0.6875rem] text-red-400">{t('observationDetail.telescopeChip.reassignFailed')}</div>
          )}
        </div>
      )}
    </span>
  );
}
