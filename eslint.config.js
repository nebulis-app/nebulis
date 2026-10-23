import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import noUnguardedTimezone from './eslint-rules/no-unguarded-timezone.js'
import noHardcodedJsxText from './eslint-rules/no-hardcoded-jsx-text.js'

export default defineConfig([
  // server/assets/pixinsight is PixInsight's own JavaScript dialect (`#engine`, `#feature-id` directives), not parseable as ES.
  globalIgnores(['dist', 'coverage', 'server/dist', 'server/assets/pixinsight']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      local: { rules: { 'no-unguarded-timezone': noUnguardedTimezone, 'no-hardcoded-jsx-text': noHardcodedJsxText } },
    },
    rules: {
      'local/no-unguarded-timezone': 'error',
    },
  },
  {
    // i18n regression guard (issue #6 migration). The rule only activates
    // inside a file that already imports useTranslation/Trans from
    // react-i18next, so it holds already-migrated files (chunks 0-5 so far)
    // to the standard without flagging the still-English chunks 6-10 files —
    // no directory allowlist to maintain as the migration progresses. See
    // eslint-rules/no-hardcoded-jsx-text.js for exactly what it checks.
    files: ['src/**/*.tsx'],
    rules: {
      'local/no-hardcoded-jsx-text': 'error',
    },
  },
  {
    // Off in tests: a test's timezone values typically come from a chain the
    // rule can't trace through a variable binding (e.g.
    // observerTimezoneForCoordinates(...), which is already validated) —
    // real false positives, not render-path code that can crash a user.
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'local/no-unguarded-timezone': 'off',

      // `require()` is the correct and only tool inside `vi.hoisted()`: that
      // callback is hoisted above the module's own ESM imports and must run
      // synchronously, so it cannot `await import()`. Redirecting DATA_DIR /
      // LIBRARY_DIR there, before any server module captures them at import
      // time, is the established pattern across tests/backend. Every one of
      // these was previously counted as an error, which buried the real
      // violations under ~220 false positives. `scripts/**` keeps the rule:
      // nothing there needs a hoisted synchronous require.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Zone boundary: the SPA and the server share no code. The /api contract
    // (and the OpenAPI spec) is the only link, so neither side may import the
    // other's files. tests/ is deliberately out of scope (parity tests import
    // both zones). The server/lib and server/routes blocks below repeat the
    // src ban because a later block's no-restricted-imports replaces this one.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/server/**'],
          message: 'Zone boundary: src/ must not import from server/. Go through the /api contract.',
        }],
      }],
    },
  },
  {
    files: ['server/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/src/**'],
          message: 'Zone boundary: server/ must not import from src/.',
        }],
      }],
    },
  },
  {
    // Layer boundary: src/lib and src/hooks sit below the UI, so they must
    // never import components, pages or contexts.
    files: ['src/lib/**/*.{ts,tsx}', 'src/hooks/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['**/server/**'],
            message: 'Zone boundary: src/ must not import from server/. Go through the /api contract.',
          },
          {
            group: ['**/components/**', '**/pages/**', '**/contexts/**'],
            message: 'Upward dependency: src/lib and src/hooks must never import components, pages or contexts.',
          },
        ],
      }],
    },
  },
  {
    // Layer boundary: server/lib and server/middleware must never import from
    // server/routes — dependencies flow index.ts → routes → middleware → lib,
    // never back up. Zero violations today; this rule exists to keep it that
    // way, since nothing else currently enforces it.
    files: ['server/lib/**/*.ts', 'server/middleware/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['**/routes/*'],
            message: 'Upward dependency: server/lib and server/middleware must never import from server/routes.',
          },
          {
            group: ['**/src/**'],
            message: 'Zone boundary: server/ must not import from src/.',
          },
        ],
      }],
    },
  },
  {
    // Repository pattern: routes must not talk to SQLite directly — they call
    // a named lib/ function (e.g. resetLibraryData, getObjectInfo) instead of
    // db.prepare/db.exec. Only the default export (the raw Database handle)
    // is restricted, so importing named helpers from lib/db.js is still fine.
    // Keeps queries testable in isolation from Express and means a schema
    // change breaks in one place, not silently at request time.
    files: ['server/routes/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: '../lib/db.js',
          importNames: ['default'],
          message: 'Routes must not access the database directly. Add a function to the owning lib/ module instead.',
        }],
        patterns: [{
          group: ['**/src/**'],
          message: 'Zone boundary: server/ must not import from src/.',
        }],
      }],
    },
  },
])
