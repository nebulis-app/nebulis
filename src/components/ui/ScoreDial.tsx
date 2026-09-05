/**
 * Circular readout for a 0-100 visibility score. The arc is drawn in the
 * score's own band colour with a matching bloom behind it, so the rating reads
 * before the number does.
 */
import { scoreHex, scoreLabel } from '../../lib/forecastScore';

interface Props {
  score: number;
  size?: number;
  /** Hides the band name under the number when the caller shows it elsewhere. */
  showLabel?: boolean;
  className?: string;
}

export function ScoreDial({ score, size = 132, showLabel = true, className = '' }: Props) {
  const hex = scoreHex(score);
  const R = 46;
  const circumference = 2 * Math.PI * R;
  const offset = circumference * (1 - Math.min(100, Math.max(0, score)) / 100);

  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: `radial-gradient(circle, ${hex}2e 0%, transparent 68%)` }}
      />
      <svg viewBox="0 0 110 110" width={size} height={size} className="-rotate-90 relative">
        <circle cx="55" cy="55" r={R} fill="none" strokeWidth="6" stroke="rgba(255,255,255,0.09)" />
        <circle
          cx="55" cy="55" r={R} fill="none" strokeWidth="6" strokeLinecap="round"
          stroke={hex}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            filter: `drop-shadow(0 0 7px ${hex}99)`,
            transition: 'stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span
          className="font-display font-bold tabular-nums"
          style={{ color: hex, fontSize: size * 0.30, textShadow: `0 0 22px ${hex}59` }}
        >
          {score}
        </span>
        {showLabel && (
          <span
            className="mt-1 font-semibold uppercase tracking-[0.16em]"
            style={{ color: hex, fontSize: Math.max(9, size * 0.082) }}
          >
            {scoreLabel(score)}
          </span>
        )}
      </div>
    </div>
  );
}
