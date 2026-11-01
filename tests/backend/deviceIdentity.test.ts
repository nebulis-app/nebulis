/**
 * Reading `.nebulis.dat` off a telescope's storage. The file comes off a card, so it is untrusted, and the Mac app
 * reads the same file: both must accept and refuse the same things.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';

const H = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-identity-test-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

import fs from 'fs';
import path from 'path';
import { readIdentity, writeIdentityIfMissing, identityRootOf } from '../../server/lib/deviceIdentity';
import type { TelescopeTransport } from '../../server/lib/telescopeTransports';

afterAll(() => fs.rmSync(H.dir, { recursive: true, force: true }));

let n = 0;
async function readFrom(contents: string) {
  const dir = fs.mkdtempSync(path.join(H.dir, `card-${++n}-`));
  fs.writeFileSync(path.join(dir, '.nebulis.dat'), contents);
  const transport: TelescopeTransport = {
    id: 't', profileId: 'p', kind: 'local', priority: 50, hostname: '', shareName: '', username: '', password: '',
    localPath: dir, lastSeenAt: null, createdAt: new Date().toISOString(),
  };
  return readIdentity(transport);
}

describe('reading the identity file', () => {
  it('reads a file the server wrote', async () => {
    const id = await readFrom(JSON.stringify({ deviceId: 'abc', createdAt: '2026-01-01T00:00:00Z', model: 'dwarf-3', appVersion: '2.1.0' }));
    expect(id).toMatchObject({ deviceId: 'abc', model: 'dwarf-3' });
  });

  it('accepts a file with no createdAt, as the Mac app does', async () => {
    expect(await readFrom(JSON.stringify({ deviceId: 'abc' }))).toMatchObject({ deviceId: 'abc', createdAt: '', model: 'unknown' });
  });

  it('refuses an empty, missing or absurdly long ID', async () => {
    expect(await readFrom(JSON.stringify({ deviceId: '' }))).toBeNull();
    expect(await readFrom(JSON.stringify({ createdAt: 'x' }))).toBeNull();
    expect(await readFrom(JSON.stringify({ deviceId: 'a'.repeat(129) }))).toBeNull();
    expect(await readFrom(JSON.stringify({ deviceId: 'a'.repeat(128) }))).not.toBeNull();
  });

  it('refuses garbage', async () => {
    expect(await readFrom('not json')).toBeNull();
    expect(await readFrom('[1,2]')).toBeNull();
  });
});

describe('where an ASIAIR stick keeps its identity file', () => {
  /** A stick: a volume root with the device's `ASIAir/` folder inside it. */
  function stick() {
    const root = fs.mkdtempSync(path.join(H.dir, `stick-${++n}-`));
    const sub = path.join(root, 'ASIAir');
    fs.mkdirSync(path.join(sub, 'Autorun'), { recursive: true });
    return { root, sub };
  }
  const local = (localPath: string): TelescopeTransport => ({
    id: 't', profileId: 'p', kind: 'local', priority: 50, hostname: '', shareName: '', username: '', password: '',
    localPath, lastSeenAt: null, createdAt: new Date().toISOString(),
  });
  const mark = (dir: string, deviceId: string) =>
    fs.writeFileSync(path.join(dir, '.nebulis.dat'), JSON.stringify({ deviceId, createdAt: '2026-01-01T00:00:00Z', model: 'asiair', appVersion: '1' }));

  it('is the volume root, whether the telescope points at the volume or at the ASIAir folder', () => {
    const { root, sub } = stick();
    expect(identityRootOf(sub)).toBe(root);
    expect(identityRootOf(`${sub}/`)).toBe(root);
    expect(identityRootOf(root)).toBe(root);
    expect(identityRootOf('/Volumes/EMMC Images')).toBe('/Volumes/EMMC Images');
  });

  it('reads the file the Mac wrote at the root, from a path inside ASIAir', async () => {
    const { root, sub } = stick();
    mark(root, 'from-mac');
    expect((await readIdentity(local(sub)))?.deviceId).toBe('from-mac');
    expect((await readIdentity(local(root)))?.deviceId).toBe('from-mac');
  });

  it('still reads a file written inside ASIAir before this rule, and prefers the root one when both exist', async () => {
    const { root, sub } = stick();
    mark(sub, 'old-subfolder');
    expect((await readIdentity(local(root)))?.deviceId).toBeUndefined();
    expect((await readIdentity(local(sub)))?.deviceId).toBe('old-subfolder');
    mark(root, 'at-root');
    expect((await readIdentity(local(sub)))?.deviceId).toBe('at-root');
  });

  it('writes a new file at the volume root, never inside ASIAir', async () => {
    const { root, sub } = stick();
    const result = await writeIdentityIfMissing(local(sub), { model: 'ASIAIR' });
    expect(result.wrote).toBe(true);
    expect(fs.existsSync(path.join(root, '.nebulis.dat'))).toBe(true);
    expect(fs.existsSync(path.join(sub, '.nebulis.dat'))).toBe(false);
    expect((await readIdentity(local(root)))?.deviceId).toBe(result.identity.deviceId);
  });

  it('does not write a second file when one is already inside ASIAir', async () => {
    const { root, sub } = stick();
    mark(sub, 'old-subfolder');
    const result = await writeIdentityIfMissing(local(sub), { model: 'ASIAIR' });
    expect(result).toMatchObject({ wrote: false });
    expect(result.identity.deviceId).toBe('old-subfolder');
    expect(fs.existsSync(path.join(root, '.nebulis.dat'))).toBe(false);
  });
});
