/**
 * Built-in artwork for objects that have no sky-survey match (data folders,
 * calibration dumps, anything the catalog can't place).
 *
 * A user picks one in the gallery-image modal; it is stored as the sentinel
 * `builtin:<id>` in `galleryImage`, exactly like `catalog-source:*`. The
 * sentinel is a fixed literal, not a path, so route-level path validation lets
 * it through and `resolveObjectImagePath` turns it into an SVG on disk that the
 * normal sharp thumbnail pipeline rasterises.
 *
 * The colours follow the app theme. The theme is not stored with the sentinel
 * (switching theme should recolour every such object at once), so the thumbnail
 * and art routes take a `?theme=` query and each theme gets its own SVG file,
 * which also gives it its own thumbnail cache key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { THUMBNAILS_DIR } from '../paths.js';

export const BUILTIN_ART_IDS = ['folder', 'drive', 'telescope', 'starfield'] as const;
export type BuiltinArtId = (typeof BUILTIN_ART_IDS)[number];

export const BUILTIN_ART_THEMES = ['dark', 'light', 'space', 'night'] as const;
export type BuiltinArtTheme = (typeof BUILTIN_ART_THEMES)[number];

const SENTINEL_RE = /^builtin:(folder|drive|telescope|starfield)$/;

export function isBuiltinArtSentinel(value: string | null | undefined): boolean {
  return !!value && SENTINEL_RE.test(value);
}

export function parseBuiltinArtSentinel(value: string | null | undefined): BuiltinArtId | null {
  const id = value?.match(SENTINEL_RE)?.[1];
  return BUILTIN_ART_IDS.find((entry) => entry === id) ?? null;
}

export function parseBuiltinArtTheme(value: unknown): BuiltinArtTheme {
  return BUILTIN_ART_THEMES.find((entry) => entry === value) ?? 'dark';
}

interface Palette {
  bgFrom: string;
  bgTo: string;
  /** Main shape: light edge → dark edge of the body. */
  bodyHi: string;
  bodyLo: string;
  /** Back panel / secondary shape. */
  back: string;
  /** Fine detail drawn on the body. */
  line: string;
  star: string;
}

// Mirrors the accent token per theme in src/index.css: amber on dark/light,
// red on night, violet on space.
const PALETTES: Record<BuiltinArtTheme, Palette> = {
  dark: { bgFrom: '#1e293b', bgTo: '#0b1120', bodyHi: '#fcd34d', bodyLo: '#d97706', back: '#b45309', line: '#78350f', star: '#fde68a' },
  light: { bgFrom: '#f1f5f9', bgTo: '#cbd5e1', bodyHi: '#f59e0b', bodyLo: '#b45309', back: '#92400e', line: '#fef3c7', star: '#b45309' },
  space: { bgFrom: '#1e1b4b', bgTo: '#0b0720', bodyHi: '#c4b5fd', bodyLo: '#7c3aed', back: '#5b21b6', line: '#2e1065', star: '#ddd6fe' },
  night: { bgFrom: '#1c0a0a', bgTo: '#080202', bodyHi: '#f87171', bodyLo: '#b91c1c', back: '#7f1d1d', line: '#450a0a', star: '#fca5a5' },
};

// Everything is drawn on a 512×512 canvas, centred, with ~20% margin so a
// square or portrait crop of the tile never cuts the subject.
const SHAPES: Record<BuiltinArtId, (p: Palette) => string> = {
  folder: p => `
    <path d="M96 168a24 24 0 0 1 24-24h82l36 40h154a24 24 0 0 1 24 24v16H96z" fill="${p.back}"/>
    <rect x="96" y="196" width="320" height="188" rx="24" fill="url(#body)"/>
    <rect x="124" y="226" width="264" height="6" rx="3" fill="${p.line}" opacity=".35"/>`,
  drive: p => `
    <rect x="92" y="188" width="328" height="148" rx="28" fill="url(#body)"/>
    <rect x="92" y="188" width="328" height="148" rx="28" fill="none" stroke="${p.back}" stroke-width="6"/>
    <rect x="128" y="226" width="150" height="10" rx="5" fill="${p.line}" opacity=".5"/>
    <rect x="128" y="250" width="100" height="10" rx="5" fill="${p.line}" opacity=".35"/>
    <circle cx="364" cy="262" r="22" fill="${p.line}" opacity=".55"/>
    <circle cx="364" cy="262" r="8" fill="${p.bodyHi}"/>
    <path d="M128 336v24M384 336v24" stroke="${p.back}" stroke-width="14" stroke-linecap="round"/>`,
  telescope: p => `
    <g transform="rotate(-24 256 256)">
      <rect x="132" y="206" width="236" height="76" rx="14" fill="url(#body)"/>
      <rect x="352" y="196" width="40" height="96" rx="10" fill="${p.back}"/>
      <rect x="118" y="214" width="26" height="60" rx="8" fill="${p.back}"/>
      <rect x="196" y="176" width="64" height="20" rx="6" fill="${p.back}"/>
    </g>
    <path d="M256 290l-52 108M256 290l52 108M256 290v118" stroke="${p.back}" stroke-width="14" stroke-linecap="round" fill="none"/>`,
  starfield: p => `
    <path d="M256 120l30 84 84 30-84 30-30 84-30-84-84-30 84-30z" fill="url(#body)"/>
    <path d="M388 124l9 25 25 9-25 9-9 25-9-25-25-9 25-9z" fill="${p.star}"/>
    <path d="M132 340l7 19 19 7-19 7-7 19-7-19-19-7 19-7z" fill="${p.star}"/>`,
};

export function builtinArtSvg(id: BuiltinArtId, theme: BuiltinArtTheme): string {
  const p = PALETTES[theme];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="${p.bgFrom}"/><stop offset="1" stop-color="${p.bgTo}"/></radialGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.bodyHi}"/><stop offset="1" stop-color="${p.bodyLo}"/></linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>${SHAPES[id](p)}
</svg>
`;
}

/**
 * Absolute path of the themed SVG for `id`, written on first use.
 *
 * Lives under the thumbnails dir (a regenerable cache) so nothing has to be
 * bundled with the packaged server. The file name embeds a version so a
 * redesigned shape never serves a stale rasterised thumbnail.
 */
const ART_VERSION = 1;
export function ensureBuiltinArtFile(id: BuiltinArtId, theme: BuiltinArtTheme): string {
  const dir = path.join(THUMBNAILS_DIR, 'builtin-art');
  const file = path.join(dir, `${id}.${theme}.v${ART_VERSION}.svg`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, builtinArtSvg(id, theme));
  }
  return file;
}
