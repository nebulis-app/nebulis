/**
 * Library — a processing-ready export for one object: the lights kept for
 * the chosen nights plus the darks, flats, flat darks and bias that match
 * them, laid out for PixInsight WBPP or Siril.
 *
 * This file is the glue: it reads the lights (FITS header first, filename as
 * a fallback), flattens the Calibration Library (calibrationScan.ts) into
 * candidates, resolves the session's attached flats
 * (calibrationAttachments.ts), applies the Keep decisions from the sub-frame
 * quality report, and hands the actual matching to ../stackingMatch.ts.
 *
 * Nothing is copied on disk: the plan carries absolute paths and the route
 * streams them into a ZIP.
 */
import fs from 'fs';
import path from 'path';
import { parseFitsHeader } from '../fitsParser.js';
import { parseFilename } from '../telescopeFiles.js';
import {
  matchGroup,
  type CalCandidate,
  type CalPick,
  type CalType,
  type LightGroupInput,
  type MatchIssue,
} from '../stackingMatch.js';
import { listCalibrationLibrary, calibrationBundleName, resolveFrameType, type CalibrationFile } from './calibrationScan.js';
import { resolveAttachmentsForSession } from './calibrationAttachments.js';
import { buildSessionReport } from '../frameAnalysis/service.js';
import { resolveLibraryFile } from './fileResolver.js';
import { dominantTelescopeForSession } from './libraryFiles.js';
import { getFilterAliasMap, normalizeFilterName } from './integration.js';

/** Canonical filter name (built-in and user aliases, as in the integration
 *  breakdown), so a light shot through "H" finds flats labelled "Ha" when the
 *  user aliased them. Null for no filter. */
type FilterNormalizer = (raw: string | null | undefined) => string | null;
function filterNormalizer(): FilterNormalizer {
  const aliases = getFilterAliasMap();
  return raw => normalizeFilterName(raw, aliases) || null;
}

const HEADER_BYTES = 2880 * 10;

// ─── Lights ─────────────────────────────────────────────────────────────────

export interface LightInfo {
  relPath: string;
  fileName: string;
  abs: string;
  bytes: number;
  night: string;
  filter: string | null;
  exposureSec: number | null;
  gain: number | null;
  binning: number | null;
  sensorTempC: number | null;
  kept: boolean;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
};

/** Settings of one light: FITS header first (EXPTIME, GAIN, XBINNING,
 *  CCD-TEMP, FILTER), the ASIAIR-style filename for anything it lacks. */
export function readLightSettings(abs: string, fileName: string): Pick<LightInfo, 'filter' | 'exposureSec' | 'gain' | 'binning' | 'sensorTempC'> {
  let values: Record<string, string | number | boolean> = {};
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(HEADER_BYTES);
      const read = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
      values = parseFitsHeader(buf.subarray(0, read)).values;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Unreadable header: the filename is all there is.
  }
  const fromName = (re: RegExp) => {
    const m = re.exec(fileName);
    return m ? Number.parseFloat(m[1]) : null;
  };
  const headerFilter = values['FILTER'] === undefined ? '' : String(values['FILTER']).trim();
  const exposure = num(values['EXPTIME'] ?? values['EXPOSURE']) ?? fromName(/_(\d+(?:\.\d+)?)s_/i);
  return {
    filter: headerFilter || parseFilename(fileName).filter || null,
    exposureSec: exposure !== null && exposure > 0 ? exposure : null,
    gain: num(values['GAIN']) ?? fromName(/_gain(\d+)/i),
    binning: num(values['XBINNING']) ?? fromName(/_Bin(\d+)/i),
    sensorTempC: num(values['CCD-TEMP'] ?? values['TEMPERAT']) ?? fromName(/_(-?\d+(?:\.\d+)?)C(?:_|\.)/),
  };
}

/**
 * A night's raw lights with their settings and whether each is kept. Which frames exist and who is kept come from
 * Frame Analysis (`buildSessionReport`): the user's keep / reject wins, otherwise a frame is kept unless it was
 * graded bad, and a frame that has not been measured is kept. `unmeasured` says how many have no grade yet, so the
 * dialog can offer to measure them before exporting.
 */
