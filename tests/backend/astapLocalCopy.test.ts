/**
 * The ASTAP binary is downloaded into the data directory but run from a copy in the machine's own temp directory.
 * A Docker data directory is often a bind mount (macOS file sharing, exFAT, a network drive) and Linux cannot exec a
 * file there: execve says ENOENT for a file that exists (issue #42). These tests pin the copy, not the mount.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { ensureLocalCopy } from '../../server/lib/annotate/astap';

const BIN = 'astap_cli';
const posix = process.platform !== 'win32';
let root: string;
let src: string;
let dest: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'astap-copy-'));
  src = path.join(root, 'data', 'astap');
  dest = path.join(root, 'local', 'run');
  fs.mkdirSync(path.join(src, 'db'), { recursive: true });
  fs.writeFileSync(path.join(src, BIN), '#!/bin/sh\necho "ASTAP 2026 $@"\n', { mode: 0o644 });
  fs.writeFileSync(path.join(src, 'db', 'd05_0101.1476'), 'stars');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ensureLocalCopy', () => {
  it('copies the executable and returns the local path', () => {
    const cmd = ensureLocalCopy(src, dest, BIN);
    expect(cmd).toBe(path.join(dest, BIN));
    expect(fs.readFileSync(cmd, 'utf8')).toBe(fs.readFileSync(path.join(src, BIN), 'utf8'));
  });

  it.runIf(posix)('makes the copy executable even when the download was not', () => {
    const cmd = ensureLocalCopy(src, dest, BIN);
    expect(fs.statSync(cmd).mode & 0o111).not.toBe(0);
    expect(execFileSync(cmd, ['-h']).toString()).toContain('ASTAP');
  });

  it('leaves the star database where it is', () => {
    ensureLocalCopy(src, dest, BIN);
    expect(fs.existsSync(path.join(dest, 'db'))).toBe(false);
    expect(fs.readdirSync(dest)).toEqual([BIN]);
  });

  it('does not copy again when nothing changed', () => {
    const cmd = ensureLocalCopy(src, dest, BIN);
    const first = fs.statSync(cmd);
    // A second copy would write a new file with a new inode and a fresh mtime.
    ensureLocalCopy(src, dest, BIN);
    const second = fs.statSync(cmd);
    expect(second.ino).toBe(first.ino);
    expect(second.mtimeMs).toBe(first.mtimeMs);
  });

  it('copies again when the downloaded solver is replaced', () => {
    const cmd = ensureLocalCopy(src, dest, BIN);
    fs.writeFileSync(path.join(src, BIN), '#!/bin/sh\necho "ASTAP newer build"\n');
    ensureLocalCopy(src, dest, BIN);
    expect(fs.readFileSync(cmd, 'utf8')).toContain('newer build');
  });

  it('leaves no temporary files behind', () => {
    ensureLocalCopy(src, dest, BIN);
    expect(fs.readdirSync(dest).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });

  it('copies the files a Windows build ships beside the executable', () => {
    fs.writeFileSync(path.join(src, 'helper.dll'), 'dll');
    ensureLocalCopy(src, dest, BIN);
    expect(fs.readdirSync(dest).sort()).toEqual([BIN, 'helper.dll'].sort());
  });

  it('says so when the solver is not installed', () => {
    fs.rmSync(path.join(src, BIN));
    expect(() => ensureLocalCopy(src, dest, BIN)).toThrow(/not installed/);
  });
});
