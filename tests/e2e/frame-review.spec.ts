import { test, expect, type Page } from '@playwright/test';
import { mockAllRoutes, mockViewerAuth, MOCK, json, ok } from './fixtures/mocks';

/**
 * A night's Sub-frames list: every raw frame with its score and grade, and the
 * person's own say over it. Mark frames Keep, Reject, or back to following their
 * grade (the call wins over the computed one), and export the night's numbers as
 * a CSV with an `accepted` column for PixInsight or Siril scripts.
 */

const base = MOCK.sessionFiles.find(f => f.fileType === 'sub')!;
const file = (n: number) => ({
  ...base, name: `sub_00${n}.fit`, path: `/data/library/M42/2024-03-15/sub_00${n}.fit`,
  downloadUrl: `/api/library/file?path=/data/library/M42/2024-03-15/sub_00${n}.fit`,
  timestamp: `2024-03-15T21:0${n}:00Z`,
});

const metrics = { width: 1080, height: 1920, starCount: 240, fwhm: 3.1, elongation: 1.1, orientation: 0, background: 900, noise: 12, gradient: 1, peakSNR: 30, streak: null, saturatedFraction: 0, ra: null, dec: null };
const good = { score: 92, grade: 'good', flags: [], reasons: [] };
const bad = { score: 18, grade: 'bad', flags: ['clouds'], reasons: [{ flag: 'clouds', stars: 20, typical: 240, percentFewer: 92, brighterSky: false }] };

function row(n: number, verdict: unknown, review: 'keep' | 'reject' | null, kept: boolean) {
  const f = file(n);
  return {
    path: f.path, name: f.name, timestamp: f.timestamp, thumbUrl: null, downloadUrl: f.downloadUrl, file: f,
    metrics, verdict, review, kept,
  };
}

/** Frame 1 is good, frame 2 is bad (clouds), frame 3 is good but the person rejected it. */
const report = {
  objectId: 'M42', date: '2024-03-15',
  frames: [row(1, good, null, true), row(2, bad, null, false), row(3, good, 'reject', false)],
  reference: { stars: 240, fwhm: 3.1, elongation: 1.1, noise: 12, background: 900, weak: false },
  measured: 3, total: 3, pending: 0, failures: {},
};

async function mockFrames(page: Page) {
  const reviews: { path: string; keep: boolean | null }[] = [];
  const subs = [file(1), file(2), file(3)];
  await page.route('**/api/library/observations/**', r =>
    r.fulfill(json(ok({ ...MOCK.observationDetail, files: subs, subFiles: subs }))));
  await page.route('**/api/library/objects/M42/sessions/2024-03-15/frame-analysis', r => r.fulfill(json(ok(report))));
  await page.route('**/api/library/objects/M42/sessions/2024-03-15/frame-analysis/measure', r =>
    r.fulfill(json(ok({ queued: 0, pending: 0, total: 3 }))));
  await page.route('**/api/library/objects/M42/sessions/2024-03-15/frame-analysis.csv', r =>
    r.fulfill({
      status: 200, contentType: 'text/csv',
      body: 'file,score,grade,accepted\nsub_001.fit,92,good,1\nsub_002.fit,18,bad,0\nsub_003.fit,92,good,0\n',
    }));
  await page.route('**/api/library/frame-analysis/review', async r => {
    reviews.push(r.request().postDataJSON());
    await r.fulfill(json(ok(reviews[reviews.length - 1])));
  });
  return reviews;
}

async function openSubframes(page: Page) {
  await page.goto('/observations/M42/2024-03-15');
  await page.getByRole('tab', { name: /sub-?frames/i }).or(page.getByRole('button', { name: /sub-?frames/i })).first().click();
  await expect(page.getByRole('checkbox', { name: 'Select sub_001.fit' })).toBeVisible();
}