function nightLights(objectId: string, night: string, normalize: FilterNormalizer): { lights: LightInfo[]; unmeasured: number } {
  const report = buildSessionReport([objectId], night);
  const lights: LightInfo[] = [];
  for (const row of report.frames) {
    const resolved = resolveLibraryFile(row.path);
    if (!resolved) continue; // outside the library or gone: nothing to export
    let bytes = 0;
    try { bytes = fs.statSync(resolved.abs).size; } catch { /* listed but gone: zero bytes, still listed */ }
    const settings = readLightSettings(resolved.abs, row.name);
    lights.push({
      relPath: row.path,
      fileName: row.name,
      abs: resolved.abs,
      bytes,
      night,
      ...settings,
      filter: normalize(settings.filter),
      kept: row.kept,
    });
  }
  return { lights, unmeasured: report.total - report.measured };
}

// ─── Calibration candidates ─────────────────────────────────────────────────

export interface CandidateWithFiles extends CalCandidate {
  files: CalibrationFile[];
}

/** One candidate: a Calibration Library bundle, or for flats one filter's
 *  share of it (see listCalibrationCandidates). */
type CandidateRef = { scope: string | null; folderName: string; key: string; filter: string | null };
const candidateId = (c: CandidateRef) => `${c.scope ?? ''}\u0000${c.folderName}\u0000${c.key}\u0000${c.filter ?? ''}`;
/** The bundle a candidate came from, which is what attachments point at. */
const bundleId = (scope: string | null, folderName: string, key: string) => `${scope ?? ''}\u0000${folderName}\u0000${key}`;

function sumBytes(files: CalibrationFile[]): number {
  return files.reduce((n, f) => n + f.size, 0);
}

/**
 * Every bundle of the Calibration Library as a matching candidate.
 *
 * The library groups frames by exposure, gain, binning and temperature, not
 * by filter, so flats of two filters shot at the same exposure share one
 * bundle there. Each filter's flats are split into a candidate of their own
 * here (named `<bundle>_<filter>`), or every filter would be calibrated with
 * all of them. Filter labels go through the same aliases as the integration
 * breakdown.
 */
export function listCalibrationCandidates(normalize: FilterNormalizer = filterNormalizer()): CandidateWithFiles[] {
  const out: CandidateWithFiles[] = [];
  for (const group of listCalibrationLibrary()) {
    for (const set of group.settingsGroups) {
      const type = resolveFrameType(group.type, set.frameType);
      if (type === 'mixed') continue;
      const base = {
        type: type as CalType,
        scope: group.scope,
        folderName: group.folderName,
        key: set.key,
        name: calibrationBundleName(group, set),
        exposureSec: set.exposureSec,
        gain: set.gain,
        binning: set.binning,
        sensorTempC: set.sensorTempC,
        capturedAt: set.capturedAt,
        isExpired: set.isExpired,
      };
      const byFilter = new Map<string, CalibrationFile[]>();
      for (const f of set.files) {
        const k = type === 'flat' ? normalize(f.info?.filterLabel) ?? '' : '';
        const list = byFilter.get(k);
        if (list) list.push(f); else byFilter.set(k, [f]);
      }
      const split = byFilter.size > 1;
      for (const [filter, files] of byFilter) {
        out.push({
          ...base,
          name: split && filter ? `${base.name}_${filter}` : base.name,
          filter: filter || null,
          fileCount: files.length,
          bytes: sumBytes(files),
          files,
        });
      }
    }
  }
  return out;
}

// ─── Plan ───────────────────────────────────────────────────────────────────

export interface PlanCalibration {
  type: CalType;
  name: string;
  scope: string | null;
  folderName: string;
  key: string;
  source: 'attached' | 'matched';
  fileCount: number;
  bytes: number;
  exposureSec: number | null;
  gain: number | null;
  binning: number | null;
  sensorTempC: number | null;
  filter: string | null;
  capturedAt: string | null;
  isExpired: boolean;
  deltaTempC?: number;
  deltaDays?: number;
}

export interface PlanGroup {
  id: string;
  night: string;
  filter: string | null;
  exposureSec: number | null;
  gain: number | null;
  binning: number | null;
  sensorTempC: number | null;
  frames: number;
  kept: number;
  bytes: number;
  dark: PlanCalibration | null;
  flat: PlanCalibration | null;
  flatDark: PlanCalibration | null;
  bias: PlanCalibration | null;
  issues: MatchIssue[];
}

