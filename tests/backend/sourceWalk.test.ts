import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { walkSource } from '../../server/lib/library/sourceWalk';

const SETTINGS = { importJpg: true, importFits: true, importThumbnails: true };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-sourcewalk-test-'));
}

const dirsToClean: string[] = [];
function makeTmpDir(): string {
  const dir = tmpDir();
  dirsToClean.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('walkSource', () => {
  it('finds real files at arbitrary depth and reports relative posix paths', async () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'Stacked_1_M42.jpg'), 'x');

    const result = await walkSource(root, SETTINGS);
    expect(result.truncated).toBe(false);
    expect(result.unreadableDirs).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].relPath).toBe('a/b/c/Stacked_1_M42.jpg');
    expect(result.files[0].size).toBe(1);
  });

  it('skips dot-directories and known OS junk directories', async () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, '.thumbs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.thumbs', 'preview.jpg'), 'x');
    fs.mkdirSync(path.join(root, '$RECYCLE.BIN'), { recursive: true });
    fs.writeFileSync(path.join(root, '$RECYCLE.BIN', 'deleted.jpg'), 'x');
    fs.writeFileSync(path.join(root, 'real.jpg'), 'x');

    const result = await walkSource(root, SETTINGS);
    expect(result.files.map(f => f.relPath)).toEqual(['real.jpg']);
  });

  it('tolerates an unreadable subdirectory instead of aborting the whole walk', async () => {
    const root = makeTmpDir();
    const blocked = path.join(root, 'blocked');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(root, 'ok.jpg'), 'x');
    fs.chmodSync(blocked, 0o000);

    try {
      const result = await walkSource(root, SETTINGS);
      expect(result.files.map(f => f.relPath)).toContain('ok.jpg');
      // Root running as a privileged user can still read a 0o000 dir; only
      // assert the unreadable-dir report when it actually couldn't.
      if (result.unreadableDirs.length > 0) {
        expect(result.unreadableDirs).toContain('blocked');
      }
    } finally {
      fs.chmodSync(blocked, 0o755); // afterEach's rmSync needs this back
    }
  });

  it('follows a symlinked directory once but never loops on a cycle', async () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.writeFileSync(path.join(root, 'real', 'photo.jpg'), 'x');
    // A symlink cycle: loop/back -> root.
    fs.mkdirSync(path.join(root, 'loop'), { recursive: true });
    try {
      fs.symlinkSync(root, path.join(root, 'loop', 'back'), 'dir');
    } catch {
      return; // symlink creation can require elevated privilege on some CI hosts
    }

    const result = await walkSource(root, SETTINGS);
    expect(result.truncated).toBe(false);
    expect(result.files.map(f => f.relPath).sort()).toEqual(['real/photo.jpg']);
  });

  it('stops descending past the depth cap and reports truncated', async () => {
    const root = makeTmpDir();
    let dir = root;
    for (let i = 0; i < 12; i++) {
      dir = path.join(dir, `d${i}`);
      fs.mkdirSync(dir);
    }
    fs.writeFileSync(path.join(dir, 'too-deep.jpg'), 'x');

    const result = await walkSource(root, SETTINGS);
    expect(result.truncated).toBe(true);
    expect(result.files.map(f => f.relPath)).not.toContain(
      Array.from({ length: 12 }, (_, i) => `d${i}`).join('/') + '/too-deep.jpg',
    );
  });

  it('reports skipped files with a reason, the same shape folderScan.ts uses', async () => {
    const root = makeTmpDir();
    fs.writeFileSync(path.join(root, '.DS_Store'), 'x');
    const result = await walkSource(root, SETTINGS);
    expect(result.files).toEqual([]);
    // .DS_Store is 'not-a-real-file', which countSkip deliberately never
    // tallies (see importFilter.ts) — it should vanish silently, not appear
    // as a reported skip reason.
    expect(result.skipped).toEqual([]);
  });
});

describe('walkSource: Thumbnail directories', () => {
  const layout = (root: string) => {
    fs.mkdirSync(path.join(root, 'cap', 'Thumbnail'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cap', 'stacked.jpg'), 'x');
    // A Dwarf Star Trails per-frame preview: nothing in the name marks it as a preview, so only the
    // directory it sits in says so.
    fs.writeFileSync(path.join(root, 'cap', 'Thumbnail', 'startrails_10s0_20260405-002247974_26C.jpg'), 'x');
  };

  it('does not walk them, exactly as the copy import does not', async () => {
    const root = makeTmpDir();
    layout(root);
    expect((await walkSource(root, SETTINGS)).files.map(f => f.relPath)).toEqual(['cap/stacked.jpg']);
  });

  it('matches the directory name however it is spelled', async () => {
    const root = makeTmpDir();
    for (const name of ['Thumbnail', 'thumbnails', 'THUMBNAILS']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'frame_20260405-002247.jpg'), 'x');
    }
    expect((await walkSource(root, SETTINGS)).files).toEqual([]);
  });

  it('walks them in archive mode, which keeps everything the device holds', async () => {
    const root = makeTmpDir();
    layout(root);
    const files = (await walkSource(root, { ...SETTINGS, archiveAllFiles: true })).files.map(f => f.relPath).sort();
    expect(files).toEqual(['cap/Thumbnail/startrails_10s0_20260405-002247974_26C.jpg', 'cap/stacked.jpg']);
  });

  it('still walks a directory that merely contains the word', async () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, 'Thumbnail Album'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Thumbnail Album', 'Stacked_1_M42.jpg'), 'x');
    expect((await walkSource(root, SETTINGS)).files).toHaveLength(1);
  });
});

describe('walkSource: depth cap', () => {
  it('skips only the too-deep branch and still walks the siblings after it', async () => {
    const root = makeTmpDir();
    // "a-deep" sorts before "b-shallow", so the old whole-walk abort would have lost b-shallow.
    let dir = path.join(root, 'a-deep');
    fs.mkdirSync(dir);
    for (let i = 0; i < 10; i++) {
      dir = path.join(dir, `d${i}`);
      fs.mkdirSync(dir);
    }
    fs.writeFileSync(path.join(dir, 'too-deep.jpg'), 'x');
    fs.mkdirSync(path.join(root, 'b-shallow'));
    fs.writeFileSync(path.join(root, 'b-shallow', 'ok.jpg'), 'x');
    fs.writeFileSync(path.join(root, 'z-top.jpg'), 'x');

    const result = await walkSource(root, SETTINGS);
    expect(result.truncated).toBe(true);
    expect(result.depthLimited).toBe(true);
    expect(result.files.map(f => f.relPath).sort()).toEqual(['b-shallow/ok.jpg', 'z-top.jpg']);
  });

  it('does not flag depthLimited for a tree within the cap', async () => {
    const root = makeTmpDir();
    fs.writeFileSync(path.join(root, 'a.jpg'), 'x');
    expect((await walkSource(root, SETTINGS)).depthLimited).toBe(false);
  });
});

describe('walkSource: does not hold the event loop', () => {
  it('lets timers run while it reads a large tree', async () => {
    const root = makeTmpDir();
    for (let d = 0; d < 10; d++) {
      const dir = path.join(root, `M${d + 1}`);
      fs.mkdirSync(dir);
      for (let f = 0; f < 150; f++) fs.writeFileSync(path.join(dir, `Light_${f}.jpg`), 'x');
    }
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    try {
      const result = await walkSource(root, SETTINGS);
      expect(result.files).toHaveLength(1500);
    } finally {
      clearInterval(timer);
    }
    // A synchronous walk of 1,500 files gives other work no turn at all, so the count would be zero.
    expect(ticks).toBeGreaterThan(0);
  });
});
