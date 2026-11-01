// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';

const api = vi.hoisted(() => ({
  getWishlist: vi.fn(),
  addToWishlist: vi.fn(),
  removeWishlistItem: vi.fn(),
  removeWishlistItemByObjectId: vi.fn(),
  updateWishlistItem: vi.fn(),
}));
vi.mock('../../src/lib/api/wishlist', () => api);

import { useWishlist } from '../../src/hooks/useWishlist';
import { renderHook, queryWrapper, waitFor, flush } from './helpers/renderHook';

const item = (id: string, objectId: string) => ({
  id, objectId, name: objectId, type: 'Galaxy', constellation: null, magnitude: null, majorAxisArcmin: null,
  priority: 'medium' as const, notes: '', addedAt: '2026-11-01T00:00:00Z',
});

function mount(initial = [item('w1', 'M31')]) {
  api.getWishlist.mockResolvedValue(initial);
  const { wrapper } = queryWrapper();
  const hook = renderHook(() => useWishlist(), wrapper);
  return hook;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.addToWishlist.mockResolvedValue({});
  api.removeWishlistItem.mockResolvedValue({ deleted: true });
  api.removeWishlistItemByObjectId.mockResolvedValue({ deleted: true });
  api.updateWishlistItem.mockResolvedValue({});
});

describe('useWishlist', () => {
  it('starts empty and loading, then exposes the items and a lookup set', async () => {
    const { result } = mount([item('w1', 'M31'), item('w2', 'M42')]);
    expect(result.current.items).toEqual([]);
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => !result.current.isLoading, 'the list to load');
    expect(result.current.items.map(i => i.objectId)).toEqual(['M31', 'M42']);
    expect(result.current.idSet.has('M42')).toBe(true);
    expect(result.current.idSet.has('M45')).toBe(false);
  });

  it('add sends a complete row with defaults for what the caller left out', async () => {
    const { result } = mount();
    await waitFor(() => !result.current.isLoading);
    act(() => result.current.add({ objectId: 'M45', name: 'Pleiades' }));
    await waitFor(() => api.addToWishlist.mock.calls.length === 1, 'the add call');
    expect(api.addToWishlist.mock.calls[0][0]).toEqual({
      objectId: 'M45', name: 'Pleiades', type: '', constellation: null, magnitude: null, majorAxisArcmin: null, priority: 'medium', notes: '',
    });
  });

  it('add keeps a priority and notes it was given, so an import round-trips', async () => {
    const { result } = mount();
    await waitFor(() => !result.current.isLoading);
    act(() => result.current.add({ objectId: 'M45', name: 'Pleiades', priority: 'high', notes: 'Autumn' }));
    await waitFor(() => api.addToWishlist.mock.calls.length === 1);
    expect(api.addToWishlist.mock.calls[0][0]).toMatchObject({ priority: 'high', notes: 'Autumn' });
  });

  it('add does nothing for an object already on the list, so a second click is never a removal', async () => {
    const { result } = mount();
    await waitFor(() => !result.current.isLoading);
    act(() => result.current.add({ objectId: 'M31', name: 'Andromeda' }));
    await flush();
    expect(api.addToWishlist).not.toHaveBeenCalled();
    expect(api.removeWishlistItemByObjectId).not.toHaveBeenCalled();
  });

  it('toggle removes an object that is on the list and adds one that is not', async () => {
    const { result } = mount();
    await waitFor(() => !result.current.isLoading);
    act(() => result.current.toggle({ objectId: 'M31', name: 'Andromeda' }));
    await waitFor(() => api.removeWishlistItemByObjectId.mock.calls.length === 1);
    expect(api.removeWishlistItemByObjectId).toHaveBeenCalledWith('M31', expect.anything());
    expect(api.addToWishlist).not.toHaveBeenCalled();

    act(() => result.current.toggle({ objectId: 'M45', name: 'Pleiades' }));
    await waitFor(() => api.addToWishlist.mock.calls.length === 1);
    expect(api.addToWishlist.mock.calls[0][0]).toMatchObject({ objectId: 'M45' });
  });

  it('priority and notes edits go to the row id as a patch of just that field', async () => {
    const { result } = mount();
    await waitFor(() => !result.current.isLoading);
    act(() => result.current.setPriority('w1', 'high'));
    await waitFor(() => api.updateWishlistItem.mock.calls.length === 1);
    expect(api.updateWishlistItem.mock.calls[0].slice(0, 2)).toEqual(['w1', { priority: 'high' }]);
    act(() => result.current.setNotes('w1', 'Wait for new moon'));
    await waitFor(() => api.updateWishlistItem.mock.calls.length === 2);
    expect(api.updateWishlistItem.mock.calls[1].slice(0, 2)).toEqual(['w1', { notes: 'Wait for new moon' }]);
  });

  it('remove deletes by row id, not object id', async () => {
    const { result } = mount();
    await waitFor(() => !result.current.isLoading);
    act(() => result.current.remove('w1'));
    await waitFor(() => api.removeWishlistItem.mock.calls.length === 1);
    expect(api.removeWishlistItem.mock.calls[0][0]).toBe('w1');
    expect(api.removeWishlistItemByObjectId).not.toHaveBeenCalled();
  });

  it('refetches after a change, so every surface sees the new list', async () => {
    const { result } = mount();
    await waitFor(() => !result.current.isLoading);
    expect(api.getWishlist).toHaveBeenCalledTimes(1);
    api.getWishlist.mockResolvedValue([item('w1', 'M31'), item('w9', 'M45')]);
    act(() => result.current.add({ objectId: 'M45', name: 'Pleiades' }));
    await waitFor(() => result.current.idSet.has('M45'), 'the refetched list');
    expect(api.getWishlist).toHaveBeenCalledTimes(2);
  });
});