export interface StackingPlan {
  objectId: string;
  nights: string[];
  includeNotKept: boolean;
  groups: PlanGroup[];
  /** Nights with raw frames that have no analysis yet; an unmeasured frame counts as kept, so the dialog offers
   *  to measure these before exporting. Nights with none are left out. */
  unmeasuredByNight: Record<string, number>;
  totals: {
    lights: number;
    excluded: number;
    calibrationFrames: number;
    bytes: number;
    errors: number;
    warnings: number;
  };
}

/** The plan plus everything the export needs and the client must not see
 *  (absolute paths). */
export interface StackingPlanWithFiles {
  plan: StackingPlan;
  lights: LightInfo[];
  candidates: Map<string, CandidateWithFiles>;
}

function toPlanCalibration(pick: CalPick | null): PlanCalibration | null {
  if (!pick) return null;
  const c = pick.candidate;
  return {
    type: c.type, name: c.name, scope: c.scope, folderName: c.folderName, key: c.key, source: pick.source,
    fileCount: c.fileCount, bytes: c.bytes, exposureSec: c.exposureSec, gain: c.gain, binning: c.binning,
    sensorTempC: c.sensorTempC, filter: c.filter, capturedAt: c.capturedAt, isExpired: c.isExpired,
    ...(pick.deltaTempC !== undefined ? { deltaTempC: pick.deltaTempC } : {}),
    ...(pick.deltaDays !== undefined ? { deltaDays: pick.deltaDays } : {}),
  };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};

export function buildStackingPlan(
  objectId: string,
  nights: string[],
  opts: { includeNotKept?: boolean } = {},
): StackingPlanWithFiles {
  const includeNotKept = !!opts.includeNotKept;
  const sortedNights = [...new Set(nights)].sort();
  const unmeasuredByNight: Record<string, number> = {};
  const normalize = filterNormalizer();
  const candidateList = listCalibrationCandidates(normalize);
  const candidates = new Map(candidateList.map(c => [candidateId(c), c]));
  const byBundle = new Map<string, CandidateWithFiles[]>();
  for (const c of candidateList) {
    const id = bundleId(c.scope, c.folderName, c.key);
    byBundle.set(id, [...(byBundle.get(id) ?? []), c]);
  }

  const lights: LightInfo[] = [];
  const groups: PlanGroup[] = [];
  for (const night of sortedNights) {
    const { lights: nightFrames, unmeasured } = nightLights(objectId, night, normalize);
    unmeasuredByNight[night] = unmeasured;
    lights.push(...nightFrames);
    const scope = dominantTelescopeForSession(objectId, night);
    const attached = resolveAttachmentsForSession(objectId, night)
      .flatMap(a => byBundle.get(bundleId(a.scope, a.folderName, a.settingsKey)) ?? []);
    const nightFilterCount = new Set(nightFrames.map(f => f.filter ?? '')).size;

    const byKey = new Map<string, LightInfo[]>();
    for (const f of nightFrames) {
      const k = [f.filter ?? '', f.exposureSec ?? '', f.gain ?? '', f.binning ?? ''].join('|');
      const list = byKey.get(k);
      if (list) list.push(f); else byKey.set(k, [f]);
    }
    for (const [k, frames] of byKey) {
      const first = frames[0];
      const input: LightGroupInput = {
        night,
        filter: first.filter,
        exposureSec: first.exposureSec,
        gain: first.gain,
        binning: first.binning,
        sensorTempC: median(frames.map(f => f.sensorTempC).filter((t): t is number => t !== null)),
        scope,
      };
      const match = matchGroup(input, candidateList, attached, nightFilterCount);
      const included = frames.filter(f => includeNotKept || f.kept);
      groups.push({
        id: `${night}|${k}`,
        ...input,
        frames: frames.length,
        kept: frames.filter(f => f.kept).length,
        bytes: included.reduce((s, f) => s + f.bytes, 0),
        dark: toPlanCalibration(match.dark),
        flat: toPlanCalibration(match.flat),
        flatDark: toPlanCalibration(match.flatDark),
        bias: toPlanCalibration(match.bias),
        issues: match.issues,
      });
    }
  }
  groups.sort((a, b) => a.night.localeCompare(b.night) || (a.filter ?? '').localeCompare(b.filter ?? '') || (a.exposureSec ?? 0) - (b.exposureSec ?? 0));

  // Each bundle counted once, however many groups share it.
  const used = new Map<string, PlanCalibration>();
  for (const g of groups) {
    for (const c of [g.dark, g.flat, g.flatDark, g.bias]) if (c) used.set(candidateId(c), c);
  }
  const included = lights.filter(f => includeNotKept || f.kept);
  const calibrationFrames = [...used.values()].reduce((s, c) => s + c.fileCount, 0);
  const plan: StackingPlan = {
    objectId,
    nights: sortedNights,
    includeNotKept,
    groups,
    unmeasuredByNight: Object.fromEntries(Object.entries(unmeasuredByNight).filter(([, n]) => n > 0)),
    totals: {
      lights: included.length,
      excluded: lights.length - included.length,
      calibrationFrames,
      bytes: included.reduce((s, f) => s + f.bytes, 0) + [...used.values()].reduce((s, c) => s + c.bytes, 0),
      errors: groups.reduce((s, g) => s + g.issues.filter(i => i.severity === 'error').length, 0),
      warnings: groups.reduce((s, g) => s + g.issues.filter(i => i.severity === 'warning').length, 0),
    },
  };
  return { plan, lights, candidates };
}

