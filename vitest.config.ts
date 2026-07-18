import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environmentMatchGlobs: [
      // Use jsdom for React component tests
      ['tests/frontend/**', 'jsdom'],
    ],
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
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts'],
      exclude: [
        'server/index.ts',         // startup wiring, not unit-testable
        'server/routes/openapi.ts', // static spec literal
        '**/*.d.ts',
        '**/node_modules/**',
      ],
      // Floors are set just under actual coverage (re-check with `--coverage`
      // and ratchet up as coverage climbs) so a real regression trips CI
      // instead of hiding under a multi-point cushion. `server/lib/**` gets
      // its own, higher floor: without it, routes/'s near-0% (architectural,
      // see CLAUDE.md — routes are thin, tested via the lib/ functions they
      // delegate to) blends into the global average and could mask a
      // regression in lib/'s actual business logic while the blended number
      // still clears the global floor.
      thresholds: {
        statements: 29,
        branches: 24,
        functions: 33,
        lines: 29,
        'server/lib/**': {
          statements: 39,
          branches: 34,
          functions: 43,
          lines: 40,
        },
      },
      reporter: ['text', 'json', 'html'],
    },
  },
});