test.describe('Sub-frames list: keep and reject', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
  });

  test('lists every frame, with a summary of what is wrong', async ({ page }) => {
    await mockFrames(page);
    await openSubframes(page);
    await expect(page.getByRole('checkbox', { name: 'Select sub_002.fit' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select sub_003.fit' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '1 flagged · 1 bad' })).toBeVisible();
  });

  test('a frame the person rejected says so, even though its grade is good', async ({ page }) => {
    await mockFrames(page);
    await openSubframes(page);
    await expect(page.getByText('Rejected', { exact: true })).toBeVisible();
    await expect(page.getByText('Kept', { exact: true })).toHaveCount(0);
  });

  test('the marking buttons wait for a selection', async ({ page }) => {
    await mockFrames(page);
    await openSubframes(page);
    for (const name of ['Mark keep', 'Mark reject', 'Clear mark']) {
      await expect(page.getByRole('button', { name })).toBeDisabled();
    }
    await page.getByRole('checkbox', { name: 'Select sub_001.fit' }).check();
    for (const name of ['Mark keep', 'Mark reject', 'Clear mark']) {
      await expect(page.getByRole('button', { name })).toBeEnabled();
    }
  });

  test('Select All Bad picks the graded-bad frames', async ({ page }) => {
    await mockFrames(page);
    await openSubframes(page);
    await page.getByRole('button', { name: 'Select All Bad' }).click();
    await expect(page.getByRole('checkbox', { name: 'Select sub_002.fit' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Select sub_001.fit' })).not.toBeChecked();
    await expect(page.getByText('1 frame selected')).toBeVisible();
  });

  test('Mark keep keeps every selected frame, whatever its grade', async ({ page }) => {
    const reviews = await mockFrames(page);
    await openSubframes(page);
    await page.getByRole('checkbox', { name: 'Select sub_002.fit' }).check();
    await page.getByRole('checkbox', { name: 'Select sub_003.fit' }).check();
    await page.getByRole('button', { name: 'Mark keep' }).click();
    await expect.poll(() => reviews.length).toBe(2);
    expect(reviews).toEqual(expect.arrayContaining([
      { path: '/data/library/M42/2024-03-15/sub_002.fit', keep: true },
      { path: '/data/library/M42/2024-03-15/sub_003.fit', keep: true },
    ]));
  });

  test('Mark reject rejects the selected frame', async ({ page }) => {
    const reviews = await mockFrames(page);
    await openSubframes(page);
    await page.getByRole('checkbox', { name: 'Select sub_001.fit' }).check();
    await page.getByRole('button', { name: 'Mark reject' }).click();
    await expect.poll(() => reviews).toEqual([{ path: '/data/library/M42/2024-03-15/sub_001.fit', keep: false }]);
  });

  test('Clear mark hands the frame back to its grade', async ({ page }) => {
    const reviews = await mockFrames(page);
    await openSubframes(page);
    await page.getByRole('checkbox', { name: 'Select sub_003.fit' }).check();
    await page.getByRole('button', { name: 'Clear mark' }).click();
    await expect.poll(() => reviews).toEqual([{ path: '/data/library/M42/2024-03-15/sub_003.fit', keep: null }]);
  });
});

test.describe('Sub-frames list: Export CSV', () => {
  test('downloads the night\'s numbers with an accepted column', async ({ page }) => {
    await mockAllRoutes(page);
    await mockFrames(page);
    await openSubframes(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('M42_2024-03-15_frames.csv');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    const csv = Buffer.concat(chunks).toString('utf8');
    expect(csv.split('\n')[0]).toBe('file,score,grade,accepted');
    // The rejected frame is graded good but is not accepted: the person's call wins.
    expect(csv).toContain('sub_003.fit,92,good,0');
  });
});

test.describe('Sub-frames list: viewers', () => {
  test('a viewer can read the list and export it, but cannot mark frames', async ({ page }) => {
    await mockAllRoutes(page);
    await mockViewerAuth(page);
    await mockFrames(page);
    await openSubframes(page);
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark keep' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mark reject' })).toHaveCount(0);
  });
});