// ─── ZIP layout ─────────────────────────────────────────────────────────────

export type StackingLayout = 'wbpp' | 'siril';

export interface ExportEntry {
  /** Path inside the ZIP. */
  name: string;
  /** File on disk, or inline text content. */
  abs?: string;
  content?: string;
}

const safe = (s: string) => s.replace(/[^\w.+-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
const fmtExp = (e: number | null) => (e === null ? 'unk' : `${e}s`);

/**
 * WBPP: one tree, `NIGHT_<date>` folders for anything per night (lights,
 * flats, flat darks) and shared darks/bias once, so a multi-night export
 * calibrates each night with its own flats when NIGHT is used as a grouping
 * keyword. WBPP classifies frames by IMAGETYP / FILTER / EXPTIME itself.
 *
 * Siril: one folder per night × filter × exposure with the four folders its
 * preprocessing scripts expect (`lights`, `darks`, `flats`, `biases`). Flat
 * darks go in `biases` when there are any, since that folder is what the
 * scripts calibrate flats with. Shared darks are repeated per folder.
 */
export function buildExportEntries(
  data: StackingPlanWithFiles,
  layout: StackingLayout,
  rootName: string,
): ExportEntry[] {
  const { plan, lights, candidates } = data;
  const entries: ExportEntry[] = [];
  const used = new Set<string>();
  const add = (name: string, entry: Omit<ExportEntry, 'name'>) => {
    let unique = name;
    if (used.has(unique)) {
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n++;
      unique = `${stem}-${n}${ext}`;
    }
    used.add(unique);
    entries.push({ name: unique, ...entry });
  };
  const filesOf = (c: PlanCalibration | null) =>
    c ? candidates.get(candidateId(c))?.files ?? [] : [];
  const calName = (f: CalibrationFile) => f.name.split(/[/\\]/).join('_');
  const root = safe(rootName);
  const lightsByGroup = new Map<string, LightInfo[]>();
  for (const f of lights) {
    if (!plan.includeNotKept && !f.kept) continue;
    const k = `${f.night}|${[f.filter ?? '', f.exposureSec ?? '', f.gain ?? '', f.binning ?? ''].join('|')}`;
    const list = lightsByGroup.get(k);
    if (list) list.push(f); else lightsByGroup.set(k, [f]);
  }

  if (layout === 'wbpp') {
    const shared = new Set<string>();
    for (const g of plan.groups) {
      const nightDir = `NIGHT_${g.night}`;
      const filterDir = `FILTER_${safe(g.filter ?? 'none')}`;
      for (const f of lightsByGroup.get(g.id) ?? []) {
        add(`${root}/Lights/${nightDir}/${filterDir}/${f.fileName}`, { abs: f.abs });
      }
      for (const [kind, folder, c] of [['dark', 'Darks', g.dark], ['bias', 'Bias', g.bias]] as const) {
        if (!c) continue;
        const id = `${kind}\u0000${candidateId(c)}`;
        if (shared.has(id)) continue;
        shared.add(id);
        for (const f of filesOf(c)) add(`${root}/${folder}/${safe(c.name)}/${calName(f)}`, { abs: f.path });
      }
      for (const [folder, c] of [['Flats', g.flat], ['FlatDarks', g.flatDark]] as const) {
        if (!c) continue;
        const id = `${folder}\u0000${g.night}\u0000${candidateId(c)}`;
        if (shared.has(id)) continue;
        shared.add(id);
        for (const f of filesOf(c)) add(`${root}/${folder}/${nightDir}/${filterDir}/${calName(f)}`, { abs: f.path });
      }
    }
  } else {
    const multiExposure = new Map<string, number>();
    for (const g of plan.groups) {
      const k = `${g.night}|${g.filter ?? ''}`;
      multiExposure.set(k, (multiExposure.get(k) ?? 0) + 1);
    }
    for (const g of plan.groups) {
      const dir = [g.night, safe(g.filter ?? 'none'), ...((multiExposure.get(`${g.night}|${g.filter ?? ''}`) ?? 0) > 1 ? [fmtExp(g.exposureSec)] : [])].join('_');
      const base = `${root}/${dir}`;
      for (const f of lightsByGroup.get(g.id) ?? []) add(`${base}/lights/${f.fileName}`, { abs: f.abs });
      for (const f of filesOf(g.dark)) add(`${base}/darks/${calName(f)}`, { abs: f.path });
      for (const f of filesOf(g.flat)) add(`${base}/flats/${calName(f)}`, { abs: f.path });
      for (const f of filesOf(g.flatDark ?? g.bias)) add(`${base}/biases/${calName(f)}`, { abs: f.path });
    }
  }

  const excluded = lights.filter(f => !plan.includeNotKept && !f.kept);
  if (excluded.length > 0) {
    add(`${root}/not-kept.txt`, { content: `${excluded.map(f => `${f.night}\t${f.fileName}`).join('\n')}\n` });
  }
  add(`${root}/manifest.json`, { content: `${JSON.stringify(plan, null, 2)}\n` });
  add(`${root}/README.txt`, { content: readme(plan, layout) });
  return entries;
}

function readme(plan: StackingPlan, layout: StackingLayout): string {
  const lines: string[] = [];
  lines.push(`${plan.objectId} — stacking export (${layout === 'wbpp' ? 'PixInsight WBPP' : 'Siril'})`);
  lines.push(`Nights: ${plan.nights.join(', ')}`);
  lines.push(`Lights: ${plan.totals.lights}${plan.totals.excluded ? ` (${plan.totals.excluded} not kept, listed in not-kept.txt)` : ''}`);
  lines.push('');
  for (const g of plan.groups) {
    lines.push(`${g.night} · ${g.filter ?? 'no filter'} · ${fmtExp(g.exposureSec)} · gain ${g.gain ?? '?'} · bin ${g.binning ?? '?'} · ${g.sensorTempC ?? '?'}°C — ${plan.includeNotKept ? g.frames : g.kept} lights`);
    for (const [label, c] of [['dark', g.dark], ['flat', g.flat], ['flat dark', g.flatDark], ['bias', g.bias]] as const) {
      lines.push(`  ${label.padEnd(9)} ${c ? `${c.name} (${c.fileCount}${c.source === 'attached' ? ', attached' : ''}${c.deltaDays ? `, ${c.deltaDays} d from the night` : ''})` : '—'}`);
    }
    for (const i of g.issues) lines.push(`  ! ${i.severity}: ${i.code}${i.params ? ` ${JSON.stringify(i.params)}` : ''}`);
  }
  lines.push('');
  if (layout === 'wbpp') {
    lines.push('PixInsight: open WeightedBatchPreprocessing, "+ Directory" on this folder.');
    lines.push('WBPP sorts frames by IMAGETYP, FILTER and EXPTIME from the headers.');
    if (plan.nights.length > 1) {
      lines.push('Several nights: lights and flats sit in NIGHT_<date> folders. Add NIGHT as a');
      lines.push('grouping keyword (pre-processing) so each night is calibrated with its own flats.');
    }
  } else {
    lines.push('Siril: each folder holds lights/ darks/ flats/ biases/ as the preprocessing');
    lines.push('scripts expect. Set it as the working directory and run the script for your');
    lines.push('camera (e.g. OSC_Preprocessing). biases/ holds flat darks when there are any.');
  }
  lines.push('');
  return lines.join('\n');
}

/** ZIP base name, e.g. `NGC6888_2026-09-05_wbpp` or `NGC6888_3-nights_siril`. */
export function exportFileName(objectId: string, nights: string[], layout: StackingLayout): string {
  const span = nights.length === 1 ? nights[0] : `${nights.length}-nights`;
  return `${safe(objectId)}_${span}_${layout}`;
}