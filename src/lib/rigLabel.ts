/**
 * How a "rig" (telescope + optical train) is named in the UI: "Elendil ·
 * Reducer 0.75x · 456 mm", or "Seestar · 250 mm" when the focal length comes
 * from the FITS and no configuration is set up. Configuration names are the
 * user's own words and "mm" reads the same in every language, so this needs no
 * translation beyond the fallback for a night with no telescope.
 */
import type { SessionOptics } from '../types';

export function formatFocal(mm: number): string {
  return `${Math.round(mm)} mm`;
}

/** "Reducer 0.75x · 456 mm", "609 mm", or null when nothing is known. */
export function opticsLabel(optics: SessionOptics | undefined | null): string | null {
  if (!optics) return null;
  if (optics.configName) {
    return optics.focalLengthMm !== null ? `${optics.configName} · ${formatFocal(optics.focalLengthMm)}` : optics.configName;
  }
  return optics.focalLengthMm !== null ? formatFocal(optics.focalLengthMm) : null;
}

/** Full rig name; `noTelescope` is the (translated) name for a night with none. */
export function rigLabel(
  telescope: { name: string } | null | undefined,
  optics: SessionOptics | undefined | null,
  noTelescope: string,
): string {
  const train = opticsLabel(optics);
  const name = telescope?.name ?? noTelescope;
  return train ? `${name} · ${train}` : name;
}
