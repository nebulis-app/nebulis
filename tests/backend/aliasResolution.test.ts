import { describe, expect, it } from 'vitest';
import snapshot from './fixtures/alias-resolution.snapshot.json';
import { resolveCanonicalId, getAliasesFor } from '../../server/lib/catalogAliases';

// The alias map is read off the records of server/data/dso-catalog.json. This
// snapshot was captured from the old hand-written map and updated only for the
// deliberate corrections of the 2026-10 catalog audit (Caldwell 102/103 and
// eight Sharpless nebulae that are the same object as an NGC/IC one). Every id
// must still resolve to the same canonical id and expose the same alias set — a
// change here means a library folder key would be rewritten by the boot-time
// fold migration.
describe('alias resolution parity with the old hand-written map', () => {
  const entries = Object.entries(snapshot as Record<string, { canonical: string; aliases: string[] }>);

  it('resolves every snapshotted id to the same canonical id', () => {
    const drift: string[] = [];
    for (const [id, expected] of entries) {
      const got = resolveCanonicalId(id);
      if (got !== expected.canonical) drift.push(`${id}: ${expected.canonical} → ${got}`);
    }
    expect(drift).toEqual([]);
  });

  it('still exposes every reverse-alias the old map had (superset check)', () => {
    // The derived map may add MORE valid cross-references than the old hand
    // list (OpenNGC knows IC4715 is M24, NGC6533 is part of M8). What must not
    // happen is losing one the old map had.
    const missing: string[] = [];
    for (const [, expected] of entries) {
      const got = new Set(getAliasesFor(expected.canonical));
      for (const alias of expected.aliases) {
        if (!got.has(alias)) missing.push(`${expected.canonical}: lost ${alias}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
