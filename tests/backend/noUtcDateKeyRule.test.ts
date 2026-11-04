import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../eslint-rules/no-utc-date-key.js';

// RuleTester calls describe/it itself; point it at vitest's.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

describe('local/no-utc-date-key', () => {
  tester.run('client', rule, {
    valid: [
      'localDateKey(new Date())',
      "new Date(`${key}T12:00:00`)",
      "new Date('2026-10-26T12:00:00')",
      'new Date(2026, 9, 26)',
      'd.toISOString()',
      'd.getHours()',
      's.slice(0, 10)',
    ],
    invalid: [
      { code: 'new Date().toISOString().slice(0, 10)', errors: [{ messageId: 'isoSlice' }] },
      { code: "d.toISOString().split('T')[0]", errors: [{ messageId: 'isoSlice' }] },
      { code: 'd.toISOString().substring(0, 13)', errors: [{ messageId: 'isoSlice' }] },
      { code: "new Date('2026-10-26')", errors: [{ messageId: 'dateOnly' }] },
    ],
  });

  tester.run('server', rule, {
    valid: [
      { code: 'localParts(now, tz).hour', options: [{ serverClock: true }] },
      { code: 'new Date(Date.UTC(2026, 9, 26))', options: [{ serverClock: true }] },
      { code: 'new Date(ms)', options: [{ serverClock: true }] },
    ],
    invalid: [
      { code: 'now.getHours()', options: [{ serverClock: true }], errors: [{ messageId: 'serverClock' }] },
      { code: 'd.setDate(d.getDate() - 1)', options: [{ serverClock: true }], errors: [{ messageId: 'serverClock' }, { messageId: 'serverClock' }] },
      { code: 'now.toTimeString()', options: [{ serverClock: true }], errors: [{ messageId: 'serverClock' }] },
      { code: 'new Date(y, m, d, 12)', options: [{ serverClock: true }], errors: [{ messageId: 'serverLocalCtor' }] },
    ],
  });
});
