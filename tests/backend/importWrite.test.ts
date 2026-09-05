import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeFileIntoLibrary, copyTransportFile } from '../../server/lib/library/importWrite';
import type { TelescopeProfile } from '../../server/lib/telescopes';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-importwrite-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A `local` transport profile pointed at `srcDir` — copyTransportFile /
 *  smbCopyFileTo resolve paths relative to it. */
function localProfile(srcDir: string): TelescopeProfile {
  return { id: 'p', name: 'T', kind: 'other', connectionType: 'local', localPath: srcDir } as unknown as TelescopeProfile;
}

let workdir: string;
let srcDir: string;
let objDir: string;
beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(root, 'case-'));
  srcDir = path.join(workdir, 'device');
  objDir = path.join(workdir, 'lib', 'M42');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(objDir, { recursive: true });
});

describe('writeFileIntoLibrary', () => {
  it('copies a new transport file and reports it as new', async () => {
    fs.writeFileSync(path.join(srcDir, 'a.fit'), 'hello-fits');
    const out = await writeFileIntoLibrary(
      { source: 'a.fit', destRel: 'a.fit', expectedSize: 10, sourceKind: 'transport' },
      { profile: localProfile(srcDir), objectDir: objDir },
    );
    expect(out.status).toBe('new');
    expect(out).toMatchObject({ bytes: 10 });
    expect(fs.readFileSync(path.join(objDir, 'a.fit'), 'utf8')).toBe('hello-fits');
    expect(fs.existsSync(path.join(objDir, 'a.fit.tmp'))).toBe(false);
  });

  it('skips a file already present at the expected size', async () => {
    fs.writeFileSync(path.join(srcDir, 'a.fit'), 'hello-fits');
    fs.writeFileSync(path.join(objDir, 'a.fit'), 'hello-fits');
    const out = await writeFileIntoLibrary(
      { source: 'a.fit', destRel: 'a.fit', expectedSize: 10, sourceKind: 'transport' },
      { profile: localProfile(srcDir), objectDir: objDir },
    );
    expect(out).toEqual({ status: 'exists', bytes: 10, localPath: path.join(objDir, 'a.fit') });
  });

  it('heals a truncated file from a prior interrupted run', async () => {
    fs.writeFileSync(path.join(srcDir, 'a.fit'), 'hello-fits');   // 10 bytes
    fs.writeFileSync(path.join(objDir, 'a.fit'), 'hel');          // partial
    const out = await writeFileIntoLibrary(
      { source: 'a.fit', destRel: 'a.fit', expectedSize: 10, sourceKind: 'transport' },
      { profile: localProfile(srcDir), objectDir: objDir },
    );
    expect(out.status).toBe('new');
    expect(fs.readFileSync(path.join(objDir, 'a.fit'), 'utf8')).toBe('hello-fits');
  });

  it('rejects a size mismatch on a transport copy and leaves no tmp file', async () => {
    fs.writeFileSync(path.join(srcDir, 'a.fit'), 'hello-fits');
    const out = await writeFileIntoLibrary(
      { source: 'a.fit', destRel: 'a.fit', expectedSize: 999, sourceKind: 'transport' },
      { profile: localProfile(srcDir), objectDir: objDir },
    );
    expect(out.status).toBe('error');
    expect((out as { reason: string }).reason).toMatch(/size mismatch/i);
    expect(fs.existsSync(path.join(objDir, 'a.fit'))).toBe(false);
    expect(fs.existsSync(path.join(objDir, 'a.fit.tmp'))).toBe(false);
  });

  it('does not size-check a localCopy (folder wizard) — the source is trusted', async () => {
    fs.writeFileSync(path.join(srcDir, 'a.fit'), 'hello-fits');
    const out = await writeFileIntoLibrary(
      { source: path.join(srcDir, 'a.fit'), destRel: 's/a.fit', expectedSize: 999, sourceKind: 'localCopy' },
      { objectDir: objDir },
    );
    expect(out.status).toBe('new');
    expect((out as { bytes: number }).bytes).toBe(10);
    expect(fs.existsSync(path.join(objDir, 's', 'a.fit'))).toBe(true);
  });

  it('refuses a destination that escapes the object directory', async () => {
    const out = await writeFileIntoLibrary(
      { source: path.join(srcDir, 'a.fit'), destRel: '../evil.fit', sourceKind: 'localCopy' },
      { objectDir: objDir },
    );
    expect(out.status).toBe('error');
    expect((out as { reason: string }).reason).toMatch(/outside object directory/i);
  });

  it('enqueues a landed FITS for thumbnailing, but not a JPEG', async () => {
    fs.writeFileSync(path.join(srcDir, 'a.fit'), 'x');
    fs.writeFileSync(path.join(srcDir, 'b.jpg'), 'y');
    const pushed: string[] = [];
    const ctx = { profile: localProfile(srcDir), objectDir: objDir, thumbnailQueue: { push: (p: string) => pushed.push(path.basename(p)) } };
    await writeFileIntoLibrary({ source: 'a.fit', destRel: 'a.fit', sourceKind: 'transport' }, ctx);
    await writeFileIntoLibrary({ source: 'b.jpg', destRel: 'b.jpg', sourceKind: 'transport' }, ctx);
    expect(pushed).toEqual(['a.fit']);
  });
});

describe('copyTransportFile', () => {
  it('streams a local-transport file straight to the destination', async () => {
    fs.writeFileSync(path.join(srcDir, 'big.bin'), Buffer.alloc(2048, 3));
    const dest = path.join(objDir, 'big.bin');
    const bytes = await copyTransportFile('big.bin', dest, localProfile(srcDir));
    expect(bytes).toBe(2048);
    expect(fs.statSync(dest).size).toBe(2048);
  });
});
