import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';

const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(root, 'nebulis-cds-mirror-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { resolveObjectCoords, fetchHips2fits } from '../../server/lib/skyImage';
import { resetCdsBreaker } from '../../server/lib/skyImageFallback';
import { fetchSimbadSize, simbadAxes } from '../../server/lib/library/objects';

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** Answers per Sesame host: unpublished means the connection fails, which is what CDS does today. */
type Answer = 'coords' | 'none' | 'unreachable' | 'error';

const SESAME_XML = '<?xml version="1.0"?><Sesame><Target><name>%s</name>'
  + '<Resolver name="Simbad"><jradeg>38.17296</jradeg><jdedeg>61.456889</jdedeg></Resolver></Target></Sesame>';
const SESAME_EMPTY = '<?xml version="1.0"?><Sesame><Target><name>%s</name></Target></Sesame>';

function stubSesame(answers: { cds: Answer; idia: Answer; cfa: Answer }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (async (url: string) => {
    const host = url.includes('cdsweb') ? 'cds' : url.includes('idia') ? 'idia' : 'cfa';
    calls.push(host);
    const answer = answers[host as keyof typeof answers];
    if (answer === 'unreachable') throw new Error('unreachable');
    if (answer === 'error') return new Response('boom', { status: 503 });
    if (answer === 'none') return new Response(SESAME_EMPTY.replace('%s', 'x'), { status: 200 });
    return new Response(SESAME_XML.replace('%s', 'x'), { status: 200 });
  }) as unknown as typeof fetch);
  return calls;
}

