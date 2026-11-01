// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shouldShowSupportAsk, markSupportAskSeen, SUPPORT_ASK_SEEN_KEY, COFFEE_URL } from '../../src/lib/support';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('support ask gating', () => {
  it('is due until it has been seen, then never again', () => {
    expect(shouldShowSupportAsk()).toBe(true);
    markSupportAskSeen();
    expect(shouldShowSupportAsk()).toBe(false);
    expect(localStorage.getItem(SUPPORT_ASK_SEEN_KEY)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is not shown when storage cannot remember that it was, rather than asking on every load', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(shouldShowSupportAsk()).toBe(false);
  });

  it('marking it seen with storage blocked does not throw', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => markSupportAskSeen()).not.toThrow();
  });

  it('points at the Buy Me a Coffee page the About section uses', () => {
    expect(COFFEE_URL).toBe('https://buymeacoffee.com/brent873');
  });
});
