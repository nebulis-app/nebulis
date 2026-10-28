/**
 * Starts the real server (server/index.ts) in a child process against a scratch
 * DATA_DIR, in the same test mode the Import Lab uses (no LAN discovery, no
 * scheduled jobs). For tests that need the actual middleware stack and mounts
 * rather than a single router.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RunningServer {
  port: number;
  url: string;
  dataDir: string;
  child: ChildProcess;
  /** Resolves when the process exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  /** Kills the process and removes the scratch directory. */
  cleanup(): void;
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('timed out waiting for the server to answer /api/v1/health');
}

export async function startServer(): Promise<RunningServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-server-'));
  const port = 41000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), NEBULIS_TEST_MODE: '1', NODE_ENV: 'development' },
    stdio: 'ignore',
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() }));
  });
  const url = `http://127.0.0.1:${port}`;
  const server: RunningServer = {
    port, url, dataDir, child, exited,
    cleanup() {
      child.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  try {
    await waitFor(async () => {
      try { return (await fetch(`${url}/api/v1/health`)).ok; } catch { return false; }
    }, 60_000);
  } catch (err) {
    server.cleanup();
    throw err;
  }
  return server;
}
