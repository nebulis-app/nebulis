import type { AnnotateQuality } from '../../lib/api/annotate';

/** The small status dot on the toolbar's Annotate button: how far to trust the rings when the tile has no room. */
export const QUALITY_DOT: Record<AnnotateQuality, string> = {
  solved: 'bg-emerald-400',
  header: 'bg-emerald-400',
  approximate: 'bg-accent-400',
  unavailable: 'bg-white/50',
};
