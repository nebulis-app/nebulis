// Global test setup
import { afterEach } from 'vitest';
import path from 'path';

// Backend test files that share the default `.test-data` SQLite DB (set via
// `test.env.DATA_DIR` in vitest.config.ts) are individually responsible for
// resetting these tables in their own per-file `beforeEach` (see e.g.
// devicePairing.test.ts). That convention already gives full per-test
// isolation within each file; the only gap is at file boundaries, since
// nothing tears the DB down after the last test of a file, leaving it dirty
// for whichever file runs next. This net closes that gap — it doesn't
// replace each file's own reset (still required, and what documents intent),
// it just guarantees the shared DB can never leak into a future file that
// forgets to add one.
//
// Files that redirect DATA_DIR to their own `mkdtemp` dir (via `vi.hoisted`,
// before any server module loads) own an isolated SQLite file and clean it
// up themselves in `afterAll` — skip those. Frontend (jsdom) tests are pure
// logic and never touch the DB — skip those too.
const SHARED_DATA_DIR = path.join(process.cwd(), '.test-data');
const SHARED_TABLES = ['users', 'notes', 'wishlist', 'connectedDevices', 'devicePairings', 'telescopeProfiles'];

afterEach(async () => {
  if (typeof window !== 'undefined') return;
  if (process.env.DATA_DIR !== SHARED_DATA_DIR) return;
  const { default: db } = await import('../server/lib/db');
  for (const table of SHARED_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});
