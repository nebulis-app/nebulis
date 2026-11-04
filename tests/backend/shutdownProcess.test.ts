/**
 * End to end: start the real server in a child process, send it a real SIGTERM,
 * and check what a supervisor (launchd, NSSM, Docker) cares about: it exits 0,
 * promptly, after logging the shutdown, with the SQLite write-ahead log folded
 * into the main file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { startServer, type RunningServer } from './helpers/serverProcess';

let server: RunningServer | null = null;

afterEach(() => {
  server?.cleanup();
  server = null;
});

describe('server process shutdown', () => {
  it('exits 0 on SIGTERM within the supervisor timeout, logs it, and checkpoints the WAL', async () => {
    server = await startServer();
    const dir = server.dataDir;
    // Make sure the database has live WAL content to fold in.
    expect(fs.existsSync(path.join(dir, 'nebulis.db-wal'))).toBe(true);

    const sentAt = Date.now();
    server.child.kill('SIGTERM');
    const result = await server.exited;

    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    // launchd gives 5s; an idle server should be nowhere near it.
    expect(result.at - sentAt).toBeLessThan(2_500);

    const log = fs.readFileSync(path.join(dir, 'logs', 'server.log'), 'utf8');
    expect(log).toContain('Received SIGTERM, shutting down');
    expect(log).not.toContain('Database close failed');

    const wal = path.join(dir, 'nebulis.db-wal');
    expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0).toBe(true);
  }, 90_000);
});
