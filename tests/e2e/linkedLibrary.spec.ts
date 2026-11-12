import { test, expect, type Page } from '@playwright/test';
import { mockAdminAuth, mockAllRoutes, ok, json } from './fixtures/mocks';

/**
 * Linking a folder in place: the review screen, and the Settings list that
 * manages what was linked. The server is mocked, so these assert what the UI
 * sends and shows, not what the scanner finds (that is the backend tests' job).
 */

const ROOT = '/data/MyWorks/2. Seestar S50 Pro';

const SCAN = {
  rootPath: ROOT,
  objects: [
    {
      objectId: 'NGC188', sourceName: 'C 1 - Polarissima Cluster', fileCount: 56, bytes: 5_000_000,
      sessions: [{ date: '2026-09-08', fileCount: 56, bytes: 5_000_000, confidence: 'high', source: 'filename' }],
      unsortedCount: 0,
      catalogMatch: { objectId: 'NGC188', name: 'NGC188', type: 'Open Cluster', constellation: 'Cep', magnitude: 8.1, aliases: ['C1'] },
      aliases: ['C1'],
      nicknames: ['Polarissima Cluster'],
      dirPaths: ['1. Caldwell Objects/C 1 - Polarissima Cluster'],
      reassignable: true,
    },
    {
      objectId: 'M31', sourceName: 'Galaxies', fileCount: 120, bytes: 9_000_000,
      sessions: [
        { date: '2026-09-10', fileCount: 100, bytes: 8_000_000, confidence: 'high', source: 'filename' },
        { date: '2026-09-11', fileCount: 20, bytes: 1_000_000, confidence: 'high', source: 'filename' },
      ],
      unsortedCount: 0,
      catalogMatch: { objectId: 'M31', name: 'Andromeda Galaxy', type: 'Galaxy', constellation: 'And', magnitude: 3.4, aliases: [] },
      aliases: [],
      nicknames: [],
      // Shares its folder with another object, so a directory override could not be limited to it.
      dirPaths: ['Galaxies'],
      reassignable: false,
    },
    {
      objectId: 'C2025R3PANSTARRS', sourceName: 'C 2025 R3 PANSTARRS', fileCount: 2, bytes: 600,
      sessions: [
        { date: '2026-04-14', fileCount: 1, bytes: 300, confidence: 'medium', source: 'folder' },
        { date: '2026-04-15', fileCount: 1, bytes: 300, confidence: 'medium', source: 'folder' },
      ],
      unsortedCount: 0,
      catalogMatch: null,
      aliases: [],
      nicknames: [],
      dirPaths: ['DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_15_GAIN_60_2026-04-15-06-38-16-385', 'DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_30_GAIN_60_2026-04-16-06-21-17-383'],
      reassignable: true,
    },
  ],
  unresolved: [{ dirPath: '6. Comets and Planets', fileCount: 30, bytes: 1_000_000 }],
  skipped: [
    { reason: 'thumbnails-disabled', label: 'thumbnails, because thumbnail import is off', count: 11, bytes: 422_000, samples: [] },
    { reason: 'non-observation-folder', label: 'folders that hold no observations (calibration frames, restacks, daytime photos)', count: 1, bytes: 0, samples: ['CALI_FRAME'] },
  ],
  excludedFolders: ['CALI_FRAME'],
  containerDirs: ['1. Caldwell Objects'],
  disagreements: [],
  totals: { objects: 3, files: 178, bytes: 14_000_600 },
  truncated: false,
};

const SOURCE = {
  id: 'src_1', label: 'MyWorks', rootPath: '/data/MyWorks', enabled: true,
  lastScanAt: '2026-09-20T10:00:00.000Z', createdAt: '2026-09-20T10:00:00.000Z',
  fileCount: 176, objectCount: 2, bytes: 14_000_000, missingCount: 0, offline: false, refreshIntervalMin: null as number | null,
};

/** Steps 1 and 2 are just "Next"; the choice happens on step 3. */
async function goToLastStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('How should Nebulis add it?')).toBeVisible();
}

/** Open the import modal and commit to a way in. Step 0 is a choice between "Link Data" and "Upload Data". */
async function startImport(page: Page, way: 'link' | 'upload'): Promise<void> {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Upload Files' }).click();
  await page.getByRole('button', { name: way === 'link' ? /^Link Data/ : /^Upload Data/ }).click();
}

