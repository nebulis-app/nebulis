import { describe, it, expect, vi } from 'vitest';
import type { SmbEntry } from '../../server/lib/smb';

const PARENT = 'DWARF_RAW_TELE_MOSAIC_IC 1805_EXP_10_GAIN_200_2026-11-05-20-40-32-316';
const PANEL_1 = 'DWARF_RAW_TELE_IC 1805(1)_EXP_10_GAIN_200_2026-11-05-20-40-32-347';
const PANEL_2 = 'DWARF_RAW_TELE_IC 1805(2)_EXP_10_GAIN_200_2026-11-05-20-40-32-357';

const listing: Record<string, SmbEntry[]> = {
  Astronomy: [{ name: PARENT, type: 'dir' }],
  [`Astronomy/${PARENT}`]: [
    { name: 'shotsInfo.json', type: 'file' },
    { name: 'stacked.jpg', type: 'file' },
    { name: 'stacked-16_IC 1805_10s200_Duo-Band_20261106-000907108.zip', type: 'file' },
    { name: PANEL_1, type: 'dir' },
    { name: PANEL_2, type: 'dir' },
  ],
  [`Astronomy/${PARENT}/${PANEL_1}`]: [
    { name: 'stacked-16_IC 1805(1)_10s200_Duo-Band_20261105-204148160.fits', type: 'file', size: 12_447_360 },
    { name: 'IC 1805(1)_10s200_Duo-Band_20261105-204148160_19C.fits', type: 'file', size: 4_150_080 },
    { name: 'stacked.jpg', type: 'file' },
    { name: 'shotsInfo.json', type: 'file' },
  ],
  [`Astronomy/${PARENT}/${PANEL_2}`]: [
    { name: 'stacked-16_IC 1805(2)_10s200_Duo-Band_20261105-204939736.fits', type: 'file', size: 12_447_360 },
    { name: 'IC 1805(2)_10s200_Duo-Band_20261105-204939736_19C.fits', type: 'file', size: 4_150_080 },
    { name: 'stacked.jpg', type: 'file' },
    { name: 'shotsInfo.json', type: 'file' },
  ],
};

vi.mock('../../server/lib/smb.js', () => ({
  smbListDir: vi.fn(async (remotePath: string) => listing[remotePath] ?? []),
}));

import { discoverDwarfObjects, listDwarfObjectFiles } from '../../server/lib/walkers/dwarfWalker';

const profile = { id: 'p', kind: 'dwarf-3' } as never;

describe('Dwarf mosaic live walker', () => {
  it('discovers one mosaic object rather than one per panel', async () => {
    const objects = await discoverDwarfObjects(profile);

    expect(objects.map(o => o.folderName)).toEqual(['IC 1805_mosaic']);
    expect(objects[0]._dwarfSessionFolders).toEqual([PARENT]);
  });

  it('walks the panel folders and tags their files with the panel path', async () => {
    const [object] = await discoverDwarfObjects(profile);
    const { files, subFiles } = await listDwarfObjectFiles(profile, object);

    expect(files.map(f => f.name)).toContain(
      `${PARENT}/${PANEL_1}/stacked-16_IC 1805(1)_10s200_Duo-Band_20261105-204148160.fits`,
    );
    expect(files.map(f => f.name)).toContain(
      `${PARENT}/${PANEL_2}/stacked-16_IC 1805(2)_10s200_Duo-Band_20261105-204939736.fits`,
    );
    expect(subFiles.map(f => f.name)).toContain(
      `${PARENT}/${PANEL_1}/IC 1805(1)_10s200_Duo-Band_20261105-204148160_19C.fits`,
    );
    expect(subFiles.map(f => f.name)).toContain(
      `${PARENT}/${PANEL_2}/IC 1805(2)_10s200_Duo-Band_20261105-204939736_19C.fits`,
    );

    // The parent's previews/sidecar are still walked, and the redundant zip is
    // left for the import filter to reject (it is the same FITS as the panels).
    expect(files.map(f => f.name)).toContain(`${PARENT}/stacked.jpg`);
    expect(files.map(f => f.name)).toContain(`${PARENT}/shotsInfo.json`);
  });
});
