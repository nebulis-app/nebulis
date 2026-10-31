/**
 * Fake telescope storage as real volumes: small disk images that macOS mounts under /Volumes, the way a Seestar's memory card
 * shows up when it is plugged in. Two images given the same volume name are told apart by macOS only by a numeric suffix, which is
 * exactly how two real Seestars look.
 *
 * Only the volumes this module mounted are ever detached, and `unplugAll` is safe to call from an `afterEach`.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** True when disk images can be made and mounted here: macOS with `hdiutil`. */
export const canMountDiskImages = process.platform === 'darwin';

const mounted = new Set<string>();

/** Formats an image holding an empty Seestar-style tree (`MyWorks/<object>/`). Left unplugged. */
export function makeCard(workDir: string, volumeName: string, objects: string[] = ['M 42']): string {
  const dmg = path.join(workDir, `${volumeName.replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 8)}.dmg`);
  execFileSync('hdiutil', ['create', '-size', '24m', '-fs', 'HFS+', '-volname', volumeName, dmg], { stdio: 'pipe' });
  const mount = plug(dmg);
  for (const object of objects) fs.mkdirSync(path.join(mount, 'MyWorks', object), { recursive: true });
  unplug(mount);
  return dmg;
}

/** Plugs an image in and returns where macOS mounted it. `readOnly` is a locked SD card. */
export function plug(dmg: string, opts: { readOnly?: boolean } = {}): string {
  const args = ['attach', dmg, '-nobrowse', '-noverify', ...(opts.readOnly ? ['-readonly'] : [])];
  const out = execFileSync('hdiutil', args, { stdio: 'pipe' }).toString();
  const line = out.split('\n').filter(l => l.includes('/Volumes/')).pop();
  const mount = line ? line.slice(line.indexOf('/Volumes/')).trim() : '';
  if (!mount) throw new Error(`no mount point in hdiutil output: ${out}`);
  mounted.add(mount);
  return mount;
}

/** Ejects one volume this module mounted. */
export function unplug(mount: string): void {
  if (!mounted.has(mount)) throw new Error(`${mount} was not mounted by this test`);
  execFileSync('hdiutil', ['detach', mount, '-force'], { stdio: 'pipe' });
  mounted.delete(mount);
}

/** Ejects everything this module mounted, ignoring volumes that are already gone. */
export function unplugAll(): void {
  for (const mount of [...mounted]) {
    try { execFileSync('hdiutil', ['detach', mount, '-force'], { stdio: 'pipe' }); } catch { /* already gone */ }
    mounted.delete(mount);
  }
}

/** A volume name no other drive on the machine is using, so a test never mistakes someone's real card for its own. */
export function uniqueVolumeName(prefix = 'NEBTEST'): string {
  return `${prefix} ${Math.floor(1000 + Math.random() * 9000)}`;
}
