// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';

const api = vi.hoisted(() => ({ getFrameAnalysis: vi.fn(), queueFrameMeasuring: vi.fn() }));
vi.mock('../../src/lib/api/frameAnalysis', () => api);

import { useNightsFrameAnalysis } from '../../src/hooks/useNightsFrameAnalysis';
import { renderHook, queryWrapper, waitFor } from './helpers/renderHook';

const report = (over: Record<string, unknown> = {}) => ({
  objectId: 'M42', date: 'x', frames: [], reference: null, measured: 10, total: 10, pending: 0, failures: {}, ...over,
});

const serve = (byNight: Record<string, ReturnType<typeof report>>) =>
  api.getFrameAnalysis.mockImplementation(async (_obj: string, night: string) => byNight[night]);

function mount(nights: string[], onSettled?: () => void) {
  const { wrapper, client } = queryWrapper();
  return { ...renderHook(() => useNightsFrameAnalysis('M42', nights, onSettled), wrapper), client };
}

beforeEach(() => {
  api.getFrameAnalysis.mockReset();
  api.queueFrameMeasuring.mockReset().mockResolvedValue({});
});

describe('useNightsFrameAnalysis', () => {
  it('is not loaded until every night has a report', async () => {
    serve({ n1: report(), n2: report() });
    const { result } = mount(['n1', 'n2']);
    expect(result.current.loaded).toBe(false);
    await waitFor(() => result.current.loaded, 'both reports');
    expect(result.current).toMatchObject({ unmeasuredNights: [], unmeasuredFrames: 0, measuring: false });
  });

  it('lists the nights with frames that have no grade, and counts them', async () => {
    serve({ n1: report(), n2: report({ measured: 4, total: 10 }), n3: report({ measured: 0, total: 5 }) });
    const { result } = mount(['n1', 'n2', 'n3']);
    await waitFor(() => result.current.loaded);
    expect(result.current.unmeasuredNights).toEqual(['n2', 'n3']);
    expect(result.current.unmeasuredFrames).toBe(11);
  });

  it('does not count a frame that failed to read as still to measure', async () => {
    serve({ n1: report({ measured: 8, total: 10, failures: { 'a.fit': 'unreadable', 'b.fit': 'unreadable' } }) });
    const { result } = mount(['n1']);
    await waitFor(() => result.current.loaded);
    expect(result.current.unmeasuredNights).toEqual([]);
    expect(result.current.unmeasuredFrames).toBe(0);
  });

  it('a night the server is measuring is "measuring", with progress, and is not offered for measuring again', async () => {
    serve({ n1: report({ measured: 3, total: 10, pending: 7 }), n2: report({ measured: 2, total: 6, pending: 4 }), n3: report({ measured: 0, total: 5 }) });
    const { result } = mount(['n1', 'n2', 'n3']);
    await waitFor(() => result.current.loaded);
    expect(result.current).toMatchObject({ measuring: true, done: 5, total: 16, unmeasuredNights: ['n3'], unmeasuredFrames: 5 });
  });

  it('measure queues every unmeasured night, in order, and nothing else', async () => {
    serve({ n1: report(), n2: report({ measured: 0, total: 5 }), n3: report({ measured: 1, total: 5 }) });
    const { result } = mount(['n1', 'n2', 'n3']);
    await waitFor(() => result.current.loaded);
    await act(async () => { await result.current.measure(); });
    expect(api.queueFrameMeasuring.mock.calls.map(c => c.slice(0, 2))).toEqual([['M42', 'n2'], ['M42', 'n3']]);
    expect(result.current).toMatchObject({ starting: false, error: null });
  });

  it('a failure to queue is reported and clears the starting state', async () => {
    serve({ n1: report({ measured: 0, total: 5 }) });
    api.queueFrameMeasuring.mockRejectedValue(new Error('Server busy'));
    const { result } = mount(['n1']);
    await waitFor(() => result.current.loaded);
    await act(async () => { await result.current.measure(); });
    expect(result.current).toMatchObject({ starting: false, error: 'Server busy' });
  });

  it('calls onSettled when measuring finishes, and not at first load', async () => {
    const onSettled = vi.fn();
    serve({ n1: report({ measured: 3, total: 10, pending: 7 }) });
    const { result, client } = mount(['n1'], onSettled);
    await waitFor(() => result.current.measuring, 'measuring to start');
    expect(onSettled).not.toHaveBeenCalled();

    serve({ n1: report({ measured: 10, total: 10, pending: 0 }) });
    await act(async () => { await client.invalidateQueries({ queryKey: ['frame-analysis', 'M42', 'n1', false] }); });
    await waitFor(() => !result.current.measuring, 'measuring to finish');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('never fires onSettled for a night that was never being measured', async () => {
    const onSettled = vi.fn();
    serve({ n1: report() });
    const { result } = mount(['n1'], onSettled);
    await waitFor(() => result.current.loaded);
    expect(onSettled).not.toHaveBeenCalled();
  });
});
