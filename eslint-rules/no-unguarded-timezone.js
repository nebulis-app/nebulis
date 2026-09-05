/**
 * Bans a non-literal `timeZone` option on `Intl.DateTimeFormat` /
 * `toLocaleDateString` / `toLocaleTimeString` / `toLocaleString` unless the
 * call is inside a try/catch (or the value is already known-safe — see
 * `isKnownSafeValue` below).
 *
 * Why this exists: a timezone string from a site record or a third-party API
 * (Open-Meteo) isn't guaranteed to be a valid IANA identifier, and passing
 * one Intl rejects throws *synchronously*. Every timezone-aware call in this
 * codebase already guards against that (server/lib/timezone.ts,
 * src/lib/timeFormat.ts, src/lib/altaz.ts) except one that didn't —
 * ForecastPage.tsx's heroNightKey, added 2026-08-30, took down the entire
 * Forecast page for any user whose site or forecast carried a value Open-Meteo
 * or a stale record didn't resolve to a real zone. That value reached the
 * client unvalidated because the server itself only validated it for its own
 * internal date math, not for what it put in the API response — see
 * server/lib/forecastCache.ts's forecastTimezone for the fix on that side;
 * this rule is the fix for every call site downstream of one like it.
 */

const TIMEZONE_METHODS = new Set(['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']);

/** Call expressions whose result is already validated/normalized against
 *  Intl and safe to pass straight through — an allowlist of one on purpose,
 *  so a new "safe" helper has to be added here deliberately rather than the
 *  rule silently trusting anything that merely looks like a getter. */
const SAFE_CALLEE_NAMES = new Set(['timeZoneOrLocal']);

function isKnownSafeValue(valueNode) {
  if (!valueNode) return false;
  if (valueNode.type === 'Literal') return true;
  if (
    valueNode.type === 'CallExpression' &&
    valueNode.callee.type === 'Identifier' &&
    SAFE_CALLEE_NAMES.has(valueNode.callee.name)
  ) {
    return true;
  }
  return false;
}

/** Finds a `timeZone` property in any ObjectExpression argument, including
 *  one contributed via `...(cond ? { timeZone: x } : {})` — the spread
 *  pattern every one of this codebase's real call sites used. */
function findTimeZoneProperty(args) {
  for (const arg of args) {
    if (arg.type === 'ObjectExpression') {
      const found = findInObject(arg);
      if (found) return found;
    }
  }
  return null;
}

function findInObject(objectExpression) {
  for (const prop of objectExpression.properties) {
    if (
      prop.type === 'Property' &&
      !prop.computed &&
      ((prop.key.type === 'Identifier' && prop.key.name === 'timeZone') ||
        (prop.key.type === 'Literal' && prop.key.value === 'timeZone'))
    ) {
      return prop;
    }
    if (prop.type === 'SpreadElement') {
      // ...(cond ? { timeZone: x } : {})  — walk into either branch of the
      // conditional, since only one is live at runtime and we can't know
      // which without evaluating `cond`.
      let expr = prop.argument;
      if (expr.type === 'ConditionalExpression') {
        for (const branch of [expr.consequent, expr.alternate]) {
          if (branch.type === 'ObjectExpression') {
            const found = findInObject(branch);
            if (found) return found;
          }
        }
      } else if (expr.type === 'ObjectExpression') {
        const found = findInObject(expr);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Walks up from `node` looking for an enclosing try block, stopping at the
 *  first function boundary: a try/catch outside the function that contains
 *  this call does not protect a throw from inside it unless the *call* to
 *  that function happens within the try, which is invisible to static
 *  analysis — so a function boundary before finding one is treated the same
 *  as never finding one. */
function isInsideTryBlock(node, sourceCode) {
  let child = node;
  for (const ancestor of [...sourceCode.getAncestors(node)].reverse()) {
    if (ancestor.type === 'TryStatement') {
      return ancestor.block === child;
    }
    if (
      ancestor.type === 'FunctionDeclaration' ||
      ancestor.type === 'FunctionExpression' ||
      ancestor.type === 'ArrowFunctionExpression'
    ) {
      return false;
    }
    child = ancestor;
  }
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a non-literal Intl timeZone value to be either pre-validated (timeZoneOrLocal) or wrapped in try/catch',
    },
    schema: [],
    messages: {
      unguarded:
        'This timeZone value is not a string literal and this call is not inside a try/catch. ' +
        'A value from a site record or a third-party API can be rejected by Intl at runtime, which throws ' +
        'synchronously and (in a render path) crashes the page. Wrap this in try/catch — see formatHm in ' +
        'src/lib/timeFormat.ts or timeZoneOrLocal in server/lib/timezone.ts for the established pattern — ' +
        'or route the value through timeZoneOrLocal first.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function check(node, args) {
      const prop = findTimeZoneProperty(args);
      if (!prop) return;
      if (isKnownSafeValue(prop.value)) return;
      if (isInsideTryBlock(node, sourceCode)) return;
      context.report({ node, messageId: 'unguarded' });
    }

    return {
      'NewExpression[callee.object.name="Intl"][callee.property.name="DateTimeFormat"]'(node) {
        check(node, node.arguments);
      },
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          TIMEZONE_METHODS.has(node.callee.property.name)
        ) {
          check(node, node.arguments);
        }
      },
    };
  },
};
