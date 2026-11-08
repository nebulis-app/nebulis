/**
 * The credit a sky plate carries when it came from a backup source.
 *
 * The pack builder used to file every plain sky plate under the STScI DSS2 credit, which was only true for CDS and
 * SkyView (both DSS2). A picture from SDSS, the Legacy Surveys or Pan-STARRS shipped with the wrong name on it.
 *
 * The pack's `source` field stays `dss2` for all of these. `CREDIT_SOURCES` (manifest.ts) is checked by every
 * released app, so a new value there would have older apps reject the pack. The honest attribution is in the
 * free-text `credit` and `licenseUrl`, which the apps show as written.
 */
import type { FallbackSource } from '../skyImageFallback.js';

export interface PlateCredit {
  credit: string;
  licenseUrl: string;
}

/** CDS DSS2 color, and SkyView's DSS2 bands: the same STScI plates. */
export const DSS2_CREDIT: PlateCredit = {
  credit: 'Based on photographic data from the STScI Digitized Sky Survey (DSS2), operated by the Space Telescope Science Institute.',
  licenseUrl: 'https://archive.stsci.edu/dss/',
};

export const BACKUP_CREDITS: Record<FallbackSource, PlateCredit> = {
  skyview: DSS2_CREDIT,
  sdss: {
    credit: 'Based on data from the Sloan Digital Sky Survey (SDSS). Funding for the SDSS has been provided by the Alfred P. Sloan Foundation, the Participating Institutions, the National Science Foundation and the U.S. Department of Energy Office of Science.',
    licenseUrl: 'https://www.sdss.org/collaboration/citing-sdss/',
  },
  legacy: {
    credit: 'Based on imaging from the DESI Legacy Imaging Surveys (legacysurvey.org).',
    licenseUrl: 'https://www.legacysurvey.org/acknowledgment/',
  },
  panstarrs: {
    credit: 'Based on data from the Pan-STARRS1 Surveys (PS1), served by the Pan-STARRS Data Archive at the Space Telescope Science Institute.',
    licenseUrl: 'https://panstarrs.stsci.edu/',
  },
};

/** The credit for a sky plate: the backup source's own when it is one, DSS2 otherwise. */
export function plateCredit(backupSource: FallbackSource | null): PlateCredit {
  return backupSource ? BACKUP_CREDITS[backupSource] : DSS2_CREDIT;
}
