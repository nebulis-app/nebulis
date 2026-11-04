/** Display names for the suffix of a variant object id (`M31_mosaic`, `M16_Ha`). Mirrors `extractVariantLabel` in
 *  server/routes/library.ts, which labels the same variants on the Nights cards. Keep the two in step. */
const VARIANT_LABELS: Record<string, string> = {
  mosaic: 'Mosaic', mosaick: 'Mosaic', mosiac: 'Mosaic',
  ha: 'Hα', oiii: 'OIII', sii: 'SII',
  sho: 'SHO', hoo: 'HOO',
  rgb: 'RGB', lrgb: 'LRGB',
  lum: 'Luminance', luminance: 'Luminance',
  nb: 'Narrowband', narrowband: 'Narrowband', broadband: 'Broadband',
  bicolor: 'Bicolor', tricolor: 'Tricolor', hargb: 'HaRGB',
  photo: 'Photo', video: 'Video',
};

/** The variant an object id names ("Mosaic", "Hα"), or null for a base object. */
export function variantLabelOf(objectId: string): string | null {
  const m = objectId.match(/[_\s]+(mosai[ck]|mosiac|panel\d*|ha|oiii|sii|sho|hoo|rgb|lrgb|nb|narrowband|broadband|luminance|lum|bicolor|tricolor|hargb|photo|video)\s*\d*$/i);
  if (!m) return null;
  const key = m[1].toLowerCase().replace(/\d+$/, '');
  return VARIANT_LABELS[key] ?? (m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase());
}

/** Pill colors for a variant label: amber for a mosaic, red for Hα, and so on. */
export function variantBadgeClass(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('mosaic')) return 'bg-amber-500/90 text-white';
  if (l === 'hα' || l === 'ha') return 'bg-red-500/90 text-white';
  if (l === 'oiii') return 'bg-cyan-500/90 text-white';
  if (l === 'sii') return 'bg-blue-500/90 text-white';
  return 'bg-violet-500/90 text-white';
}
