/**
 * docker/entrypoint.sh decides whether the container drops root. It runs as
 * root inside the image, so these tests stub `id`, `stat`, `setpriv` and
 * `chown` on PATH and assert which command the script finally execs.
 *
 * What matters most: it never chowns, it adopts the owner of the data dir, and
 * it stays root (with a notice) rather than break an existing install.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const entrypoint = path.join(process.cwd(), 'docker', 'entrypoint.sh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-entrypoint-'));
const stubs = path.join(root, 'bin');
const dataDir = path.join(root, 'data');
const libDir = path.join(root, 'library');
const chownMarker = path.join(root, 'chown-called');

function stub(name: string, body: string): void {
  fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

beforeAll(() => {
  fs.mkdirSync(stubs, { recursive: true });
  fs.mkdirSync(dataDir);
  fs.mkdirSync(libDir);
  stub('id', 'echo "${STUB_ID:-0}"');
  stub('stat', 'case "$2" in %u) echo "${STUB_DATA_UID:-0}";; %g) echo "${STUB_DATA_GID:-0}";; esac');
  // setpriv is used three ways: the writability probe (`sh -c 'test -w "$1"' sh PATH`), the deeper
  // `find PATH ...` probe, and the real exec. The entrypoint probes DATA_DIR first and then
  // LIBRARY_DIR; STUB_LIB_EXIT and STUB_FIND_OUT describe the library only, so DATA_DIR always passes.
  stub('setpriv', `prev=; last=
for a in "$@"; do
  [ "$prev" = find ] && { [ "$a" = "$DATA_DIR" ] || echo "\${STUB_FIND_OUT:-}"; exit 0; }
  [ "$a" = "-c" ] && probe=1
  prev=$a; last=$a
done
[ -n "\${probe:-}" ] && { [ "$last" = "$DATA_DIR" ] && exit 0; exit "\${STUB_LIB_EXIT:-0}"; }
echo "SETPRIV $* HOME=$HOME"`);
  stub('chown', `touch "${chownMarker}"`);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function run(env: Record<string, string>) {
  fs.rmSync(chownMarker, { force: true });
  const r = spawnSync('sh', [entrypoint, 'echo', 'RAN'], {
    env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: '/root', DATA_DIR: dataDir, ...env },
    encoding: 'utf8',
  });
  return { out: r.stdout.trim(), err: r.stderr, code: r.status, chowned: fs.existsSync(chownMarker) };
}

describe('docker/entrypoint.sh', () => {
  it('has valid shell syntax', () => {
    expect(spawnSync('sh', ['-n', entrypoint]).status).toBe(0);
  });

  it('does nothing when already unprivileged', () => {
    const r = run({ STUB_ID: '1000', STUB_DATA_UID: '0' });
    expect(r.out).toBe('RAN');
    expect(r.err).toBe('');
  });

  it('drops to the owner of a node-owned data dir (fresh install)', () => {
    const r = run({ STUB_DATA_UID: '1000', STUB_DATA_GID: '1000' });
    expect(r.out).toBe('SETPRIV --reuid=1000 --regid=1000 --clear-groups echo RAN HOME=/tmp');
    expect(r.code).toBe(0);
  });

  it('adopts an arbitrary owner, such as Unraid nobody:users', () => {
    const r = run({ STUB_DATA_UID: '99', STUB_DATA_GID: '100' });
    expect(r.out).toBe('SETPRIV --reuid=99 --regid=100 --clear-groups echo RAN HOME=/tmp');
  });

  it('stays root for a volume created by an older root image, and says how to switch', () => {
    const r = run({ STUB_DATA_UID: '0', STUB_DATA_GID: '0' });
    expect(r.out).toBe('RAN');
    expect(r.err).toContain('owned by root');
    expect(r.err).toContain('chown -R 1000:1000');
  });

  it('stays root when the data directory does not exist', () => {
    const r = run({ STUB_DATA_UID: '1000', DATA_DIR: path.join(root, 'missing') });
    expect(r.out).toBe('RAN');
    expect(r.err).toContain('does not exist');
  });

  it('drops privileges when LIBRARY_DIR is writable by that user', () => {
    const r = run({ STUB_DATA_UID: '1000', STUB_DATA_GID: '1000', LIBRARY_DIR: libDir, STUB_LIB_EXIT: '0' });
    expect(r.out).toContain('SETPRIV --reuid=1000');
  });

  it('stays root, with a warning, when LIBRARY_DIR is not writable by that user', () => {
    const r = run({ STUB_DATA_UID: '1000', STUB_DATA_GID: '1000', LIBRARY_DIR: libDir, STUB_LIB_EXIT: '1' });
    expect(r.out).toBe('RAN');
    expect(r.err).toContain('not writable by uid 1000');
  });

  it('stays root when a folder inside LIBRARY_DIR is not writable (library first filled by a root container)', () => {
    const r = run({ STUB_DATA_UID: '1000', STUB_DATA_GID: '1000', LIBRARY_DIR: libDir, STUB_LIB_EXIT: '0', STUB_FIND_OUT: `${libDir}/M31` });
    expect(r.out).toBe('RAN');
    expect(r.err).toContain('not writable by uid 1000');
  });

  it('ignores a LIBRARY_DIR that does not exist yet', () => {
    const r = run({ STUB_DATA_UID: '1000', STUB_DATA_GID: '1000', LIBRARY_DIR: path.join(root, 'nope'), STUB_LIB_EXIT: '1' });
    expect(r.out).toContain('SETPRIV --reuid=1000');
  });

  it('never changes ownership of anything, in any branch', () => {
    for (const env of [
      { STUB_ID: '1000' },
      { STUB_DATA_UID: '0' },
      { STUB_DATA_UID: '1000', STUB_DATA_GID: '1000' },
      { STUB_DATA_UID: '1000', STUB_DATA_GID: '1000', LIBRARY_DIR: libDir, STUB_LIB_EXIT: '1' },
    ]) {
      expect(run(env).chowned).toBe(false);
    }
  });
});
