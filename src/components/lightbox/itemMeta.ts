import { formatBytes } from '../../lib/utils';
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

export function sessionFileMeta(file: SessionFile, objectName?: string): ItemMeta {
  const kind = STACKED_LABEL[file.fileType];

  // Prefer a human title over the filename when we know enough to build one.
  const titleParts: string[] = [];
  if (objectName) titleParts.push(objectName);
  if (kind) titleParts.push(kind);
  if (file.frameCount) titleParts.push(`${file.frameCount} subs`);

  const facts: string[] = [];
  if (file.exposure) facts.push(file.frameCount ? `× ${file.exposure}` : file.exposure);
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
