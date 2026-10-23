/**
 * 12-month max-altitude-during-darkness bar chart. Shared by the catalog
 * object modal and the Wishlist panel: both answer the same question ("when
 * is this actually worth imaging from here") for an object that isn't
 * necessarily up tonight.
 */
import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { computeBestImagingWindow } from '../../lib/bestImagingWindow';

interface Props {
  months: ReturnType<typeof computeBestImagingWindow>['months'];
  windowStart: string | null;
  windowEnd: string | null;
  minAlt: number;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
  /**
   * Draw for a card-sized slot instead of a modal-wide one: no heading, no
   * altitude axis, every third month labeled, and each bar's value on hover via
   * a native <title> rather than a floating tooltip. The caller renders the
   * caption, because only it knows how to say why the chart is there on the
   * surface it sits on.
   */
  compact?: boolean;
}

export function BestImagingChart({ months, windowStart, windowEnd, minAlt, isDark, isNight, isSpace, compact = false }: Props) {
  const { t } = useTranslation('catalogs');
  const [hovered, setHovered] = useState<number | null>(null);
  const accentColor = isNight ? '#f87171' : isSpace ? '#a78bfa' : '#fbbf24';

  const maxAlt = Math.max(...months.map(m => m.maxAlt), minAlt + 10, 30);
  // The compact chart gets its own, much smaller viewBox rather than the same
  // one scaled down. A wishlist card is around half the width of the modal this
  // chart was drawn for, and at 420 units wide the month labels rendered at
  // under 3px there. A number nobody can read is worse than no label.
  const W = compact ? 180 : 420;
  const H = compact ? 58 : 100;
  const PAD = compact ? { top: 5, bottom: 13, left: 3, right: 3 } : { top: 10, bottom: 20, left: 28, right: 8 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const barW = Math.floor(chartW / months.length) - (compact ? 1 : 2);

  function yFor(alt: number) {
    return PAD.top + chartH - (Math.max(0, alt) / maxAlt) * chartH;
  }

  const minAltY = yFor(minAlt);

  return (
    <div>
      {!compact && (
        <div className={`text-xs font-medium mb-2 flex items-center gap-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <CalendarDays className="w-3.5 h-3.5" />
          {t('catalogObjectModal.maxAltitudeHeading')}
          {windowStart && windowEnd && (
            <span className="ml-auto font-semibold" style={{ color: accentColor }}>
              {windowStart === windowEnd
                ? t('catalogObjectModal.bestSingle', { date: windowStart })
                : t('catalogObjectModal.bestRange', { start: windowStart, end: windowEnd })}
            </span>
          )}
        </div>
      )}
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          style={compact ? undefined : { maxHeight: 100 }}
          role="img"
          aria-label={t('catalogObjectModal.maxAltitudeHeading')}
          onMouseLeave={() => setHovered(null)}
        >
          {/* Altitude gridlines. Dropped entirely when compact: at that height
              the labels would eat the plot, and the min-altitude line is the
              only reference the shape needs. */}
          {!compact && [0, 30, 60, 90].map(alt => {
            if (alt > maxAlt + 5) return null;
            const y = yFor(alt);
            return (
              <g key={alt}>
                <line
                  x1={PAD.left} y1={y} x2={W - PAD.right} y2={y}
                  stroke={isNight ? '#2a0808' : isDark ? '#334155' : '#e2e8f0'}
                  strokeWidth="0.5"
                  strokeDasharray="3,3"
                />
                <text x={PAD.left - 4} y={y + 3.5} textAnchor="end" fontSize="7" fill={isNight ? '#661a1a' : isDark ? '#64748b' : '#94a3b8'}>
                  {alt}°
                </text>
              </g>
            );
          })}

          {/* Min-alt threshold line */}
          <line
            x1={PAD.left} y1={minAltY} x2={W - PAD.right} y2={minAltY}
            stroke={isNight ? '#882222' : isDark ? '#ef4444' : '#f87171'}
            strokeWidth={compact ? 0.75 : 1}
            strokeDasharray={compact ? '3,2' : '4,2'}
            opacity="0.6"
          />

          {/* Bars */}
          {months.map((m, i) => {
            const x = PAD.left + i * (chartW / months.length) + 1;
            const barH = Math.max(0, (Math.max(0, m.maxAlt) / maxAlt) * chartH);
            const barY = PAD.top + chartH - barH;
            const isHovered = hovered === i;
            // Months under the threshold carry real information here: they are
            // the off-season half of the year, and on a never-visible object
            // they are the whole answer. The full-size chart's near-background
            // greys disappear at card size, worst in light mode, so the compact
            // chart steps both themes up one shade.
            const belowColor = isNight
              ? (compact ? '#661a1a' : '#3a0f0f')
              : compact
                ? (isDark ? '#475569' : '#94a3b8')
                : (isDark ? '#334155' : '#cbd5e1');
            const fillColor = m.aboveMinAlt ? accentColor : belowColor;
            const belowOpacity = compact ? 0.55 : 0.3;
            const opacity = m.aboveMinAlt ? (isHovered ? 1 : 0.8) : (isHovered ? 0.5 : belowOpacity);
            const monthValue = m.maxAlt > 0
              ? t('catalogObjectModal.monthAltitude', { label: m.label, deg: m.maxAlt })
              : t('catalogObjectModal.monthBelowHorizon', { label: m.label });

            return (
              <g key={i} onMouseEnter={compact ? undefined : () => setHovered(i)}>
                <rect
                  x={x}
                  y={barY}
                  width={barW}
                  height={barH}
                  rx="1"
                  fill={fillColor}
                  opacity={opacity}
                  style={{ transition: 'opacity 0.1s' }}
                >
                  {compact && <title>{monthValue}</title>}
                </rect>
                {/* Month label. Every third month when compact: twelve labels
                    across a card's width would collide. */}
                {(!compact || i % 3 === 0) && (
                  <text
                    x={x + barW / 2}
                    y={H - 5}
                    textAnchor="middle"
                    fontSize={compact ? 7.5 : 7}
                    fill={isNight ? '#661a1a' : isDark ? '#64748b' : '#94a3b8'}
                  >
                    {m.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Tooltip */}
        {!compact && hovered !== null && (
          <div className={`absolute -top-8 pointer-events-none text-[0.6875rem] px-2 py-0.5 rounded shadow-lg ${isDark ? 'bg-slate-800 text-white' : 'bg-white text-slate-900 border border-slate-200'}`}
            style={{ left: `${(hovered / months.length) * 100}%`, transform: 'translateX(-40%)' }}
          >
            {months[hovered].maxAlt > 0
              ? t('catalogObjectModal.monthAltitude', { label: months[hovered].label, deg: months[hovered].maxAlt })
              : t('catalogObjectModal.monthBelowHorizon', { label: months[hovered].label })}
          </div>
        )}
      </div>
    </div>
  );
}
