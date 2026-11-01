// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

const api = vi.hoisted(() => ({
  cancelSubframesArchive: vi.fn(),
  getSubframesArchiveStatus: vi.fn(),
  getSubframesArchiveTmpUrl: vi.fn((token: string) => `/tmp/${token}`),
}));
vi.mock('../../src/lib/api/library', () => api);

import { useArchiveJob } from '../../src/hooks/useArchiveJob';
import { renderHook } from './helpers/renderHook';

const running = { status: 'running' as const, filesTotal: 10, filesDone: 3, elapsedMs: 1000 };
const begin = () => Promise.resolve({ jobId: 'job-1', filesTotal: 10 });

/** Runs `start`, lets the begin promise settle, and leaves the poll timer armed. */
async function started(hook: ReturnType<typeof renderHook<ReturnType<typeof useArchiveJob>>>, beginFn = begin) {
  await act(async () => { await hook.result.current.start(beginFn); });
}
const tick = (ms = 500) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

let clicked: string[];

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of [api.cancelSubframesArchive, api.getSubframesArchiveStatus]) fn.mockReset();
  api.cancelSubframesArchive.mockResolvedValue(undefined);
  api.getSubframesArchiveStatus.mockResolvedValue(running);
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.getAttribute('href') ?? ''); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useArchiveJob', () => {
  it('is idle until started', () => {
    const { result } = renderHook(() => useArchiveJob());
    expect(result.current).toMatchObject({ phase: 'idle', status: null, error: null });
  });

  it('start goes to running with the file count, and polls every 500 ms', async () => {
    const hook = renderHook(() => useArchiveJob());
    await started(hook);
    expect(hook.result.current.phase).toBe('running');
    expect(hook.result.current.status).toMatchObject({ filesTotal: 10, filesDone: 0 });
    expect(api.getSubframesArchiveStatus).not.toHaveBeenCalled();

    await tick();
    expect(api.getSubframesArchiveStatus).toHaveBeenCalledTimes(1);
    expect(api.getSubframesArchiveStatus).toHaveBeenCalledWith('job-1');
    expect(hook.result.current.status).toMatchObject({ filesDone: 3 });
    await tick();
    expect(api.getSubframesArchiveStatus).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('when the job is done it stops polling, starts the download of the token, and reports done', async () => {
    api.getSubframesArchiveStatus.mockResolvedValue({ ...running, status: 'done', token: 'tok-9' });
    const hook = renderHook(() => useArchiveJob());
    await started(hook);
    await tick();
    expect(hook.result.current.phase).toBe('done');
    expect(clicked).toEqual(['/tmp/tok-9']);
    await tick(2000);
    expect(api.getSubframesArchiveStatus).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(api.cancelSubframesArchive).not.toHaveBeenCalled();
  });

  it('a done status with no token is not a finished download', async () => {
    api.getSubframesArchiveStatus.mockResolvedValue({ ...running, status: 'done' });
    const hook = renderHook(() => useArchiveJob());
    await started(hook);
    await tick();
    expect(hook.result.current.phase).toBe('running');
    expect(clicked).toEqual([]);
    hook.unmount();
  });

  it('an error from the server stops polling and surfaces its message', async () => {
    api.getSubframesArchiveStatus.mockResolvedValue({ ...running, status: 'error', error: 'Disk full' });
    const hook = renderHook(() => useArchiveJob());
    await started(hook);
    await tick();
    expect(hook.result.current).toMatchObject({ phase: 'error', error: 'Disk full' });
    await tick(2000);
    expect(api.getSubframesArchiveStatus).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('a job cancelled on the server returns to idle without an error phase', async () => {
    api.getSubframesArchiveStatus.mockResolvedValue({ ...running, status: 'cancelled' });
    const hook = renderHook(() => useArchiveJob());
    await started(hook);
    await tick();
    expect(hook.result.current.phase).toBe('idle');
    hook.unmount();
  });

  it('keeps polling through a network failure', async () => {
    api.getSubframesArchiveStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ...running, status: 'done', token: 't' });
    const hook = renderHook(() => useArchiveJob());
    await started(hook);
    await tick();
    expect(hook.result.current.phase).toBe('running');
    await tick();
    expect(hook.result.current.phase).toBe('done');
    hook.unmount();
  });

  it('does not start a second poll while one is still in flight', async () => {
    let release!: (v: typeof running) => void;
    api.getSubframesArchiveStatus.mockImplementation(() => new Promise(r => { release = r; }));
    const hook = renderHook(() => useArchiveJob());
    await started(hook);
    await tick(1500);
    expect(api.getSubframesArchiveStatus).toHaveBeenCalledTimes(1);
    await act(async () => { release(running); });
    hook.unmount();
  });

  it('a failure to begin is an error with the message and starts no polling', async () => {
    const hook = renderHook(() => useArchiveJob());
    await started(hook, () => Promise.reject(new Error('Library offline')));
    expect(hook.result.current).toMatchObject({ phase: 'error', error: 'Library offline' });
    await tick(2000);
    expect(api.getSubframesArchiveStatus).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('cancel stops polling, tells the server, and returns to idle', async () => {
    const hook = renderHook(() => useArchiveJob());
    await started(hook);
    await tick();
    act(() => hook.result.current.cancel());
    expect(hook.result.current).toMatchObject({ phase: 'idle', status: null });
    expect(api.cancelSubframesArchive).toHaveBeenCalledWith('job-1');
    await tick(2000);
    expect(api.getSubframesArchiveStatus).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('unmounting mid-job cancels it on the server, not just the poll', async () => {
    const hook = renderHook(() => useArchiveJob());
    await started(hook);
    hook.unmount();
    expect(api.cancelSubframesArchive).toHaveBeenCalledWith('job-1');
    await tick(2000);
    expect(api.getSubframesArchiveStatus).not.toHaveBeenCalled();
  });

  it('a late status for a job that was cancelled is ignored', async () => {
    let release!: (v: typeof running) => void;
    api.getSubframesArchiveStatus.mockImplementation(() => new Promise(r => { release = r; }));
    const hook = renderHook(() => useArchiveJob());
    await started(hook);
    await tick();
    act(() => hook.result.current.cancel());
    await act(async () => { release({ ...running, status: 'done', token: 'late' }); });
    expect(hook.result.current.phase).toBe('idle');
    expect(clicked).toEqual([]);
    hook.unmount();
  });
});
