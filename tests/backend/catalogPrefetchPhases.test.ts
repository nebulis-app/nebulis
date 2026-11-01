import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The network edge is mocked: the pack installer (tested end to end in catalogPackInstall.test.ts)
// and the catalog read. Everything between them, the phase machine and its persisted status, is real.
const install = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../server/lib/catalogPack/install', () => ({
  installCatalogPacks: (...args: unknown[]) => install.fn(...args),
}));

const catalog = vi.hoisted(() => ({ failWith: null as Error | null }));
vi.mock('../../server/lib/dsoCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/lib/dsoCatalog')>();
  return {
    ...actual,
    getCatalog: () => {
      if (catalog.failWith) throw catalog.failWith;
      return actual.getCatalog();
    },
  };
});

import { startPrefetch, cancelPrefetch, getPrefetchStatus, PREFETCH_PHASES, type PrefetchStatus } from '../../server/lib/catalogPrefetch';

async function until(predicate: (s: PrefetchStatus) => boolean, label: string): Promise<PrefetchStatus> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const s = getPrefetchStatus();
    if (predicate(s)) return s;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}; status is ${JSON.stringify(getPrefetchStatus())}`);
}

const installed = (tier: string) => [{ tier, version: '1', objectCount: 1 }];

beforeEach(() => {
  install.fn.mockReset();
  catalog.failWith = null;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  cancelPrefetch();
  await until(s => !s.running, 'job to stop');
  vi.restoreAllMocks();
});

describe('prefetch phase machine', () => {
  it('only ever reports a phase it declares', () => {
    expect(PREFETCH_PHASES).toContain(getPrefetchStatus().phase);
  });

  it('a packs-only run goes pack -> done, installing each tier of the curated scope in order', async () => {
    install.fn.mockImplementation(async (tiers: string[]) => installed(tiers[0]));
    expect(startPrefetch({ packsOnly: true })).toEqual({ started: true });

    const running = getPrefetchStatus();
    expect(running.running).toBe(true);

    const done = await until(s => s.phase === 'done', 'done');
    expect(done).toMatchObject({ running: false, errors: 0, processed: 4, total: 4, lastError: '' });
    expect(done.finishedAt).toBeGreaterThanOrEqual(done.startedAt ?? 0);
    expect(done.packCompletedAt).not.toBeNull();
    expect(install.fn.mock.calls.map(c => (c[0] as string[])[0])).toEqual(['messier', 'caldwell', 'popular', 'sharpless']);
  });

  it('the full scope also installs the extended tier', async () => {
    install.fn.mockImplementation(async (tiers: string[]) => installed(tiers[0]));
    startPrefetch({ packsOnly: true, scope: 'full' });
    await until(s => s.phase === 'done', 'done');
    expect(install.fn.mock.calls.map(c => (c[0] as string[])[0])).toEqual(['messier', 'caldwell', 'popular', 'extended', 'sharpless']);
  });

  it('counts tiers that failed to install, but still finishes done (the live phases fill the gaps)', async () => {
    install.fn.mockImplementation(async (tiers: string[]) => [
      tiers[0] === 'caldwell'
        ? { tier: tiers[0], version: '', objectCount: 0, skipped: true, reason: 'index_fetch_failed' }
        : tiers[0] === 'popular'
          ? { tier: tiers[0], version: '1', objectCount: 1, skipped: true, reason: 'already_installed' }
          : { tier: tiers[0], version: '1', objectCount: 1 },
    ]);
    startPrefetch({ packsOnly: true });
    const done = await until(s => s.phase === 'done', 'done');
    expect(done.errors).toBe(1);
  });

  it('survives an installer that throws, counting it as an error', async () => {
    install.fn.mockRejectedValue(new Error('boom'));
    startPrefetch({ packsOnly: true });
    const done = await until(s => s.phase === 'done', 'done');
    expect(done.errors).toBe(4);
  });

  it('refuses to start a second job while one runs', async () => {
    install.fn.mockImplementation((_tiers: string[], signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    expect(startPrefetch({ packsOnly: true }).started).toBe(true);
    expect(startPrefetch({ packsOnly: true })).toEqual({ started: false, reason: 'already_running' });
  });

  it('cancel reaches the cancelled state, stops installing further tiers, and is not overwritten by done', async () => {
    let release!: () => void;
    install.fn.mockImplementation((tiers: string[], signal: AbortSignal) => new Promise(resolve => {
      release = () => resolve(installed(tiers[0]));
      signal.addEventListener('abort', () => resolve(installed(tiers[0])));
    }));
    startPrefetch({ packsOnly: true });
    await until(() => install.fn.mock.calls.length === 1, 'first tier to start');

    expect(cancelPrefetch()).toBe(true);
    expect(getPrefetchStatus()).toMatchObject({ running: false, phase: 'cancelled' });
    release();
    await new Promise(r => setTimeout(r, 50));

    expect(getPrefetchStatus()).toMatchObject({ running: false, phase: 'cancelled' });
    expect(install.fn).toHaveBeenCalledTimes(1);
  });

  it('cancel with nothing running reports false and changes nothing', () => {
    const before = getPrefetchStatus();
    expect(cancelPrefetch()).toBe(false);
    expect(getPrefetchStatus()).toEqual(before);
  });

  it('an unexpected failure lands in the error state with the message, and the job is no longer running', async () => {
    catalog.failWith = new Error('catalog unreadable');
    startPrefetch({ packsOnly: true });
    const failed = await until(s => s.phase === 'error', 'error');
    expect(failed).toMatchObject({ running: false, lastError: 'catalog unreadable' });
    expect(failed.finishedAt).not.toBeNull();
    expect(install.fn).not.toHaveBeenCalled();
  });

  it('can start again after an error', async () => {
    catalog.failWith = new Error('transient');
    startPrefetch({ packsOnly: true });
    await until(s => s.phase === 'error', 'error');

    catalog.failWith = null;
    install.fn.mockImplementation(async (tiers: string[]) => installed(tiers[0]));
    expect(startPrefetch({ packsOnly: true }).started).toBe(true);
    const done = await until(s => s.phase === 'done', 'done');
    expect(done.lastError).toBe('');
  });
});
