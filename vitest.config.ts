import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // tests/lab needs the Docker lab (npm run lab:up); it has its own config, vitest.lab.config.ts.
    exclude: ['**/node_modules/**', 'tests/lab/**'],
    // The test environment is chosen per file with a
    // `// @vitest-environment jsdom` docblock. This config previously used
    // `environmentMatchGlobs: [['tests/frontend/**', 'jsdom']]`, but Vitest 4
    // removed that option and ignores unknown keys silently, so every frontend
    // test was in fact running under `node` and DOM globals (localStorage,
    // matchMedia) were undefined. The docblock is the supported replacement;
    // files that render React declare it explicitly.
    setupFiles: ['tests/setup.ts'],
    // Wipe leftover <repo>/.test-tmp scratch dirs once before the suite so a
    // previously crashed run doesn't accumulate husks in the repo root.
    globalSetup: ['tests/globalSetup.ts'],
    // Isolate tests from the dev database — paths.ts reads DATA_DIR at module
    // load time, so this must be set here (worker env) not in a setupFile.
    env: {
      DATA_DIR: path.join(process.cwd(), '.test-data'),
    },
    // Backend tests share a single SQLite database — run files sequentially
    // to prevent concurrent beforeEach cleanups from racing across test files.
    fileParallelism: false,
    // A stray `.only` would silently narrow the suite and leave CI green.
    allowOnly: false,
    coverage: {
      provider: 'v8',
      // A red run is the one where a coverage regression most needs to be visible.
      reportOnFailure: true,
      // `src/lib` and `src/hooks` are plain TypeScript the frontend tests can reach, so they
      // are measured. Components and pages are layout, covered from outside by Playwright.
      include: ['server/**/*.ts', 'src/lib/**/*.ts', 'src/hooks/**/*.ts'],
      exclude: [
        'server/index.ts',         // startup wiring, not unit-testable
        'server/routes/openapi.ts', // static spec literal
        '**/*.d.ts',
        '**/node_modules/**',
      ],
      // Floors are set just under actual coverage (re-check with `--coverage`
      // and ratchet up as coverage climbs) so a real regression trips CI
      // instead of hiding under a multi-point cushion. `server/lib/**` gets
      // its own, higher floor: without it, routes/'s near-0% (architectural:
      // routes are thin, tested via the lib/ functions they delegate to)
      // blends into the global average and could mask a
      // regression in lib/'s actual business logic while the blended number
      // still clears the global floor.
      // Actual minus about two points, so a real regression trips CI. Measured 2026-11-01:
      // all measured files 72.5 / 65.8 / 72.8 / 74.1 (stmts / branches / funcs / lines),
      // server/lib 81.4 / 74.2 / 86.1, src 49.0 / 47.7 / 40.6. The global figure blends server
      // and src, so the per-area floors below are the ones that carry the promise.
      thresholds: {
        statements: 70,
        branches: 63,
        functions: 70,
        lines: 72,
        'server/lib/**': {
          statements: 79,
          branches: 72,
          functions: 84,
          lines: 78,
        },
        'src/**': {
          statements: 47,
          branches: 46,
          functions: 38,
          lines: 47,
        },
      },
      reporter: ['text', 'json', 'html'],
    },
  },
});
