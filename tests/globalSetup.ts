import fs from 'node:fs';
import path from 'node:path';

/**
 * Vitest globalSetup — runs once before the whole suite.
 *
 * Several backend tests need a DATA_DIR outside os.tmpdir() (the importer's
 * defense-in-depth check refuses upload tempPaths outside os.tmpdir(), so the
 * destination library dir must live elsewhere). They mkdtemp under
 * <repo>/.test-tmp. afterAll cleans each one on a normal run, but a crashed or
 * interrupted run leaves husks behind. Wiping the whole directory here, once,
 * before anything runs keeps the repo root clean without racing any test's
 * own scratch dir (those are created later, per-file).
 */
export default function setup() {
  fs.rmSync(path.join(process.cwd(), '.test-tmp'), { recursive: true, force: true });
  fs.rmSync(path.join(process.cwd(), '.test-data'), { recursive: true, force: true });
}
