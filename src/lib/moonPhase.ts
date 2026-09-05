/**
 * Geometry for drawing the Moon at a given phase.
 *
 * The lit region is a semicircle joined to a half-ellipse sharing its diameter.
 * With the ellipse's horizontal radius set to R·|1-2f| the lit area works out to
 * exactly f·πR² for every f, which is the property worth holding on to: it
 * means the drawn shape is a faithful representation of the reported
 * illumination rather than an approximation that merely looks plausible.
 */

export interface MoonGeometry {
  /** Disk radius the path is built for. */
  radius: number;
  /** Horizontal radius of the terminator ellipse. Zero at half phase. */
  terminatorRx: number;
  /**
   * Arc sweep flag for the terminator. SVG's y axis points down, so 1 draws
   * clockwise on screen. The lit path opens with a clockwise semicircle up the
   * right limb; the terminator then bulges the same way (0) to eat into it for
   * a crescent, or the opposite way (1) to extend past the diameter for a
   * gibbous. Getting this backwards renders every phase as its own complement.
   */
  sweep: 0 | 1;
  /** SVG path for the lit region, centred on the origin, lit limb to the right. */
  path: string;
  /** Illumination clamped to 0..1. */
  fraction: number;
}

export function moonGeometry(illuminationPercent: number, radius = 50): MoonGeometry {
  const f = Math.min(1, Math.max(0, (illuminationPercent || 0) / 100));
  const terminatorRx = radius * Math.abs(1 - 2 * f);
  const sweep: 0 | 1 = f < 0.5 ? 0 : 1;

  const path =
    `M 0,${-radius} A ${radius},${radius} 0 0 1 0,${radius} ` +
    `A ${terminatorRx},${radius} 0 0 ${sweep} 0,${-radius} Z`;

  return { radius, terminatorRx, sweep, path, fraction: f };
}

/**
 * Which limb is lit. A waning Moon is lit on the left in the northern
 * hemisphere, so its path is the standard one mirrored.
 */
export function isWaningPhase(phase: string): boolean {
  return /waning|last quarter/i.test(phase ?? '');
}

/**
 * Area of the lit region implied by a geometry, in square units. Exposed
 * because it is the invariant worth asserting: it must equal fraction·πR².
 */
export function litArea({ radius, terminatorRx, sweep }: MoonGeometry): number {
  const signed = sweep === 1 ? terminatorRx : -terminatorRx;
  return (Math.PI * radius / 2) * (radius + signed);
}
