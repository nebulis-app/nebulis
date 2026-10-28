/**
 * Hand-picked pack pictures and the decisions about scraped ones.
 *
 * The pack builder fetches a NASA Hubble picture and a DSS2 sky plate for each
 * object and cannot tell a good one from a bad one. This file is how a person
 * overrides it, one object at a time:
 *
 *   image    a picture chosen by hand. It replaces the scraped Hubble picture
 *            and is stored in the repo, so a build never depends on a URL.
 *   hubble   'drop' discards the scraped Hubble picture without a replacement
 *            (the sky plate then shows, or nothing if that is dropped too).
 *   dss2     'drop' discards the sky plate; { fovArcmin } fetches it again at
 *            that width, for an object the automatic field of view misframes;
 *            { survey: 'dss2' } keeps the photographic plate where the narrowband
 *            survey would be used, { survey: 'vphas' } asks for the survey.
 *   waive    accepts a known quirk the automatic checks would otherwise reject
 *            (a planetary nebula on a black field is not a mosaic hole).
 *
 * Entries are keyed by canonical id. Edit them with scripts/catalog-pick.ts;
 * the layout is in the private catalog images notes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { IMAGE_PROBLEMS } from './imageQuality.js';
import { resolveCanonicalId } from '../catalogAliases.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// CATALOG_IMAGES_DIR lets a test or a trial run use a scratch folder.
export const OVERRIDES_DIR = process.env.CATALOG_IMAGES_DIR || path.resolve(here, '../../data/catalog-images');

const PickedImage = z.object({
  /** File name inside `files/`, a WebP the pick tool wrote. */
  file: z.string().regex(/^[A-Za-z0-9_.-]+\.webp$/, 'a .webp file name with no folders'),
  credit: z.string().min(3),
  licenseUrl: z.string().url(),
  /** Where the picture came from, so it can be found again. */
  sourceUrl: z.string().url(),
});

const Entry = z.object({
  image: PickedImage.optional(),
  hubble: z.literal('drop').optional(),
  dss2: z.union([
    z.literal('drop'),
    z.object({
      fovArcmin: z.number().min(2).max(10800).optional(),
      // 'dss2' keeps the photographic plate where the narrowband survey would otherwise be used.
      survey: z.enum(['vphas', 'dss2']).optional(),
    }).refine(v => v.fovArcmin !== undefined || v.survey !== undefined, 'give a width or a survey'),
  ]).optional(),
  waive: z.array(z.enum(IMAGE_PROBLEMS)).optional(),
  note: z.string().optional(),
});

export const OverridesFile = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), Entry),
});

export type PickedImage = z.infer<typeof PickedImage>;
export type OverrideEntry = z.infer<typeof Entry>;
export type OverridesFile = z.infer<typeof OverridesFile>;

export interface Overrides {
  entries: ReadonlyMap<string, OverrideEntry>;
  dir: string;
}

/** An objects the person has flagged as needing a pick, with why. */
export const NeedsPick = z.array(z.object({ id: z.string(), reason: z.string() }));

export function overridesPath(dir = OVERRIDES_DIR): string { return path.join(dir, 'overrides.json'); }
export function pickedFilePath(file: string, dir = OVERRIDES_DIR): string { return path.join(dir, 'files', file); }

/** Reads and validates overrides.json; an empty set when the file is missing. */
export function loadOverrides(dir = OVERRIDES_DIR): Overrides {
  const file = overridesPath(dir);
  if (!fs.existsSync(file)) return { entries: new Map(), dir };
  const parsed = OverridesFile.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return { entries: new Map(Object.entries(parsed.entries)), dir };
}

/** Writes overrides.json with keys sorted, so edits diff cleanly. */
export function saveOverrides(entries: ReadonlyMap<string, OverrideEntry>, dir = OVERRIDES_DIR): void {
  const sorted = Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  const data: OverridesFile = { version: 1, entries: sorted };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(overridesPath(dir), JSON.stringify(data, null, 2) + '\n');
}

export function loadNeedsPick(dir = OVERRIDES_DIR): Array<{ id: string; reason: string }> {
  const file = path.join(dir, 'needs-pick.json');
  if (!fs.existsSync(file)) return [];
  return NeedsPick.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** What is wrong with the overrides themselves: bad keys and missing files. */
export function validateOverrides(overrides: Overrides): string[] {
  const problems: string[] = [];
  for (const [id, entry] of overrides.entries) {
    if (resolveCanonicalId(id) !== id) problems.push(`${id}: not a canonical id (use ${resolveCanonicalId(id)})`);
    if (entry.image && !fs.existsSync(pickedFilePath(entry.image.file, overrides.dir))) {
      problems.push(`${id}: picture file ${entry.image.file} is missing from files/`);
    }
    if (entry.image && entry.hubble) problems.push(`${id}: has both image and hubble:drop (the image already replaces the Hubble picture)`);
  }
  const used = new Set([...overrides.entries.values()].map(e => e.image?.file).filter((f): f is string => !!f));
  const filesDir = path.join(overrides.dir, 'files');
  if (fs.existsSync(filesDir)) {
    for (const f of fs.readdirSync(filesDir)) if (f.endsWith('.webp') && !used.has(f)) problems.push(`files/${f}: no entry uses this picture`);
  }
  return problems;
}
