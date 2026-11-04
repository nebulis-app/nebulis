import { describe, it, expect } from 'vitest';
import { withDeadline, mapLimit } from '../../server/lib/deadline';

describe('withDeadline', () => {
  it('passes a result through', async () => {
    await expect(withDeadline(Promise.resolve(7), 1000, 'x')).resolves.toBe(7);
  });
  it('rejects a call that never settles', async () => {
    await expect(withDeadline(new Promise(() => {}), 20, 'mount check')).rejects.toThrow('mount check timed out');
  });
});

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async n => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBeLessThanOrEqual(3);
  });
  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
