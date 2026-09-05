/**
 * The Moon drawn at its actual phase rather than a generic crescent icon.
 *
 * The terminator geometry lives in lib/moonPhase so its one load-bearing
 * property (lit area == illuminated fraction) can be asserted in a unit test.
 */
import { isWaningPhase, moonGeometry } from '../../lib/moonPhase';

interface Props {
  /** 0-100, as the forecast reports it. */
  illumination: number;
  /** Phase name from the API, e.g. "Waxing Gibbous". Selects which limb is lit. */
  phase: string;
  /** Rendered pixel size. */
  size?: number;
  className?: string;
}

export function MoonDisk({ illumination, phase, size = 72, className = '' }: Props) {
  const R = 50;
  const { path: litPath, fraction: f } = moonGeometry(illumination, R);
  const waning = isWaningPhase(phase);

  const gid = `moon-${Math.round(f * 1000)}-${waning ? 'wn' : 'wx'}`;

  return (
    <svg
      viewBox="-56 -56 112 112"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={`${phase}, ${Math.round(illumination)} percent illuminated`}
    >
      <defs>
        {/* Warm-white surface with a slight limb falloff so the disk reads
            as a sphere rather than a flat sticker. */}
        <radialGradient id={`${gid}-lit`} cx="38%" cy="32%" r="78%">
          <stop offset="0%" stopColor="#fffdf5" />
          <stop offset="62%" stopColor="#f4e9cf" />
          <stop offset="100%" stopColor="#cdbb98" />
        </radialGradient>
        <radialGradient id={`${gid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="55%" stopColor="rgba(253,246,227,0.30)" />
          <stop offset="100%" stopColor="rgba(253,246,227,0)" />
        </radialGradient>
        {/* Shading for the unlit disk. Flat fill made a new moon read as a hole
            rather than a sphere, and against a busy panel it read as nothing at
            all. Off-centre so the shading agrees with the lit gradient above. */}
        <radialGradient id={`${gid}-dark`} cx="38%" cy="32%" r="80%">
          <stop offset="0%" stopColor="#232c44" />
          <stop offset="100%" stopColor="#0c1020" />
        </radialGradient>
        {/* Maria are clipped to the lit region, not the whole disk, so they
            never show as smudges on the shadowed side. The transform goes on
            the path itself: a <g> is not a permitted clipPath child, and
            browsers drop the whole clip region rather than ignoring the
            wrapper, which silently hid the maria entirely. */}
        <clipPath id={`${gid}-clip`}>
          <path d={litPath} transform={waning ? 'scale(-1,1)' : undefined} />
        </clipPath>
        {/* Softens the maria into seas. Hard ellipse edges read as craters or
            polka dots at the sizes this renders at. */}
        <filter id={`${gid}-soft`} x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation="3.2" />
        </filter>
      </defs>

      {/* Earthshine halo, brighter the more of the disk is lit. */}
      <circle cx="0" cy="0" r="55" fill={`url(#${gid}-glow)`} opacity={0.25 + f * 0.75} />

      {/* Unlit disk. Always drawn, so a thin crescent still shows a full sphere.
          The rim is what carries a new moon: with nothing lit there is no other
          edge, and at 10% it disappeared entirely once the panels behind these
          gained artwork. It has to stay readable against a textured background
          without ever looking like light on the Moon itself. */}
      <circle cx="0" cy="0" r={R} fill={`url(#${gid}-dark)`} />
      <circle cx="0" cy="0" r={R} fill="none" stroke="rgba(226,232,240,0.30)" strokeWidth="1.5" />

      {f > 0.005 && (
        <path d={litPath} transform={waning ? 'scale(-1,1)' : undefined} fill={`url(#${gid}-lit)`} />
      )}

      {/* The nearside maria, laid out roughly as they actually sit: Procellarum
          down the western limb, Imbrium above it, Serenitatis and
          Tranquillitatis across the middle, Crisium alone near the east. */}
      <g fill="rgba(88,81,66,0.30)" clipPath={`url(#${gid}-clip)`} filter={`url(#${gid}-soft)`}>
        <ellipse cx="-25" cy="-2" rx="15" ry="25" />
        <ellipse cx="-11" cy="-25" rx="14" ry="11" />
        <ellipse cx="8" cy="-19" rx="9" ry="8" />
        <ellipse cx="18" cy="-6" rx="11" ry="10" />
        <ellipse cx="31" cy="-20" rx="6" ry="5" />
        <ellipse cx="-7" cy="19" rx="12" ry="9" />
        <ellipse cx="-25" cy="24" rx="8" ry="6" />
      </g>
    </svg>
  );
}