describe('Sesame name resolution', () => {
  it('uses a mirror when CDS cannot be reached', async () => {
    // The state CDS is in today: the connection never answers. A mirror must carry the lookup.
    const calls = stubSesame({ cds: 'unreachable', idia: 'coords', cfa: 'coords' });
    const coords = await resolveObjectCoords('Heart Nebula mirror test');
    expect(coords).toEqual({ ra: 38.17296, dec: 61.456889 });
    expect(calls).toEqual(['cds', 'idia']);
  });

  it('tries the second mirror when the first is unreachable too', async () => {
    const calls = stubSesame({ cds: 'unreachable', idia: 'unreachable', cfa: 'coords' });
    const coords = await resolveObjectCoords('Third host test');
    expect(coords).not.toBeNull();
    expect(calls).toEqual(['cds', 'idia', 'cfa']);
  });

  it('remembers a name that a mirror resolved, so the next lookup asks nobody', async () => {
    stubSesame({ cds: 'unreachable', idia: 'coords', cfa: 'coords' });
    await resolveObjectCoords('Cached mirror test');
    const calls = stubSesame({ cds: 'coords', idia: 'coords', cfa: 'coords' });
    expect(await resolveObjectCoords('Cached mirror test')).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it('caches "unknown" only when every host answered and none had the name', async () => {
    const first = stubSesame({ cds: 'none', idia: 'none', cfa: 'none' });
    expect(await resolveObjectCoords('Nobody knows this one')).toBeNull();
    expect(first).toEqual(['cds', 'idia', 'cfa']);
    const second = stubSesame({ cds: 'coords', idia: 'coords', cfa: 'coords' });
    expect(await resolveObjectCoords('Nobody knows this one')).toBeNull();
    expect(second).toEqual([]);
  });

  it('does not remember a failure as "unknown" when every host was unreachable', async () => {
    // Recording an outage as a permanent miss would hide the object until the cache file was deleted.
    const first = stubSesame({ cds: 'unreachable', idia: 'unreachable', cfa: 'unreachable' });
    expect(await resolveObjectCoords('Outage must not poison the cache')).toBeNull();
    expect(first).toEqual(['cds', 'idia', 'cfa']);
    const second = stubSesame({ cds: 'unreachable', idia: 'coords', cfa: 'coords' });
    expect(await resolveObjectCoords('Outage must not poison the cache')).not.toBeNull();
    expect(second).toEqual(['cds', 'idia']);
  });
});

const SIMBAD_VOTABLE = '<VOTABLE><RESOURCE><TABLE><TR>'
  + '<TD>IC 1805</TD><TD>OpenCluster</TD><TD>13.3</TD><TD>13.3</TD>'
  + '</TR></TABLE></RESOURCE></VOTABLE>';
const SIMBAD_NO_SIZE = '<VOTABLE><RESOURCE><TABLE><TR>'
  + '<TD>IC 1805</TD><TD>OpenCluster</TD><TD></TD><TD></TD>'
  + '</TR></TABLE></RESOURCE></VOTABLE>';

function stubSimbad(answers: { cds: 'sized' | 'unsized' | 'unreachable' | 'error'; cfa: 'sized' | 'unsized' | 'unreachable'; idia: 'sized' | 'unsized' | 'unreachable' }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (async (url: string) => {
    const host = url.includes('cfa') ? 'cfa' : url.includes('idia') ? 'idia' : 'cds';
    calls.push(host);
    const answer = answers[host as keyof typeof answers];
    if (answer === 'unreachable') throw new Error('unreachable');
    if (answer === 'error') return new Response('boom', { status: 500 });
    return new Response(answer === 'sized' ? SIMBAD_VOTABLE : SIMBAD_NO_SIZE, { status: 200 });
  }) as unknown as typeof fetch);
  return calls;
}

describe('SIMBAD angular size', () => {
  it('uses a mirror when CDS cannot be reached', async () => {
    const calls = stubSimbad({ cds: 'unreachable', cfa: 'sized', idia: 'sized' });
    expect(await fetchSimbadSize('IC 1805 mirror test')).toBe("13.3' x 13.3'");
    expect(calls).toEqual(['cds', 'cfa']);
  });

  it('falls to the third host when the first two are unreachable', async () => {
    const calls = stubSimbad({ cds: 'unreachable', cfa: 'unreachable', idia: 'sized' });
    expect(await fetchSimbadSize('Third host simbad')).toBe("13.3' x 13.3'");
    expect(calls).toEqual(['cds', 'cfa', 'idia']);
  });

  it('reports one axis when SIMBAD only has one', async () => {
    vi.stubGlobal('fetch', (async () => new Response('<TR><TD>12.5</TD><TD>0</TD></TR>', { status: 200 })) as unknown as typeof fetch);
    expect(await fetchSimbadSize('Single axis')).toBe("12.5'");
  });

  it('returns null when no host answers', async () => {
    const calls = stubSimbad({ cds: 'error', cfa: 'unreachable', idia: 'unreachable' });
    expect(await fetchSimbadSize('Nobody answers')).toBeNull();
    expect(calls).toEqual(['cds', 'cfa', 'idia']);
  });

  it('stops at the first host that answers without a size, since the mirrors hold the same data', async () => {
    const calls = stubSimbad({ cds: 'unsized', cfa: 'sized', idia: 'sized' });
    expect(await fetchSimbadSize('No size recorded')).toBeNull();
    expect(calls).toEqual(['cds']);
  });
});

describe('SIMBAD axes by column name', () => {
  const fields = (...names: string[]) => names.map(n => `<FIELD name="${n}"/>`).join('');
  const table = (cols: string[], cells: string[]) =>
    `<VOTABLE><RESOURCE><TABLE>${fields(...cols)}<DATA><TABLEDATA><TR>${cells.map(c => `<TD>${c}</TD>`).join('')}</TR></TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>`;

  it('reads the axes where the columns say they are, whatever the order', () => {
    expect(simbadAxes(table(['main_id', 'otype', 'dim_majaxis', 'dim_minaxis'], ['M 31', 'Galaxy', '190', '60']))).toEqual({ major: 190, minor: 60 });
    expect(simbadAxes(table(['dim_minaxis', 'dim_majaxis', 'main_id'], ['60', '190', 'M 31']))).toEqual({ major: 190, minor: 60 });
  });

  it('does not take an unrelated number cell for an axis', () => {
    // The old first-two-numeric-cells rule read 5.2 and 1 here (a magnitude and a count) as the size.
    expect(simbadAxes(table(['mag', 'n', 'dim_majaxis', 'dim_minaxis'], ['5.2', '1', '', '']))).toBeNull();
  });

  it('refuses a size that cannot be real, and keeps a good major axis with a bad minor one', () => {
    expect(simbadAxes(table(['dim_majaxis', 'dim_minaxis'], ['5000', '40']))).toBeNull();
    expect(simbadAxes(table(['dim_majaxis', 'dim_minaxis'], ['12', '40']))).toEqual({ major: 12, minor: 0 });
  });
});

describe('hips2fits budget', () => {
  it('honors a short caller timeout instead of waiting out the per-host floor', async () => {
    // Every host hangs until its signal fires. With a 1 s budget the call must come back in about a second, not the
    // 12 s that three 4 s floors would add up to.
    vi.stubGlobal('fetch', ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch);
    const started = Date.now();
    await expect(fetchHips2fits('?x=1', 1000)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1800);
    resetCdsBreaker();
  });
});
