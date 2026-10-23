import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Same DATA_DIR redirection as folderImport.test.ts: paths.ts captures these at
// import time, so this must run before any server module is loaded.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-folderident-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { scanImportFolder } from '../../server/lib/library/folderScan';
import { commitFolderImport } from '../../server/lib/library/import';
import { getLocalSessions } from '../../server/lib/library/observations';
import { LIBRARY_DIR } from '../../server/lib/paths';
import { stmts } from '../../server/lib/library/objects';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Mimic the wizard's scan -> review -> plan transform: the reviewed target id
 *  is exactly what the scan's catalogMatch proposed. */
function planFromScan(rootPath: string) {
  const scan = scanImportFolder(rootPath, { importJpg: true, importFits: true });
  const objects = scan.objects.map(o => {
    const sessionMap: Record<string, string | null> = {};
    for (const s of o.sessions) sessionMap[s.date] = s.date;
    if (o.unsortedCount > 0) sessionMap.unknown = null;
    return {
      folderName: o.folderName,
      targetObjectId: o.catalogMatch?.objectId ?? o.folderName,
      targetFolderName: o.folderName,
      sessionMap,
    };
  });
  return { scan, plan: { rootPath, objects, importJpg: true, importFits: true } };
}

describe('folder import object identification', () => {
  beforeAll(() => {
    // Keep post-commit enrichment fully offline.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in tests')));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (fs.existsSync(LIBRARY_DIR)) fs.rmSync(LIBRARY_DIR, { recursive: true, force: true });
  });

  it('stores a folder named after an object and its common name under the catalog id', async () => {
    const root = tmpDir('ident-named-');
    fs.mkdirSync(path.join(root, 'M42 - Orion Nebula'));
    // A filename that encodes no target, which is the case the folder name has
    // to answer for (a target-encoding filename already renames the object).
    fs.writeFileSync(path.join(root, 'M42 - Orion Nebula', '2024-01-15_light.jpg'), 'jpg');

    const { scan, plan } = planFromScan(root);

    // The scan proposes the catalog object, not the folder name...
    expect(scan.objects).toHaveLength(1);
    expect(scan.objects[0].folderName).toBe('M42 - Orion Nebula');
    expect(scan.objects[0].catalogMatch?.objectId).toBe('M42');

    // ...and commit stores it that way.
    await commitFolderImport(plan);

    expect(stmts.getObject.get('M42')).toMatchObject({ objectId: 'M42', folderName: 'M42 - Orion Nebula' });
    expect(stmts.getObject.get('M42-OrionNebula')).toBeUndefined();
    expect(getLocalSessions('M42').length).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(LIBRARY_DIR, 'M42 - Orion Nebula'), { recursive: true }).length)
      .toBeGreaterThan(0);
  });

  it('resolves a rig-prefixed folder name to its object', async () => {
    const root = tmpDir('ident-prefixed-');
    fs.mkdirSync(path.join(root, 'Seestar_M31'));
    fs.writeFileSync(path.join(root, 'Seestar_M31', '2024-01-15_light.jpg'), 'jpg');

    const { scan, plan } = planFromScan(root);
    expect(scan.objects[0].folderName).toBe('Seestar_M31');
    expect(scan.objects[0].catalogMatch?.objectId).toBe('M31');

    await commitFolderImport(plan);
    expect(stmts.getObject.get('M31')).toMatchObject({ objectId: 'M31', folderName: 'Seestar_M31' });
    expect(stmts.getObject.get('Seestar_M31')).toBeUndefined();
  });

  it('leaves a folder with no catalog match named after the folder, as before', async () => {
    const root = tmpDir('ident-unknown-');
    fs.mkdirSync(path.join(root, 'My Custom Target'));
    fs.writeFileSync(path.join(root, 'My Custom Target', '2024-01-15_light.jpg'), 'jpg');

    const { scan, plan } = planFromScan(root);
    expect(scan.objects[0].catalogMatch).toBeNull();

    await commitFolderImport(plan);
    expect(stmts.getObject.get('MyCustomTarget')).toMatchObject({ objectId: 'MyCustomTarget', folderName: 'My Custom Target' });
  });
});
