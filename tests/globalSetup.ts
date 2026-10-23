import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

/**
 * Vitest globalSetup — runs once in the main process before the whole suite.
 *
 * Several backend tests need a DATA_DIR outside os.tmpdir() (the importer's
 * defense-in-depth check refuses upload tempPaths outside os.tmpdir(), so the
 * destination library dir must live elsewhere). They mkdtemp under
 * <repo>/.test-tmp. afterAll cleans each one on a normal run, but a crashed or
 * interrupted run leaves husks behind. Wiping the whole directory here, once,
 * before anything runs keeps the repo root clean without racing any test's
 * own scratch dir (those are created later, per-file).
 *
 * The shared SQLite DB lives in a per-run `.test-data/run-<pid>` directory,
 * handed to tests/setup.ts via `provide`. One fixed `.test-data` used to be
 * shared by every concurrent vitest process, which then deleted each other's
 * rows (and this function deleted the other run's whole DB). Directories left
 * by runs whose process is gone are pruned here; this run's is removed on
 * teardown.
 *
 * The fresh-boot DB is created here, in a child process, before any test
 * file runs: tests/setup.ts snapshots it at the start of each file and puts
 * it back at the end, so it needs that baseline to exist up front. A child
 * process (rather than importing db.ts here) keeps the server module graph
 * and its open SQLite handle out of the Vitest main process.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export default function setup(project: TestProject) {
  fs.rmSync(path.join(process.cwd(), '.test-tmp'), { recursive: true, force: true });

  const root = path.join(process.cwd(), '.test-data');
  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.readdirSync(root)) {
    const m = /^run-(\d+)$/.exec(entry);
    if (m && !pidAlive(Number(m[1]))) {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
  }

  const runDir = path.join(root, `run-${process.pid}`);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e',
      "const m = await import('./server/lib/db.ts'); m.default.close(); process.exit(0);"],
    { cwd: process.cwd(), env: { ...process.env, DATA_DIR: runDir }, stdio: 'ignore', timeout: 60_000 },
  );
  project.provide('sharedDataDir', runDir);

  return () => {
    fs.rmSync(runDir, { recursive: true, force: true });
  };
}
