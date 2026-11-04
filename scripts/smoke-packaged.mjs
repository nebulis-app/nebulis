#!/usr/bin/env node
/**
 * Smoke test for a pkg-built server (releases/win/nebulis.exe, or a macOS binary).
 *
 * Unit tests run the server from source, so they cannot see failures that only exist inside the
 * packaged executable: a native addon pkg cannot find (better-sqlite3, sharp), a missing asset, a
 * crash on boot. This runs the real executable and checks two things that have broken before:
 *
 *   1. Boot: the server starts, sharp and better-sqlite3 load, and /api/health answers.
 *   2. Recovery: `--list-users` opens the database (the password-reset command).
 *
 * Usage: node scripts/smoke-packaged.mjs [path-to-exe]   (default: releases/win/nebulis.exe)
 * The native files must sit beside the exe, as they do in releases/win/ and in an install.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = path.resolve(process.argv[2] ?? 'releases/win/nebulis.exe');
const PORT = 18500 + Math.floor(Math.random() * 400);
const BOOT_TIMEOUT_MS = 90_000;

if (!fs.existsSync(exe) || fs.statSync(exe).size < 1_000_000) {
  console.error(`FAIL: ${exe} is missing or empty. Did the build finish?`);
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-smoke-'));
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(PORT) };
const failures = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Output markers that mean the server is broken even if it keeps running.
const FATAL = /FATAL|uncaughtException|Could not load the "sharp"|was not included into executable/;

async function checkBoot() {
  let output = '';
  const child = spawn(exe, [], { env, cwd: path.dirname(exe) });
  const collect = chunk => { output += chunk.toString(); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let exited = null;
  child.on('exit', code => { exited = code; });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let healthy = false;
  while (Date.now() < deadline && exited === null && !FATAL.test(output)) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) { healthy = true; break; }
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  if (healthy) await sleep(3000); // sharp and enrichment load a few seconds after listen
  const fatal = output.match(FATAL);
  child.kill();
  await sleep(500);

  if (!healthy) failures.push(`boot: /api/health never answered${exited !== null ? ` (exit ${exited})` : ''}`);
  if (fatal) failures.push(`boot: fatal error in output: ${fatal[0]}`);
  if (!healthy || fatal) console.error(`--- server output ---\n${output.slice(-3000)}\n---`);
}

function checkRecovery() {
  const run = spawnSync(exe, ['--list-users'], { env, cwd: path.dirname(exe), encoding: 'utf8', timeout: 30_000 });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status !== 0 || !out.includes('Nebulis account recovery') || /Error:/.test(out)) {
    failures.push(`recovery: --list-users failed (exit ${run.status})`);
    console.error(`--- --list-users output ---\n${out.slice(-2000)}\n---`);
  }
}

try {
  await checkBoot();
  checkRecovery(); // after boot, so the database exists
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('OK: packaged server boots, loads sharp and SQLite, and --list-users works.');
