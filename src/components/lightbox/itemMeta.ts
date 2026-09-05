import { formatBytes } from '../../lib/utils';
import { formatDuration } from '../../lib/captureMetrics';
import type { SessionFile, ProcessedImage } from '../../types';

/**
 * Turns a capture file into something readable in the viewer header.
 *
 * The header used to show the raw filename and nothing else, so a stacked
 * frame announced itself as
 * `Stacked_295_NGC 1432_10.0s_IRCUT_20250811-052608.jpg`. Every useful field in
 * that string is already parsed out on the server, and a few more besides. The
 * viewer is where a frame gets judged, so the facts that decide that (how many
 * subs, how long, which filter, when, how big) belong in the header and the
 * filename belongs underneath it.
 */

const STACKED_LABEL: Record<SessionFile['fileType'], string | null> = {
  stacked: 'Stacked',
  sub: 'Sub-frame',
  thumbnail: 'Thumbnail',
  video: 'Video',
  other: null,
};

function formatTimestamp(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(ts) ? ts : `${ts}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export interface ItemMeta {
  /** Primary line. */
  title: string;
  /** Secondary line: the capture facts, then the filename. */
  detail: string;
}

/** "20.0s" as a number of seconds, or null when it is not in that shape. */
function exposureSeconds(exposure: string): number | null {
  const m = /^([\d.]+)\s*s$/i.exec(exposure.trim());
  const v = m ? Number.parseFloat(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function sessionFileMeta(file: SessionFile, objectName?: string): ItemMeta {
  const kind = STACKED_LABEL[file.fileType];

  // Prefer a human title over the filename when we know enough to build one.
  const titleParts: string[] = [];
  if (objectName) titleParts.push(objectName);
  if (kind) titleParts.push(kind);

  const facts: string[] = [];
  // The count and the exposure belong to each other: "96 × 20.0s" is how the
  // capture is described out loud. Splitting them across the two lines left the
  // second one opening on a bare "× 20.0s", a multiplication with nothing to
  // multiply. The product is spelled out too, since total integration is the
  // number that actually decides whether a stack is worth keeping and nothing
  // in the viewer was working it out.
  if (file.frameCount && file.exposure) {
    const secs = exposureSeconds(file.exposure);
    facts.push(`${file.frameCount} × ${file.exposure}`);
    if (secs) facts.push(`${formatDuration(file.frameCount * secs)} total`);
  } else if (file.frameCount) {
    facts.push(`${file.frameCount} subs`);
  } else if (file.exposure) {
    facts.push(file.exposure);
  }
  if (file.filter) facts.push(file.filter);
  const when = formatTimestamp(file.timestamp) ?? file.date;
  if (when) facts.push(when);
  if (file.size) facts.push(formatBytes(file.size));

  return {
    title: titleParts.length > 0 ? titleParts.join(' · ') : file.name,
    detail: [facts.join(' · '), file.name].filter(Boolean).join(' — '),
  };
}

export function processedImageMeta(img: ProcessedImage): ItemMeta {
  const facts: string[] = [];
  const when = formatTimestamp(img.uploadedAt);
  if (img.runDates && img.runDates.length > 1) facts.push(`${img.runDates.length} nights`);
  if (when) facts.push(when);
  if (img.size) facts.push(formatBytes(img.size));

  return {
    title: img.title || img.originalName,
    detail: [facts.join(' · '), img.notes || img.originalName].filter(Boolean).join(' — '),
  };
}
