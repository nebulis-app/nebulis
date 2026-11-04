// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { supportAskSeenLocally, markSupportAskSeen, SUPPORT_ASK_SEEN_KEY, COFFEE_URL } from '../../src/lib/support';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('support ask local copy', () => {
  it('has no record until the ask is marked seen, then keeps one', () => {
    expect(supportAskSeenLocally()).toBe(false);
    markSupportAskSeen();
    expect(supportAskSeenLocally()).toBe(true);
    expect(localStorage.getItem(SUPPORT_ASK_SEEN_KEY)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('counts unreadable storage as no record, since the server is what remembers the dismissal', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(supportAskSeenLocally()).toBe(false);
  });

  it('marking it seen with storage blocked does not throw', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => markSupportAskSeen()).not.toThrow();
  });

  it('points at the Buy Me a Coffee page the About section uses', () => {
    expect(COFFEE_URL).toBe('https://buymeacoffee.com/brent873');
  });
});