/** The review ends in "Continue", which opens the one-time/ongoing choice; the "Link folder" button that commits lives there. */
async function commitLink(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('How should Nebulis keep this folder up to date?')).toBeVisible();
  await page.getByRole('button', { name: 'Link folder' }).click();
}

async function dismissWhatsNew(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Got it' }).click({ timeout: 1500 }).catch(() => { /* not shown */ });
}

test.describe('Linked folders', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    // Default: the browser is on a different computer than the server.
    await page.route('**/api/storage/client-locality', r =>
      r.fulfill(json(ok({ sameMachine: false, serverName: 'astro-mac' }))));
  });

  test('link wizard: shows what was found, sends the review decisions, and never offers a copy size', async ({ page }) => {
    await page.route('**/api/storage/volumes', r => r.fulfill(json(ok({ volumes: [] }))));
    await page.route('**/api/storage/browse**', r => r.fulfill(json(ok({ path: ROOT, directories: [] }))));
    await page.route('**/api/library/sources/scan', r => r.fulfill(json(ok(SCAN))));
    let posted: { rootPath: string; label: string; overrides: Array<Record<string, string>> } | null = null;
    await page.route('**/api/library/sources', async r => {
      if (r.request().method() === 'POST') {
        posted = r.request().postDataJSON();
        await r.fulfill(json(ok({ sourceId: 'src_1', objectsLinked: 2, filesLinked: 176 })));
      } else {
        await r.fulfill(json(ok({ sources: [] })));
      }
    });

    await page.goto('/');
    await dismissWhatsNew(page);
    await startImport(page, 'link');
    await page.getByPlaceholder(/Astrophotography/).fill(ROOT);
    await page.getByRole('button', { name: 'Open' }).click();
    // Link Data has no "how should Nebulis add it?" step: the options step ends in the Link button,
    // and neither copy nor upload is offered on the way.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('What should come in?')).toBeVisible();
    await expect(page.getByText('How should Nebulis add it?')).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
    // This step ends in a review, not in linking: the button says so, and the progress shows the review
    // as the step it leads to. Nothing is linked until the review's own "Link folder".
    await expect(page.getByRole('list', { name: 'Step 2 of 3' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Step 2 of 3' }).getByText('Review & link')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Link folder' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Review', exact: true }).click();

    // Objects come from the folders' contents, not from the category folders.
    await expect(page.getByText('M31 · Andromeda Galaxy')).toBeVisible();
    // A bare NGC id is not repeated as its own name, and the other names are shown.
    await expect(page.getByText('NGC188', { exact: true })).toBeVisible();
    await expect(page.getByText('Also known as C1, Polarissima Cluster')).toBeVisible();
    await expect(page.getByText('1. Caldwell Objects')).toHaveCount(0);
    await expect(page.getByText(/Nothing will be copied/)).toBeVisible();
    await expect(page.getByText(/will be copied into your Nebulis library/)).toHaveCount(0);

    // The unresolved folder is offered for a decision, and the button is live.
    await expect(page.getByText('1 folder needs attention')).toBeVisible();
    await page.getByRole('button', { name: 'Ignore' }).click();
    await expect(page.getByText('ignored')).toBeVisible();

    await page.getByLabel('Label for this link').fill('My Seestar library');
    await commitLink(page);
    await expect(page.getByText('Folder linked')).toBeVisible();

    expect(posted).toMatchObject({
      rootPath: ROOT,
      label: 'My Seestar library',
      overrides: [{ dirPath: '6. Comets and Planets', action: 'ignore' }],
    });
  });

  test('three steps: a folder the server can see offers copy or upload as cards', async ({ page }) => {
    await page.route('**/api/storage/locate-folder', r => r.fulfill(json(ok({ path: ROOT }))));

    await page.goto('/');
    await dismissWhatsNew(page);
    await startImport(page, 'upload');
    // Dropping a folder is a file chooser under the hood; hand it a real directory.
    await page.locator('input[type=file]').setInputFiles('tests/e2e/fixtures');

    // Step 1: the drop zone turns into a summary of what was picked.
    await expect(page.getByText(`Found on the server at ${ROOT}. Nebulis will copy it in directly from there.`)).toBeVisible();
    await expect(page.getByText('fixtures', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 2: options; the ones a link ignores say so on themselves.
    await expect(page.getByText('What should come in?')).toBeVisible();
    await expect(page.getByText(/Ignored when linking/)).toHaveCount(2);
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 3: under Upload Data, copy and upload are on offer and linking is not.
    await expect(page.getByRole('radio', { name: /Copy into library/ })).toBeEnabled();
    await expect(page.getByRole('radio', { name: /Upload from this device/ })).toBeEnabled();
    await expect(page.getByRole('radio')).toHaveCount(2);
    await page.getByRole('radio', { name: /Upload from this device/ }).click();
    await expect(page.getByRole('radio', { name: /Upload from this device/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: 'Upload & review' })).toBeEnabled();
  });

  test('three steps: Back keeps the picked folder and the chosen options', async ({ page }) => {
    await page.route('**/api/storage/locate-folder', r => r.fulfill(json(ok({ path: ROOT }))));

    await page.goto('/');
    await dismissWhatsNew(page);
    await startImport(page, 'upload');
    await page.locator('input[type=file]').setInputFiles('tests/e2e/fixtures');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel(/Include subframes/).check();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByLabel(/Include subframes/)).toBeChecked();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByText('fixtures', { exact: true })).toBeVisible();
    await expect(page.getByText(`Found on the server at ${ROOT}. Nebulis will copy it in directly from there.`)).toBeVisible();
  });

  test('three steps: a folder the server cannot see can only be uploaded, and says why', async ({ page }) => {
    await page.route('**/api/storage/locate-folder', r => r.fulfill(json(ok({ path: null }))));

    await page.goto('/');
    await dismissWhatsNew(page);
    await startImport(page, 'upload');
    await page.locator('input[type=file]').setInputFiles('tests/e2e/fixtures');

    await expect(page.getByText(/not on the Nebulis computer, so it will be uploaded/)).toBeVisible();
    await goToLastStep(page);

    // Only the selectable way is rendered: a card that cannot be chosen is not shown.
    await expect(page.getByRole('radio')).toHaveCount(1);
    await expect(page.getByRole('radio', { name: /Copy into library/ })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /Upload from this device/ })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Upload & review' })).toBeEnabled();
  });

  test('same computer: an unmatched drop goes to the folder browser instead of uploading', async ({ page }) => {
    await page.unroute('**/api/storage/client-locality');
    await page.route('**/api/storage/client-locality', r =>
      r.fulfill(json(ok({ sameMachine: true, serverName: 'astro-mac' }))));
    await page.route('**/api/storage/locate-folder', r => r.fulfill(json(ok({ path: null }))));
    await page.route('**/api/storage/volumes', r => r.fulfill(json(ok({ volumes: [] }))));

    await page.goto('/');
    await dismissWhatsNew(page);
    await startImport(page, 'upload');

    // Nothing to choose between before a folder is picked, and the drop zone is what is shown.
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByText('Drop a folder here, or click to choose one')).toBeVisible();

    await page.locator('input[type=file]').setInputFiles('tests/e2e/fixtures');
    await expect(page.getByText(/could not match "fixtures" on this computer/)).toBeVisible();
    await expect(page.getByText(/OR ENTER A PATH/i)).toBeVisible();
    // The way back is still there.
    await page.getByRole('button', { name: 'Back to drag and drop' }).click();
    await expect(page.getByText('Drop a folder here, or click to choose one')).toBeVisible();
  });

  test('same computer: a miss that lands before the locality answer still reaches the folder browser', async ({ page }) => {
    // The lookup misses while "is this the server's own computer?" is still
    // unanswered. The dialog used to decide at that moment, choose "not the
    // same machine", and strand the user on a step with every option disabled.
    let releaseLocality: () => void = () => { /* replaced below */ };
    const localityGate = new Promise<void>(resolve => { releaseLocality = resolve; });
    await page.unroute('**/api/storage/client-locality');
    await page.route('**/api/storage/client-locality', async r => {
      await localityGate;
      await r.fulfill(json(ok({ sameMachine: true, serverName: 'astro-mac' })));
    });
    await page.route('**/api/storage/locate-folder', r => r.fulfill(json(ok({ path: null }))));
    await page.route('**/api/storage/volumes', r => r.fulfill(json(ok({ volumes: [] }))));

    await page.goto('/');
    await dismissWhatsNew(page);
    await startImport(page, 'upload');
    const missed = page.waitForResponse('**/api/storage/locate-folder');
    await page.locator('input[type=file]').setInputFiles('tests/e2e/fixtures');
    await missed;

    releaseLocality();
    await expect(page.getByText(/could not match "fixtures" on this computer/)).toBeVisible();
    await expect(page.getByText(/OR ENTER A PATH/i)).toBeVisible();
  });

  test('same computer: a matched folder offers copy, and never upload', async ({ page }) => {
    await page.unroute('**/api/storage/client-locality');
    await page.route('**/api/storage/client-locality', r =>
      r.fulfill(json(ok({ sameMachine: true, serverName: 'astro-mac' }))));
    await page.route('**/api/storage/locate-folder', r => r.fulfill(json(ok({ path: ROOT }))));

    await page.goto('/');
    await dismissWhatsNew(page);
    await startImport(page, 'upload');
    await page.locator('input[type=file]').setInputFiles('tests/e2e/fixtures');
    await goToLastStep(page);

    await expect(page.getByRole('radio', { name: /Copy into library/ })).toBeEnabled();
    await expect(page.getByRole('radio', { name: /Upload from this device/ })).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(1);
  });

  /** Route the wizard's scan, the catalog search behind "Change object", and the commit, and open the review. */
  async function openReview(page: Page, scan: unknown = SCAN, waitFor = 'C 2025 R3 PANSTARRS'): Promise<{ posted: () => { overrides: Array<Record<string, string>> } | null }> {
    await page.route('**/api/storage/volumes', r => r.fulfill(json(ok({ volumes: [] }))));
    await page.route('**/api/storage/browse**', r => r.fulfill(json(ok({ path: ROOT, directories: [] }))));
    await page.route('**/api/library/sources/scan', r => r.fulfill(json(ok(scan))));
    await page.route('**/api/dso?**', r => r.fulfill(json(ok({
      results: [{ id: 'C/2025 R3', name: 'Comet PanSTARRS', type: 'Comet', constellation: null }],
      total: 1,
    }))));
    let body: { overrides: Array<Record<string, string>> } | null = null;
    await page.route('**/api/library/sources', async r => {
      if (r.request().method() === 'POST') {
        body = r.request().postDataJSON();
        await r.fulfill(json(ok({ sourceId: 'src_1', objectsLinked: 3, filesLinked: 178 })));
      } else {
        await r.fulfill(json(ok({ sources: [] })));
      }
    });
    await page.goto('/');
    await dismissWhatsNew(page);
    await startImport(page, 'link');
    await page.getByPlaceholder(/Astrophotography/).fill(ROOT);
    await page.getByRole('button', { name: 'Open' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText(waitFor, { exact: true })).toBeVisible();
    return { posted: () => body };
  }

  test('the dialog is titled for the way in: import until Link Data is chosen, then link', async ({ page }) => {
    await page.route('**/api/storage/volumes', r => r.fulfill(json(ok({ volumes: [] }))));
    await page.goto('/');
    await dismissWhatsNew(page);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Upload Files' }).click();

    // The title is both the visible heading and the dialog's accessible name, so a screen reader hears
    // the same thing a sighted user reads.
    const dialog = page.getByRole('dialog');
    const visibleTitle = dialog.locator('h2:not(.sr-only)');
    await expect(visibleTitle).toHaveText('Import to Library');
    await expect(page.getByRole('dialog', { name: 'Import to Library' })).toBeVisible();

    await page.getByRole('button', { name: /^Link Data/ }).click();
    await expect(visibleTitle).toHaveText('Link a folder');
    await expect(page.getByRole('dialog', { name: 'Link a folder' })).toBeVisible();

    // Going back to the choice is going back to a question about importing.
    await dialog.getByRole('button', { name: 'Back' }).click();
    await expect(visibleTitle).toHaveText('Import to Library');

    await page.getByRole('button', { name: /^Upload Data/ }).click();
    await expect(visibleTitle).toHaveText('Import to Library');
  });

  test('review: keeps its place in the flow, and Back returns to the options with the choices made', async ({ page }) => {
    await openReview(page);

    // Step 3 of 3 is this screen, with the two before it done, and Back replaces Cancel.
    const steps = page.getByRole('list', { name: 'Step 3 of 3' });
    await expect(steps).toBeVisible();
    await expect(steps.locator('[aria-current="step"]')).toContainText('Review & link');
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByText('What should come in?')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Link a folder' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Step 2 of 3' })).toBeVisible();

    // And forward again lands on the same review.
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('group', { name: 'C 2025 R3 PANSTARRS' })).toBeVisible();
  });

  test('review: Back gives the folder and the sub-frame option back exactly as they were', async ({ page }) => {
    await page.route('**/api/storage/volumes', r => r.fulfill(json(ok({ volumes: [] }))));
    await page.route('**/api/storage/browse**', r => r.fulfill(json(ok({ path: ROOT, directories: [] }))));
    const scanBodies: Array<{ rootPath: string; importSubFrames?: boolean }> = [];
    await page.route('**/api/library/sources/scan', async r => {
      scanBodies.push(r.request().postDataJSON());
      await r.fulfill(json(ok(SCAN)));
    });
    await page.goto('/');
    await dismissWhatsNew(page);
    await startImport(page, 'link');
    await page.getByPlaceholder(/Astrophotography/).fill(ROOT);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel(/Include subframes/).check();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('group', { name: 'C 2025 R3 PANSTARRS' })).toBeVisible();

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByLabel(/Include subframes/)).toBeChecked();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('group', { name: 'C 2025 R3 PANSTARRS' })).toBeVisible();

    // Every scan, before and after going back, was of the same folder with the same option: nothing was lost
    // on the way. (Dev mode runs a mount effect twice, so there can be more than one scan per visit.)
    expect(scanBodies.length).toBeGreaterThanOrEqual(2);
    expect(scanBodies.every(b => b.rootPath === ROOT && b.importSubFrames === true)).toBe(true);
  });

  test('review: closing after stepping back does not leave the dialog stuck on the link options', async ({ page }) => {
    await openReview(page);
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByText('What should come in?')).toBeVisible();

    await page.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Opened fresh, it asks the first question again rather than resuming.
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Upload Files' }).click();
    await expect(page.getByText('How do you want to import this?')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Import to Library' })).toBeVisible();
  });

  test('review: an object no catalog entry matches can be moved onto one, and every folder of it goes with it', async ({ page }) => {
    const { posted } = await openReview(page);
    const card = page.getByRole('group', { name: 'C 2025 R3 PANSTARRS' });

    await card.getByRole('button', { name: 'C2025R3PANSTARRS' }).click();
    await page.getByPlaceholder(/Search catalog/).fill('R3');
    await page.getByRole('button', { name: /C\/2025 R3/ }).click();

    await expect(card.getByRole('button', { name: 'C/2025 R3 · Comet PanSTARRS' })).toBeVisible();

    await commitLink(page);
    await expect(page.getByText('Folder linked')).toBeVisible();

    // One assign per directory the object lives in, so both Dwarf session folders move together.
    const assigns = (posted()?.overrides ?? []).filter(o => o.action === 'assign');
    expect(assigns.map(o => o.dirPath).sort()).toEqual([
      'DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_15_GAIN_60_2026-04-15-06-38-16-385',
      'DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_30_GAIN_60_2026-04-16-06-21-17-383',
    ]);
    expect(new Set(assigns.map(o => o.objectId))).toEqual(new Set(['C/2025 R3']));
  });

  test('review: choosing the detected name again puts an object back, and sends nothing for it', async ({ page }) => {
    const { posted } = await openReview(page);
    const card = page.getByRole('group', { name: 'C 2025 R3 PANSTARRS' });

    await card.getByRole('button', { name: 'C2025R3PANSTARRS' }).click();
    await page.getByRole('button', { name: /C\/2025 R3/ }).click();
    await expect(card.getByRole('button', { name: 'C/2025 R3 · Comet PanSTARRS' })).toBeVisible();

    await card.getByRole('button', { name: 'C/2025 R3 · Comet PanSTARRS' }).click();
    await page.getByRole('button', { name: /as-is/ }).click();
    await expect(card.getByRole('button', { name: 'C2025R3PANSTARRS' })).toBeVisible();

    await commitLink(page);
    await expect(page.getByText('Folder linked')).toBeVisible();
    expect(posted()?.overrides ?? []).toEqual([]);
  });

  test('review: leaving an object out ignores every folder of it, and the totals follow', async ({ page }) => {
    const { posted } = await openReview(page);
    await expect(page.getByText(/Nothing will be copied/)).toBeVisible();
    await expect(page.getByText(/Linking/)).toContainText('178 files');

    await page.getByRole('group', { name: 'C 2025 R3 PANSTARRS' }).getByRole('checkbox').uncheck();
    await expect(page.getByText(/Linking/)).toContainText('176 files');

    await commitLink(page);
    await expect(page.getByText('Folder linked')).toBeVisible();
    const ignores = (posted()?.overrides ?? []).filter(o => o.action === 'ignore');
    expect(ignores.map(o => o.dirPath).sort()).toEqual([
      'DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_15_GAIN_60_2026-04-15-06-38-16-385',
      'DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_30_GAIN_60_2026-04-16-06-21-17-383',
    ]);
  });

  test('review: an object that shares a folder with another is locked, and says why', async ({ page }) => {
    await openReview(page);
    const card = page.getByRole('group', { name: 'Galaxies' });
    const reason = "Shares a folder with another object, so it can't be changed here.";
    await expect(card.getByRole('checkbox')).toBeDisabled();
    await expect(card.getByRole('checkbox')).toHaveAttribute('title', reason);
    const chip = card.getByRole('button', { name: 'M31 · Andromeda Galaxy' });
    await expect(chip).toBeDisabled();
    await expect(chip).toHaveAttribute('title', reason);
  });

  test('review: leaving every object alone sends no override for any of them', async ({ page }) => {
    const { posted } = await openReview(page);
    await commitLink(page);
    await expect(page.getByText('Folder linked')).toBeVisible();
    expect(posted()?.overrides ?? []).toEqual([]);
  });

  test('review: shows what will not be linked, in linking words and without an archive offer', async ({ page }) => {
    await openReview(page);
    await expect(page.getByText(/12 files will not be linked/)).toBeVisible();
    await expect(page.getByText(/will not be imported/)).toHaveCount(0);
    await expect(page.getByText(/thumbnail import is off/)).toBeVisible();
    await expect(page.getByText('CALI_FRAME')).toBeVisible();
    // A link copies nothing, so there is no archive mode to switch on.
    await expect(page.getByText(/Archive everything/)).toHaveCount(0);
  });

  test('review: each session shows its date and where it came from, without a way to edit it', async ({ page }) => {
    await openReview(page);
    const card = page.getByRole('group', { name: 'C 2025 R3 PANSTARRS' });
    await expect(card.getByText('from folder name')).toHaveCount(2);
    await expect(card.getByText('2 files will be linked.')).toBeVisible();
    // Linking never renames or moves a file, so a session's date is a finding, not a setting.
    await expect(card.locator('input[type=date]')).toHaveCount(0);
    await expect(card.getByTitle(/Skip this session|session/i)).toHaveCount(0);
  });

  test('review: Star Trails is named for what it is, not reported as an unmatched object', async ({ page }) => {
    const starTrails = {
      objectId: 'DWARFStarTrails', sourceName: 'STARTRAILS', fileCount: 64, bytes: 4_000_000,
      sessions: [
        { date: '2026-04-05', fileCount: 14, bytes: 900_000, confidence: 'medium', source: 'folder' },
        { date: '2026-04-16', fileCount: 50, bytes: 3_100_000, confidence: 'medium', source: 'folder' },
      ],
      unsortedCount: 0,
      catalogMatch: { objectId: 'DWARFStarTrails', name: 'DWARF Star Trails', type: 'Star Trails', constellation: null, magnitude: null },
      aliases: [], nicknames: [],
      dirPaths: ['STARTRAILS/STARTRAILS_DWARF_RAW_WIDE_EXP_10_GAIN_0_2026-04-05-00-22-28-967', 'STARTRAILS/STARTRAILS_DWARF_RAW_WIDE_EXP_10_GAIN_0_2026-04-16-21-57-44-922'],
      reassignable: true,
    };
    await openReview(page, { ...SCAN, objects: [...SCAN.objects, starTrails] }, 'C2025R3PANSTARRS');
    const card = page.getByRole('group', { name: 'STARTRAILS' });
    await expect(card.getByRole('button', { name: 'DWARF Star Trails' })).toBeVisible();
    await expect(card).toContainText('64 files');
    await expect(card).toContainText('2 sessions');
    await expect(card.getByText('no catalog match')).toHaveCount(0);
  });

  test('settings: lists linked folders, rescans, renames, and unlinks after confirmation', async ({ page }) => {
    let sources = [SOURCE];
    let patched: { label: string; refreshIntervalMin: number | null } | null = null;
    await page.route('**/api/library/sources', r => r.fulfill(json(ok({ sources }))));
    await page.route('**/api/library/sources/src_1/rescan', r =>
      r.fulfill(json(ok({ sourceId: 'src_1', offline: false, added: 3, updated: 1, unchanged: 172, missing: 0, removed: 0, truncated: false, objects: 2 }))));
    await page.route('**/api/library/sources/src_1', async r => {
      const method = r.request().method();
      if (method === 'PATCH') {
        patched = r.request().postDataJSON() as { label: string; refreshIntervalMin: number | null };
        sources = [{ ...SOURCE, ...patched }];
        await r.fulfill(json(ok({ id: 'src_1', ...patched })));
      } else if (method === 'DELETE') {
        sources = [];
        await r.fulfill(json(ok({ filesUnlinked: 176, objectsRetired: [] })));
      } else {
        await r.fallback();
      }
    });

    await page.goto('/settings?tab=storage&section=linked');
    await dismissWhatsNew(page);

    await expect(page.getByText('MyWorks', { exact: true })).toBeVisible();
    await expect(page.getByText('2 objects · 176 files')).toBeVisible();

    await page.getByRole('button', { name: 'Rescan' }).click();
    await expect(page.getByText('Rescanned: 3 new, 1 changed, 0 not found, 0 removed from the index.')).toBeVisible();

    // Edit covers the name and the refresh schedule; a folder starts as manual-only.
    await expect(page.getByText('Refresh: Manual only')).toBeVisible();
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Backyard archive');
    await page.getByRole('radio', { name: /Ongoing/ }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Backyard archive', { exact: true })).toBeVisible();
    expect(patched).toEqual({ label: 'Backyard archive', refreshIntervalMin: 1440 });
    await expect(page.getByText('Refresh: Every day')).toBeVisible();

    // Unlinking is a two-step action, and says the files on disk are not touched.
    await page.getByRole('button', { name: 'Unlink' }).first().click();
    await expect(page.getByText(/Your files on disk are not touched/)).toBeVisible();
    await page.getByRole('button', { name: 'Unlink', exact: true }).last().click();
    await expect(page.getByText('No folders are linked yet.')).toBeVisible();
  });

  test('settings: a folder linked with sub-frames can be measured at night, one without cannot', async ({ page }) => {
    const withSubs = { ...SOURCE, id: 'src_1', importOptions: JSON.stringify({ importSubFrames: true, importFits: true }) };
    const withoutSubs = { ...SOURCE, id: 'src_2', label: 'Stacks only', rootPath: '/data/Stacks', importOptions: JSON.stringify({ importSubFrames: false }) };
    let patched: Record<string, unknown> | null = null;
    await page.route('**/api/library/sources', r => r.fulfill(json(ok({ sources: [withSubs, withoutSubs] }))));
    await page.route('**/api/library/sources/src_1', async r => {
      if (r.request().method() === 'PATCH') {
        patched = r.request().postDataJSON() as Record<string, unknown>;
        await r.fulfill(json(ok({ id: 'src_1', ...patched })));
      } else {
        await r.fallback();
      }
    });

    await page.goto('/settings?tab=storage&section=linked');
    await dismissWhatsNew(page);

    // The second folder has no sub-frames to measure, so its dialog does not offer it.
    await page.getByRole('button', { name: 'Edit' }).last().click();
    await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Measure its sub-frames at night/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Edit' }).first().click();
    const box = page.getByRole('checkbox', { name: /Measure its sub-frames at night/ });
    await expect(box).not.toBeChecked();
    await box.check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => patched).toMatchObject({ analyzeFrames: true });
  });

  test('settings: an unreachable folder is called out and nothing looks lost', async ({ page }) => {
    await page.route('**/api/library/sources', r => r.fulfill(json(ok({ sources: [{ ...SOURCE, offline: true }] }))));
    await page.goto('/settings?tab=storage&section=linked');
    await dismissWhatsNew(page);
    await expect(page.getByText(/cannot be reached right now. Nothing has been changed/)).toBeVisible();
  });
});
