/**
 * Docker lab, browser tier: the image editor on the real image. The editor shows a screen-sized preview that it loads
 * through a `blob:` URL, and the server's Content Security Policy decides whether the browser may draw it. That policy
 * is only sent by the real server (not by the Vite dev server or the mocked Playwright specs), so v2.2.1 and v2.2.2
 * shipped an editor that opened blank ("Failed to load image") on every server install and nothing noticed.
 *
 * This spec opens a picture the way a user does, rotates it, flips it, adjusts it, adds a watermark, saves in place,
 * saves a new version, and checks what landed on the server. It fails on any Content Security Policy violation the
 * page reports, so the next picture, worker or font the policy forgets is caught here too.
 *
 * Needs the stack: `npm run lab:up`. Run: `npm run test:e2e:docker`.
 */
import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { stackIsUp, resetApp } from '../lab/labStack';
import { API, signIn, openApp } from './dockerApp';

test.describe.configure({ mode: 'serial' });

const OBJECT = 'M42';
const WIDTH = 900;
const HEIGHT = 600;

let token = '';
let violations: string[] = [];

interface Processed { id: string; filename: string; title: string; url: string }

/** A landscape picture with a red block in the top-left corner, so a rotation or flip is visible in the pixels. */
async function landscapePicture(): Promise<Buffer> {
  const corner = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: { r: 40, g: 60, b: 90 } } })
    .composite([{ input: corner, left: 0, top: 0 }])
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function uploadProcessed(name: string, title: string): Promise<Processed> {
  const body = new FormData();
  body.append('image', new Blob([await landscapePicture()], { type: 'image/jpeg' }), name);
  body.append('title', title);
  const res = await fetch(`${API}/library/objects/${OBJECT}/processed-images`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
  const json = await res.json() as { data: Processed };
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}

async function listProcessed(): Promise<Processed[]> {
  const res = await fetch(`${API}/library/objects/${OBJECT}/processed-images`, { headers: { Authorization: `Bearer ${token}` } });
  return ((await res.json()) as { data: Processed[] }).data;
}

/** The stored bytes of a processed picture, read back from the server. */
async function bytesOf(img: Processed): Promise<Buffer> {
  const res = await fetch(`${API.replace(/\/api$/, '')}${img.url}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`could not download ${img.filename}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Mean RGB of a corner of the stored picture. */
async function cornerMean(buf: Buffer, corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'): Promise<[number, number, number]> {
  const { width, height } = await sharp(buf).metadata();
  const size = 40;
  const left = corner.endsWith('left') ? 5 : (width ?? 0) - size - 5;
  const top = corner.startsWith('top') ? 5 : (height ?? 0) - size - 5;
  return meanRgb(await sharp(buf).extract({ left, top, width: size, height: size }).removeAlpha().raw().toBuffer());
}

/** Mean RGB of raw 3-channel pixels. (sharp's stats() looks at the whole picture and ignores extract().) */
function meanRgb(raw: Buffer): [number, number, number] {
  const sum = [0, 0, 0];
  const pixels = raw.length / 3;
  for (let i = 0; i < raw.length; i += 3) { sum[0] += raw[i]; sum[1] += raw[i + 1]; sum[2] += raw[i + 2]; }
  return [sum[0] / pixels, sum[1] / pixels, sum[2] / pixels];
}

const isRed = ([r, g, b]: [number, number, number]) => r > 200 && g < 60 && b < 60;

/** Open the first processed picture on the object page in the editor. */
async function openEditor(page: Page, title: string): Promise<void> {
  await openApp(page, token, `/object/${OBJECT}`);
  await page.getByRole('tab', { name: /^Processed/ }).click();
  await page.getByRole('button', { name: 'Processed image' }).filter({ hasText: title }).click();
  await page.getByRole('button', { name: 'Edit image' }).click();
  await expect(page.getByText('Edit Image', { exact: true })).toBeVisible();
  // The preview is a blob: image. When the policy refuses it the editor says so instead of drawing a canvas.
  await expect(page.getByText('Failed to load image.')).toHaveCount(0);
  await expect(page.locator('[data-image-editor] canvas')).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!(await stackIsUp())) throw new Error('The Docker lab is not running. Start it with: npm run lab:up');
  await resetApp();
  token = await signIn();
});

test.beforeEach(async ({ page }) => {
  violations = [];
  page.on('console', msg => {
    const text = msg.text();
    if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(text)) violations.push(text);
  });
  page.on('pageerror', err => {
    if (/Content Security Policy/i.test(err.message)) violations.push(err.message);
  });
});

test.afterEach(() => {
  expect(violations, 'the browser reported Content Security Policy violations').toEqual([]);
});

