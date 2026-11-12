/**
 * Calibration scope filtering (src/lib/calibrationScope.ts).
 *
 * The page's `?scope=` value arrives from a link (Settings → Telescopes) or a
 * hand-edited URL, and the group data arrives from the API. These are the
 * primitives that decide which groups are shown and what the filter offers, so
 * they are tested here rather than through the page.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_SCOPES,
  UNSCOPED,
  buildScopeOptions,
  filterByScope,
  resolveScope,
  scopeValueOf,
} from '../../src/lib/calibrationScope';

/** Stand-in for i18next's `t`: returns the key so assertions read the key. */
const t = (key: string, opts?: Record<string, unknown>) =>
  opts?.name === undefined ? key : `${key}:${String(opts.name)}`;

const groups = [
  { scope: 'scope-a', fileCount: 10 },
  { scope: 'scope-a', fileCount: 5 },
  { scope: 'scope-b', fileCount: 20 },
  { scope: null, fileCount: 2 },
];

describe('scopeValueOf', () => {
  it('maps the shared bucket to a stable sentinel', () => {
    expect(scopeValueOf(null)).toBe(UNSCOPED);
    expect(scopeValueOf('scope-a')).toBe('scope-a');
  });
});

describe('resolveScope', () => {
  it('treats a missing or explicit value as every scope', () => {
    expect(resolveScope(null, groups)).toBe(ALL_SCOPES);
    expect(resolveScope(undefined, groups)).toBe(ALL_SCOPES);
    expect(resolveScope('', groups)).toBe(ALL_SCOPES);
    expect(resolveScope(ALL_SCOPES, groups)).toBe(ALL_SCOPES);
  });

  it('keeps a scope that is present', () => {
    expect(resolveScope('scope-a', groups)).toBe('scope-a');
    expect(resolveScope(UNSCOPED, groups)).toBe(UNSCOPED);
  });

  it('falls back to every scope for an unknown id', () => {
    // A link to a since-deleted telescope, or a hand-edited URL, must not show
    // an empty page.
    expect(resolveScope('scope-gone', groups)).toBe(ALL_SCOPES);
    expect(resolveScope(UNSCOPED, [{ scope: 'scope-a', fileCount: 1 }])).toBe(ALL_SCOPES);
  });
});

describe('filterByScope', () => {
  it('returns everything for the all-scopes value', () => {
    expect(filterByScope(groups, ALL_SCOPES)).toHaveLength(groups.length);
  });

  it('returns only the selected telescope', () => {
    expect(filterByScope(groups, 'scope-a').map(g => g.fileCount)).toEqual([10, 5]);
  });

  it('returns the shared bucket for the unscoped value', () => {
    expect(filterByScope(groups, UNSCOPED)).toEqual([{ scope: null, fileCount: 2 }]);
  });
});

describe('buildScopeOptions', () => {
  const names = new Map([['scope-b', 'Beta'], ['scope-a', 'Alpha']]);

  it('leads with all scopes carrying the total, then telescopes by name, unscoped last', () => {
    const options = buildScopeOptions(groups, names, t);
    expect(options.map(o => o.value)).toEqual([ALL_SCOPES, 'scope-a', 'scope-b', UNSCOPED]);
    expect(options[0]).toEqual({ value: ALL_SCOPES, label: 'calibrations.scope.all', fileCount: 37 });
    expect(options[1]).toEqual({ value: 'scope-a', label: 'Alpha', fileCount: 15 });
    expect(options[2]).toEqual({ value: 'scope-b', label: 'Beta', fileCount: 20 });
    expect(options[3]).toEqual({ value: UNSCOPED, label: 'calibrations.scope.unassigned', fileCount: 2 });
  });

  it('labels a scope with no profile as a deleted telescope', () => {
    const options = buildScopeOptions([{ scope: 'scope-gone', fileCount: 3 }], new Map(), t);
    expect(options[1]).toEqual({
      value: 'scope-gone',
      label: 'calibrations.scope.deleted',
      fileCount: 3,
    });
  });

  it('omits the unscoped option when every group has a telescope', () => {
    const options = buildScopeOptions([{ scope: 'scope-a', fileCount: 1 }], names, t);
    expect(options.map(o => o.value)).toEqual([ALL_SCOPES, 'scope-a']);
  });
});

describe('buildScopeOptions with linked folders', () => {
  const withLinked = [
    ...groups,
    { scope: '@src/src_1', fileCount: 7 },
    { scope: '@src/src_2', fileCount: 3 },
  ];
  const linkedNames = new Map([['@src/src_1', 'Zeta archive'], ['@src/src_2', 'Alpha archive']]);

  it('names a linked folder after its label, never as a deleted telescope', () => {
    const options = buildScopeOptions(withLinked, new Map([['scope-a', 'Dwarf'], ['scope-b', 'Seestar']]), t, linkedNames);
    expect(options.find(o => o.value === '@src/src_1')).toEqual({ value: '@src/src_1', label: 'calibrations.scope.linked:Zeta archive', fileCount: 7 });
    expect(options.some(o => o.label === 'calibrations.scope.deleted')).toBe(false);
  });

  it('lists telescopes, then linked folders by name, then the shared bucket, and counts every frame', () => {
    const options = buildScopeOptions(withLinked, new Map([['scope-a', 'Dwarf'], ['scope-b', 'Seestar']]), t, linkedNames);
    expect(options.map(o => o.value)).toEqual([ALL_SCOPES, 'scope-a', 'scope-b', '@src/src_2', '@src/src_1', UNSCOPED]);
    expect(options[0].fileCount).toBe(47);
  });

  it('keeps a linked scope in the URL round trip', () => {
    expect(resolveScope('@src/src_1', withLinked)).toBe('@src/src_1');
    expect(resolveScope('@src/gone', withLinked)).toBe(ALL_SCOPES);
  });
});

