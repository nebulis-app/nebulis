/**
 * Decides which pictures go into a pack, after the scrapers have fetched them.
 *
 * For each object it applies the hand overrides, runs the automatic checks and
 * keeps a picture out of the pack when it fails one that nobody waived. A pack
 * with a missing picture is fine (the server fetches a live sky image for any
 * object without one); a pack with a bad picture ships it to every install.
 *
 * Pure with respect to the network: it only reads files, so it can be tested.
 */
import path from 'node:path';
import fs from 'node:fs';
import { analyzeImage, findDuplicate, findText, HARD_PROBLEMS, ocrAvailable, qualityProblems, type ImageProblem } from './imageQuality.js';
import { pickedFilePath, type Overrides } from './imageOverrides.js';
import type { CatalogTier } from './manifest.js';
import type { NarrowbandSurvey } from './surveyPlates.js';

export type PictureKind = 'hubble' | 'dss2' | 'nasa';

/** A picture a scraper fetched, for one canonical object. */
export interface Candidate {
  id: string;
  kind: PictureKind;
  src: string;
  /** Set when the sky plate came from a narrowband survey instead of DSS2. */
  survey?: NarrowbandSurvey;
}

export interface PlannedImage {
  objectId: string;
  /** File name inside the pack's images/ folder, in the form the installer reads. */
  archiveName: string;
  src: string;
  /** `curated` is a hand-picked picture; it travels in the Hubble slot. */
  source: PictureKind | 'curated';
  survey?: NarrowbandSurvey;
}

export interface ReportRow {
  tier: CatalogTier;
  id: string;
  kind: PictureKind | 'curated';
  action: 'kept' | 'dropped' | 'replaced';
  problems: ImageProblem[];
  note?: string;
}

export interface AssemblyContext {
  tier: CatalogTier;
  overrides: Overrides;
  /** Signatures of pictures already accepted in this run, by `${id}:${kind}`. */
  signatures: Map<string, string>;
  /** Ids meant to sit on a black field (the solar system). */
  blackBackground: ReadonlySet<string>;
  report: ReportRow[];
  /** Run the text check. Needs tesseract; the builder says when it is off. */
  ocr: boolean;
}

/** The name a picture has inside the pack, which is also how the installer reads its id. */
export function archiveNameFor(id: string, kind: PictureKind | 'curated'): string {
  if (kind === 'hubble' || kind === 'curated') return `hubble_${id}.webp`;
  return `${id.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9_.-]/g, '_')}_master.jpg`;
}

async function problemsOf(
  ctx: AssemblyContext,
  id: string,
  kind: PictureKind | 'curated',
  file: string,
  waived: ReadonlySet<ImageProblem>,
): Promise<{ problems: ImageProblem[]; blocking: ImageProblem[]; signature: string }> {
  const stats = await analyzeImage(file);
  const problems = qualityProblems(stats, { blackBackgroundOk: ctx.blackBackground.has(id) });
  const dupOf = findDuplicate(
    stats.signature,
    new Map([...ctx.signatures].filter(([k]) => k.split(':')[0] !== id)),
  );
  if (dupOf) problems.push('duplicate');
  // Sky plates are survey cutouts and cannot carry overlay text; reading all of
  // them would cost minutes for nothing.
  if (ctx.ocr && kind !== 'dss2') {
    const words = await findText(file);
    if (words.length > 0) problems.push('text');
  }
  const blocking = problems.filter(p => HARD_PROBLEMS.includes(p) && !waived.has(p));
  return { problems, blocking, signature: stats.signature };
}

/**
 * The pictures to ship for one tier. `candidates` come from the scrapers,
 * keyed by canonical id; `owned` is the objects this tier carries. A candidate
 * for an object the tier does not own is ignored, so an object appears in one
 * tier only.
 */
export async function assembleImages(
  candidates: readonly Candidate[],
  owned: ReadonlySet<string>,
  ctx: AssemblyContext,
): Promise<PlannedImage[]> {
  const planned: PlannedImage[] = [];
  const byId = new Map<string, Candidate[]>();
  for (const c of candidates) if (owned.has(c.id)) (byId.get(c.id) ?? byId.set(c.id, []).get(c.id)!).push(c);

  const ids = new Set<string>(byId.keys());
  for (const [id, e] of ctx.overrides.entries) if (e.image && owned.has(id)) ids.add(id);

  for (const id of [...ids].sort()) {
    const entry = ctx.overrides.entries.get(id);
    const waived = new Set<ImageProblem>(entry?.waive ?? []);
    const mine = byId.get(id) ?? [];

    if (entry?.image) {
      const file = pickedFilePath(entry.image.file, ctx.overrides.dir);
      const res = await problemsOf(ctx, id, 'curated', file, waived);
      if (res.blocking.length > 0) {
        throw new Error(`Hand-picked picture for ${id} fails ${res.blocking.join(', ')}. Pick another or waive it with catalog-pick waive.`);
      }
      ctx.signatures.set(`${id}:curated`, res.signature);
      planned.push({ objectId: id, archiveName: archiveNameFor(id, 'curated'), src: file, source: 'curated' });
      ctx.report.push({ tier: ctx.tier, id, kind: 'curated', action: 'replaced', problems: res.problems, note: entry.image.sourceUrl });
    }

    for (const c of mine) {
      if (c.kind === 'hubble' && (entry?.image || entry?.hubble === 'drop')) {
        ctx.report.push({ tier: ctx.tier, id, kind: 'hubble', action: 'dropped', problems: [], note: entry.image ? 'replaced by a hand-picked picture' : 'dropped by override' });
        continue;
      }
      if (c.kind === 'dss2' && entry?.dss2 === 'drop') {
        ctx.report.push({ tier: ctx.tier, id, kind: 'dss2', action: 'dropped', problems: [], note: 'dropped by override' });
        continue;
      }
      if (!fs.existsSync(c.src) || fs.statSync(c.src).size === 0) continue;
      const res = await problemsOf(ctx, id, c.kind, c.src, waived);
      if (res.blocking.length > 0) {
        ctx.report.push({ tier: ctx.tier, id, kind: c.kind, action: 'dropped', problems: res.problems });
        continue;
      }
      ctx.signatures.set(`${id}:${c.kind}`, res.signature);
      planned.push({ objectId: id, archiveName: archiveNameFor(id, c.kind), src: c.src, source: c.kind, ...(c.survey ? { survey: c.survey } : {}) });
      ctx.report.push({ tier: ctx.tier, id, kind: c.kind, action: 'kept', problems: res.problems });
    }
  }
  return planned;
}

/** The file name only, for logs. */
export const baseName = (p: string): string => path.basename(p);

export { ocrAvailable };
