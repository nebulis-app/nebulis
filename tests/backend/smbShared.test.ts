import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  assertInsideRoot,
  classifySmbError,
  scrubSmbSecrets,
  withSmbGuards,
} from '../../server/lib/smb.shared';

describe('assertInsideRoot', () => {
  const root = path.resolve('/srv/telescope/EMMC');

  it('resolves a benign relative path', () => {
    expect(assertInsideRoot(root, 'MyWorks/M42/light.fit')).toBe(path.join(root, 'MyWorks/M42/light.fit'));
  });

  it('allows the root itself', () => {
    expect(assertInsideRoot(root, '.')).toBe(root);
  });

  it('rejects a path that escapes via ..', () => {
    expect(() => assertInsideRoot(root, '../../etc/passwd')).toThrow('Path traversal detected');
  });

  it('rejects a sibling directory that shares the root prefix', () => {
    expect(() => assertInsideRoot('/srv/lib', '../lib-evil/x')).toThrow('Path traversal detected');
  });
});

describe('classifySmbError — mount backend', () => {
  const mountErr = (over: { message?: string; stderr?: string }) =>
    Object.assign(new Error(over.message ?? 'mount_smbfs: //guest:hunter2@host/EMMC failed'), over);

  it('names a mount collision from "File exists"', () => {
    expect(classifySmbError(mountErr({ message: 'mount_smbfs: server connection failed: File exists' }), 'mount'))
      .toMatch(/already mounted/i);
  });

  it('maps a missing folder to "Share or folder not found"', () => {
    expect(classifySmbError(mountErr({ stderr: 'mount_smbfs: no such file or directory' }), 'mount'))
      .toBe('Share or folder not found');
  });

  it('detects "Connection refused" and a timeout', () => {
    expect(classifySmbError(mountErr({ stderr: 'Connection refused' }), 'mount')).toBe('Connection refused');
    expect(classifySmbError(mountErr({ stderr: 'operation timed out' }), 'mount')).toBe('Connection timed out');
  });

  it('classifies an auth failure and never leaks the password', () => {
    const r = classifySmbError(mountErr({ message: 'mount_smbfs: //guest:hunter2@host/EMMC: authentication error' }), 'mount');
    expect(r).toBe('Authentication failed');
    expect(r).not.toContain('hunter2');
  });

  it('falls back to "Connection failed"', () => {
    expect(classifySmbError(mountErr({ message: 'something odd', stderr: '' }), 'mount')).toBe('Connection failed');
  });
});

describe('scrubSmbSecrets', () => {
  it('masks a mount URL password', () => {
    expect(scrubSmbSecrets('//brent:s3cr3t@nas/EMMC')).toBe('//brent:***@nas/EMMC');
  });
  it('masks -U user%password and -U user', () => {
    expect(scrubSmbSecrets('smbclient //h/s -U root%hunter2')).not.toContain('hunter2');
    expect(scrubSmbSecrets('smbclient //h/s -U admin -c ls')).toContain('-U ***');
  });
});

describe('withSmbGuards', () => {
  const ok = async () => 'result';

  it('runs the operation with the resolved settings', async () => {
    let seen = '';
    await withSmbGuards('MyWorks/M42', { hostname: '10.0.0.5', shareName: 'EMMC' }, async s => {
      seen = s.hostname;
      return 1;
    });
    expect(seen).toBe('10.0.0.5');
  });

  it('rejects a missing hostname before running the op', async () => {
    let ran = false;
    await expect(withSmbGuards('MyWorks', { hostname: '' }, async () => { ran = true; return 1; }))
      .rejects.toThrow(/hostname/i);
    expect(ran).toBe(false);
  });

  it('rejects a traversal path', async () => {
    await expect(withSmbGuards('MyWorks/../../etc', { hostname: 'h' }, ok)).rejects.toThrow(/traversal/i);
  });

  it('enforces the MyWorks boundary only when requireInsideBasePath is set', async () => {
    await expect(withSmbGuards('OtherDir/x', { hostname: 'h' }, ok, { requireInsideBasePath: true }))
      .rejects.toThrow(/Can only delete files within MyWorks/);
    await expect(withSmbGuards('OtherDir/x', { hostname: 'h' }, ok)).resolves.toBe('result');
  });
});
