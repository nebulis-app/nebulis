/**
 * Bans the three idioms behind every "the app says it's tomorrow" bug.
 *
 * 1. Cutting a date or hour out of `toISOString()`:
 *      new Date().toISOString().slice(0, 10)      // UTC date
 *      d.toISOString().split('T')[0]              // UTC date
 *    That string is Greenwich time. At 19:31 in Iowa it is already 00:31
 *    tomorrow there, which is how the Observations calendar showed Tuesday on
 *    a Monday evening. Use localDateKey (src/lib/nightWindow.ts) or
 *    useLocalToday() in the client, and localDateKey(date, timeZone)
 *    (server/lib/timezone.ts) on the server.
 *
 * 2. `new Date('2026-10-26')`: a date-only string parses as UTC midnight,
 *    which is still the 25th anywhere west of Greenwich. Build a local Date
 *    (dateFromKey, `new Date(y, m - 1, d)`) or keep the string as a key.
 *
 * 3. Server only (option `serverClock: true`): the machine's local clock
 *    (`getHours()`, `getDate()`, `setHours()`, `toDateString()`, a
 *    multi-argument `new Date(y, m, d)`). A Docker server runs in UTC, so
 *    these answer for Greenwich, not for the observing site. Use localParts /
 *    zonedDateTimeToUtc from server/lib/timezone.ts with activeSiteTimeZone()
 *    (server/lib/siteTimeZone.ts) or the site's own zone.
 *
 * A use that is genuinely meant to be UTC (a cache stamp, an archive path in
 * UTC, day arithmetic on a Date that is only a carrier) stays, with an
 * `// eslint-disable-next-line local/no-utc-date-key -- <why>` comment so the
 * reason is on record.
 */

const SLICE_METHODS = new Set(['slice', 'substring', 'substr']);
const CLOCK_METHODS = new Set([
  'getHours', 'getMinutes', 'getSeconds', 'getDate', 'getDay', 'getMonth', 'getFullYear',
  'setHours', 'setMinutes', 'setDate', 'setMonth', 'setFullYear',
  'toDateString', 'toTimeString',
]);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isToISOStringCall(node) {
  return node?.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.property.name === 'toISOString';
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow turning a moment into a date with UTC or the server clock' },
    schema: [{ type: 'object', properties: { serverClock: { type: 'boolean' } }, additionalProperties: false }],
    messages: {
      isoSlice: 'This cuts the date or hour out of a UTC timestamp, which is tomorrow every evening west of Greenwich. Use localDateKey (client: src/lib/nightWindow.ts, server: server/lib/timezone.ts with a site zone).',
      dateOnly: "new Date('YYYY-MM-DD') is UTC midnight, the previous day west of Greenwich. Build a local Date (dateFromKey) or keep the key as a string.",
      serverClock: '{{name}}() reads the server machine clock, which is UTC in Docker, not the observing site. Use localParts/zonedDateTimeToUtc with activeSiteTimeZone() or the site zone.',
      serverLocalCtor: 'new Date(y, m, d, ...) builds the date on the server machine clock (UTC in Docker). Use zonedDateTimeToUtc with the site zone, or Date.UTC for a UTC carrier.',
    },
  },
  create(context) {
    const serverClock = context.options[0]?.serverClock === true;
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        const name = callee.property.name;

        // x.toISOString().slice(0, n) / .substring(0, n) / .split('T')
        if (isToISOStringCall(callee.object)) {
          if (SLICE_METHODS.has(name)) {
            const [start] = node.arguments;
            if (start?.type === 'Literal' && start.value === 0) context.report({ node, messageId: 'isoSlice' });
          } else if (name === 'split') {
            const [sep] = node.arguments;
            if (sep?.type === 'Literal' && sep.value === 'T') context.report({ node, messageId: 'isoSlice' });
          }
          return;
        }

        if (serverClock && CLOCK_METHODS.has(name)) {
          context.report({ node, messageId: 'serverClock', data: { name } });
        }
      },
      NewExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'Date') return;
        const [first] = node.arguments;
        if (node.arguments.length === 1 && first?.type === 'Literal' && typeof first.value === 'string' && DATE_ONLY.test(first.value)) {
          context.report({ node, messageId: 'dateOnly' });
        }
        if (serverClock && node.arguments.length >= 2) {
          context.report({ node, messageId: 'serverLocalCtor' });
        }
      },
    };
  },
};