test('the editor opens a picture served by the real server and draws it', async ({ page }) => {
  await uploadProcessed('Editor_Open_M42.jpg', 'Open check');
  await openEditor(page, 'Open check');
  const size = await page.locator('[data-image-editor] canvas').evaluate(el => {
    const canvas = el as HTMLCanvasElement;
    return { w: canvas.width, h: canvas.height };
  });
  expect(size.w).toBeGreaterThan(100);
  expect(size.h).toBeGreaterThan(100);
  // Drawn, not blank: the picture is a blue-grey field with a red corner.
  const hasRed = await page.locator('[data-image-editor] canvas').evaluate(el => {
    const canvas = el as HTMLCanvasElement;
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) return true;
    return false;
  });
  expect(hasRed).toBe(true);
});

test('rotate, flip, adjust and a watermark, then Save, rewrites the picture on the server', async ({ page }) => {
  const original = await uploadProcessed('Editor_Save_M42.jpg', 'Save check');
  const before = await bytesOf(original);
  const beforeMeta = await sharp(before).metadata();
  expect([beforeMeta.width, beforeMeta.height]).toEqual([WIDTH, HEIGHT]);
  expect(isRed(await cornerMean(before, 'top-left'))).toBe(true);

  await openEditor(page, 'Save check');

  // Rotate right: the landscape picture becomes portrait and the red corner moves from top-left to top-right.
  await page.getByRole('button', { name: 'Right', exact: true }).click();
  // A change of brightness and the Auto stretch both ask the server nothing; they ride along with the save.
  await page.getByRole('button', { name: 'Auto', exact: true }).click();

  // A text watermark in the middle of the picture.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.locator('[data-image-editor] textarea').fill('(c) Docker lab');
  await expect(page.locator('[data-text-layer]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Edit Image', { exact: true })).toBeHidden({ timeout: 60_000 });

  // Same picture (same id), new pixels.
  const after = (await listProcessed()).find(p => p.id === original.id);
  expect(after, 'the saved picture is still in Processed').toBeTruthy();
  const afterBytes = await bytesOf(after!);
  expect(afterBytes.equals(before)).toBe(false);
  const afterMeta = await sharp(afterBytes).metadata();
  expect([afterMeta.width, afterMeta.height]).toEqual([HEIGHT, WIDTH]);
  expect(isRed(await cornerMean(afterBytes, 'top-right'))).toBe(true);
  expect(isRed(await cornerMean(afterBytes, 'top-left'))).toBe(false);

  // The watermark was burned in: the middle of the picture is no longer the plain blue-grey field.
  const middle = await sharp(afterBytes)
    .extract({ left: Math.floor(HEIGHT / 2) - 150, top: Math.floor(WIDTH / 2) - 40, width: 300, height: 80 })
    .removeAlpha().raw().toBuffer();
  let brightest = 0;
  for (const v of middle) brightest = Math.max(brightest, v);
  expect(brightest).toBeGreaterThan(200);
});

test('flip, Save as new version keeps the original and adds an edited copy', async ({ page }) => {
  const original = await uploadProcessed('Editor_Version_M42.jpg', 'Version check');
  const before = await bytesOf(original);
  const idsBefore = new Set((await listProcessed()).map(p => p.id));

  await openEditor(page, 'Version check');
  await page.getByRole('button', { name: 'Horizontal', exact: true }).click();
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByText('Edit Image', { exact: true })).toBeHidden({ timeout: 60_000 });

  const all = await listProcessed();
  const added = all.filter(p => !idsBefore.has(p.id));
  expect(added.map(p => p.filename)).toHaveLength(1);
  // The original is untouched.
  const still = all.find(p => p.id === original.id)!;
  expect((await bytesOf(still)).equals(before)).toBe(true);
  // The new copy is flipped left to right: the red corner is now top-right and the size is unchanged.
  const copy = added[0];
  expect(copy, 'the new version is listed').toBeTruthy();
  const copyBytes = await bytesOf(copy);
  const meta = await sharp(copyBytes).metadata();
  expect([meta.width, meta.height]).toEqual([WIDTH, HEIGHT]);
  expect(isRed(await cornerMean(copyBytes, 'top-right'))).toBe(true);
  expect(isRed(await cornerMean(copyBytes, 'top-left'))).toBe(false);
});

test('rotate left saves too, and the editor reopens on the saved picture', async ({ page }) => {
  const original = await uploadProcessed('Editor_Again_M42.jpg', 'Again check');
  await openEditor(page, 'Again check');
  await page.getByRole('button', { name: 'Left', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Edit Image', { exact: true })).toBeHidden({ timeout: 60_000 });

  const saved = (await listProcessed()).find(p => p.id === original.id)!;
  const meta = await sharp(await bytesOf(saved)).metadata();
  expect([meta.width, meta.height]).toEqual([HEIGHT, WIDTH]);

  // Open it again: the saved (now portrait) picture loads in the editor.
  await openEditor(page, 'Again check');
  const portrait = await page.locator('[data-image-editor] canvas').evaluate(el => {
    const canvas = el as HTMLCanvasElement;
    return canvas.height > canvas.width;
  });
  expect(portrait).toBe(true);
});
