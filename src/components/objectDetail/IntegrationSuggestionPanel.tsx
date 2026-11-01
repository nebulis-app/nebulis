import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '../../hooks/useTheme';
import { listTelescopes } from '../../lib/api/telescopes';
import {
  suggestIntegration,
  MOON_PLANS,
  GOAL_TIERS,
  MAX_TOTAL_HOURS,
  type GoalTier,
  type MoonPlan,
  type RigKit,
  type SuggestedFilter,
  type SuggestionRig,
} from '../../lib/integrationSuggestion';

const TELESCOPE_KEY = 'nebulis.integrationSuggest.telescope';

function readStored(key: string): string | null {
  try { return localStorage.getItem(key) || null; } catch { return null; }
}

function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* a remembered pick is a convenience only */ }
}

/**
 * What the suggestion needs to know about the object and the site. Kept as one
 * prop so the caller either has enough to suggest (a catalog type) or passes
 * nothing and the panel is not offered.
 */
export interface SuggestionTarget {
  objectType: string;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  /** Bortle class of the active observing site; null when not set. */
  bortleClass: number | null;
}

/**
 * Suggested goal hours for one object (`src/lib/integrationSuggestion.ts`,
 * explained in the private integration-goals notes). Rendering and the three
 * choices the model cannot know (rig, Moon plan, quality tier) only. It never
 * saves: Apply hands the hours to the goal editor, and Save stays the user's.
 */
