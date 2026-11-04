import { describe, it, expect } from 'vitest';
import { targetLevelText } from '../../src/components/frameAnalysis/frameFormat';

const t = (key: string, opts?: Record<string, unknown>) => `${key.split('.').pop()}:${JSON.stringify(opts ?? {})}`;

describe('what an Object value means', () => {
  it('names the level, and says how many faint frames it takes to reach 3', () => {
    expect(targetLevelText(t, 0)).toMatch(/^none:/);
    expect(targetLevelText(t, 0.4)).toBe('faint:{"value":"0.4","frames":"57"}');
    expect(targetLevelText(t, 2)).toMatch(/^barely:/);
    expect(targetLevelText(t, 9.6)).toMatch(/^clear:/);
    expect(targetLevelText(t, 15)).toMatch(/^plain:/);
  });
});
