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
      thresholds: {
        statements: 20,
        branches: 18,
        functions: 22,
        lines: 20,
      },
      reporter: ['text', 'json', 'html'],
    },
  },
});
