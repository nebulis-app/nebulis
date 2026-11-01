/**
 * A telescope's storage is untrusted: a card can carry a link to somewhere else on this machine. Reading or writing through
 * one must be refused; a link that stays on the card, and ordinary paths, still work.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { localListDir, localGetFile, localPutFile } from '../../server/lib/smb.local';

let card: string;
let outside: string;
const profile = () => ({ localPath: card });

beforeEach(() => {
  card = fs.mkdtempSync(path.join(os.tmpdir(), 'card-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.mkdirSync(path.join(card, 'MyWorks'));
  fs.writeFileSync(path.join(card, 'MyWorks', 'a.jpg'), 'pic');
});
afterEach(() => {
  fs.rmSync(card, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('links on a USB telescope\'s storage', () => {
  it('refuses to read through a link that leaves the card', async () => {
    fs.symlinkSync(outside, path.join(card, 'escape'));
    await expect(localGetFile('escape/secret.txt', undefined, profile())).rejects.toThrow(/traversal/i);
    await expect(localListDir('escape', profile())).rejects.toThrow(/traversal/i);
  });

  it('refuses to write through a link that leaves the card, even to a file that does not exist yet', async () => {
    fs.symlinkSync(outside, path.join(card, 'escape'));
    await expect(localPutFile('escape/new.txt', Buffer.from('x'), profile())).rejects.toThrow(/traversal/i);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });

  it('still follows a link that stays on the card', async () => {
    fs.symlinkSync(path.join(card, 'MyWorks'), path.join(card, 'shortcut'));
    expect((await localGetFile('shortcut/a.jpg', undefined, profile())).toString()).toBe('pic');
  });

  it('still reads ordinary files, lists folders, and writes new ones', async () => {
    expect((await localGetFile('MyWorks/a.jpg', undefined, profile())).toString()).toBe('pic');
    expect((await localListDir('MyWorks', profile())).map(e => e.name)).toEqual(['a.jpg']);
    await localPutFile('.nebulis.dat', Buffer.from('{}'), profile());
    expect(fs.existsSync(path.join(card, '.nebulis.dat'))).toBe(true);
    expect(await localListDir('Nope', profile())).toEqual([]);
  });
});