export function IntegrationSuggestionPanel({
  target,
  defaultRig,
  onApply,
  onClose,
}: {
  target: SuggestionTarget;
  defaultRig: SuggestionRig;
  onApply: (filters: SuggestedFilter[]) => void;
  onClose: () => void;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('library');
  const [pickedRig, setRig] = useState<SuggestionRig>(defaultRig);
  const [moon, setMoon] = useState<MoonPlan>('mixed');
  const [tier, setTier] = useState<GoalTier>('standard');

  const { data: allTelescopes = [] } = useQuery({
    queryKey: ['telescopes'],
    queryFn: listTelescopes,
    staleTime: 5 * 60 * 1000,
  });
  const telescopes = useMemo(() => allTelescopes.filter(tel => tel.archivedAt === null), [allTelescopes]);
  // A remembered pick that no longer exists, or none with several telescopes, means "not specified"; a
  // single telescope is the obvious answer.
  const [pickedTelescope, setPickedTelescope] = useState<string | null>(() => readStored(TELESCOPE_KEY));
  const telescope = telescopes.find(tel => tel.id === pickedTelescope)
    ?? (telescopes.length === 1 ? telescopes[0] : undefined);

  // SeeStar and Dwarf are colour cameras with fixed hardware, so nothing is asked and the filter names come
  // from frames they have already shot. A custom rig (other, asiair) says for itself in Settings.
  const isSmart = telescope !== undefined && telescope.kind !== 'other' && telescope.kind !== 'asiair';
  const customRig = telescope && !isSmart ? telescope.rig : undefined;
  const rig: SuggestionRig = isSmart ? 'color' : customRig?.sensorType ?? pickedRig;
  const rigIsFixed = isSmart || !!customRig?.sensorType;
  const kit = useMemo<RigKit | null>(() => {
    if (!telescope) return null;
    return isSmart
      ? { filters: telescope.usedFilters ?? [], inventory: false }
      : { filters: customRig?.filters ?? [], inventory: true };
  }, [telescope, isSmart, customRig]);

  // The suggestion for every Moon plan and tier, so each choice can show what it costs before it is picked.
  const run = useMemo(() => (m: MoonPlan, q: GoalTier) => suggestIntegration({
    objectType: target.objectType,
    magnitude: target.magnitude,
    majorAxisArcmin: target.majorAxisArcmin,
    bortle: target.bortleClass,
    rig,
    kit,
    moon: m,
    tier: q,
  }), [target, rig, kit]);
  const suggestion = useMemo(() => run(moon, tier), [run, moon, tier]);

  const { basis } = suggestion;
  const p = 'objectDetail.integrationSection.suggest';
  const hoursHint = (s: ReturnType<typeof run>) =>
    t(s.basis.capped ? `${p}.chipHoursCapped` : `${p}.chipHours`, { hours: s.totalHours });
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  const strong = isDark ? 'text-slate-200' : 'text-slate-800';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-600';

  const brightnessName = t(`${p}.class.${basis.brightness}`);
  const brightnessText = basis.brightnessSource === 'surface-brightness'
    ? t(`${p}.basisSurface`, { sb: basis.surfaceBrightness?.toFixed(1), brightness: brightnessName })
    : basis.brightnessSource === 'type-narrowband'
      ? t(`${p}.basisNarrowband`, { sb: basis.surfaceBrightness?.toFixed(1), brightness: brightnessName })
      : t(`${p}.basisType`, { brightness: brightnessName });

  // The sum behind the total, one term per factor that is in play.
  const terms: Array<{ value: string; label: string }> = [
    { value: `${basis.factors.base} ${t('objectDetail.integrationSection.hoursUnit')}`, label: t(`${p}.eqBase`, { brightness: brightnessName }) },
    ...(basis.factors.type !== 1 ? [{ value: `× ${basis.factors.type}`, label: t(`${p}.eqStellar`) }] : []),
    {
      value: `× ${(basis.factors.sky * basis.factors.moon).toFixed(2)}`,
      label: t(`${p}.eqSky`, { bortle: basis.bortle, band: t(`${p}.bands.${basis.band}`) }),
    },
    ...(basis.factors.tier !== 1 ? [{ value: `× ${basis.factors.tier}`, label: t(`${p}.tiers.${tier}`) }] : []),
  ];
  const single = suggestion.filters.length === 1;

  /** A narrowband bucket with no name is the dual-band filter the plan assumes,
   *  never "no filter": the sky line under the list says narrowband too. */
  const bucketLabel = (filter: string | null) =>
    filter ?? (basis.dualBandUnnamed
      ? t(`${p}.dualBand`)
      : t('objectDetail.integrationSection.noFilter'));

  return (
    <div className={`rounded-xl p-3 space-y-3 ${isDark ? 'bg-slate-800/40' : 'bg-slate-50'}`}>
      <div className="flex items-center gap-2">
        <p className={`flex-1 text-xs font-semibold ${subtle}`}>{t(`${p}.title`)}</p>
        <button type="button" onClick={onClose} className={`text-xs ${muted} hover:underline underline-offset-2`}>
          {t(`${p}.hide`)}
        </button>
      </div>
      <div className="space-y-2">
        {telescopes.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor="suggest-telescope" className={`w-16 shrink-0 text-xs ${muted}`}>{t(`${p}.shootWith`)}</label>
            <select
              id="suggest-telescope"
              value={telescope?.id ?? ''}
              onChange={e => { setPickedTelescope(e.target.value || null); writeStored(TELESCOPE_KEY, e.target.value); }}
              className={`min-w-0 max-w-full rounded-lg border px-2.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30 ${
                isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
              }`}
            >
              <option value="">{t(`${p}.shootAny`)}</option>
              {telescopes.map(tel => <option key={tel.id} value={tel.id}>{tel.name}</option>)}
            </select>
            {rigIsFixed && <span className={`text-xs ${subtle}`}>{t(`${p}.rigs.${rig}`)}</span>}
          </div>
        )}
        {!rigIsFixed && (
          <Segmented
            label={t(`${p}.rig`)}
            value={rig}
            options={(['color', 'mono'] as const).map(v => ({ value: v, label: t(`${p}.rigs.${v}`) }))}
            onChange={setRig}
            isDark={isDark}
          />
        )}
        <Segmented
          label={t(`${p}.moon`)}
          value={moon}
          options={MOON_PLANS.map(v => ({ value: v, label: t(`${p}.moons.${v}`), hint: hoursHint(run(v, tier)) }))}
          onChange={setMoon}
          isDark={isDark}
        />
        <Segmented
          label={t(`${p}.tier`)}
          value={tier}
          options={GOAL_TIERS.map(v => ({ value: v, label: t(`${p}.tiers.${v}`), hint: hoursHint(run(moon, v)) }))}
          onChange={setTier}
          isDark={isDark}
        />
      </div>

      <div>
        <div className="flex items-baseline gap-2">
          <p className={`text-sm font-semibold ${strong}`}>
            {single
              ? t(`${p}.totalSingle`, { hours: suggestion.totalHours, filter: bucketLabel(suggestion.filters[0].filter) })
              : t(`${p}.total`, { hours: suggestion.totalHours })}
          </p>
          {basis.capped && (
            <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${isDark ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-100 text-amber-800'}`}>
              {t(`${p}.cappedBadge`)}
            </span>
          )}
        </div>
        {!single && <ul className="mt-1 space-y-0.5">
          {suggestion.filters.map(f => (
            <li key={f.filter ?? '\u0000none'} className="flex items-baseline gap-2 text-sm">
              <span className={`flex-1 min-w-0 truncate ${subtle}`}>
                {bucketLabel(f.filter)}
              </span>
              <span className={`tabular-nums ${strong}`}>
                {f.hours} {t('objectDetail.integrationSection.hoursUnit')}
              </span>
            </li>
          ))}
        </ul>}
        <p className={`mt-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs ${muted}`}>
          {terms.map(term => (
            <span key={term.label} className="whitespace-nowrap">
              <span className={`tabular-nums font-medium ${subtle}`}>{term.value}</span> {term.label}
            </span>
          ))}
        </p>
      </div>

      <ul className={`space-y-0.5 text-xs ${muted}`}>
        {basis.capped && (
          <li className={isDark ? 'text-amber-400' : 'text-amber-700'}>
            {t(basis.skyCapped
              ? (basis.band === 'narrowband' ? `${p}.cappedSkyNarrowband` : `${p}.cappedSky`)
              : `${p}.cappedTotal`, { bortle: basis.bortle, max: MAX_TOTAL_HOURS })}
          </li>
        )}
        <li>{brightnessText}</li>
        {basis.dualBandUnnamed && <li>{t(`${p}.unnamedDualBand`)}</li>}
        {basis.fellBack && (
          <li className={isDark ? 'text-amber-400' : 'text-amber-700'}>
            {t(`${p}.fellBack`, { missing: basis.missing.join(', ') })}
          </li>
        )}
        {!basis.fellBack && basis.missing.length > 0 && (
          <li>{t(`${p}.missing`, { missing: basis.missing.join(', ') })}</li>
        )}
        {telescope && !isSmart && !customRig?.sensorType && (
          <li>
            {t(`${p}.setRigHint`)}{' '}
            <Link to="/settings?tab=hardware" className="underline underline-offset-2">{t(`${p}.setRigLink`)}</Link>
          </li>
        )}
        {basis.bortleAssumed && (
          <li className={isDark ? 'text-amber-400' : 'text-amber-700'}>
            {t(`${p}.bortleAssumed`, { bortle: basis.bortle })}
          </li>
        )}
        <li>{t(`${p}.disclaimer`)}</li>
      </ul>

      <div className="flex items-center gap-2">
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => onApply(suggestion.filters.map(f => (
            f.filter === null && basis.dualBandUnnamed ? { ...f, filter: t(`${p}.dualBand`) } : f
          )))}
          className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent-500 text-white hover:bg-accent-600 transition"
        >
          {t(`${p}.apply`)}
        </button>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  isDark,
}: {
  label: string;
  value: T;
  /** `hint` is a quiet second line of text on the chip: what picking it would cost. */
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
  isDark: boolean;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap" role="group" aria-label={label}>
      <span className={`w-16 shrink-0 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map(o => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/30 ${
                active
                  ? 'bg-accent-500/15 border-accent-500/40 text-accent-600'
                  : isDark
                    ? 'border-slate-700 text-slate-400 hover:bg-slate-800'
                    : 'border-slate-200 text-slate-600 hover:bg-white'
              }`}
            >
              {o.label}
              {o.hint && <span className="ml-1.5 tabular-nums opacity-70">{o.hint}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
