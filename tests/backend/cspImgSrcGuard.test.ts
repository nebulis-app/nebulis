/**
 * The server's Content Security Policy must let the browser draw the images the app makes itself.
 *
 * The image editor shows a screen-sized preview through a `blob:` URL, and the upload dialogs preview a chosen file the
 * same way. The policy is sent only by the real server, never by the Vite dev server or the mocked Playwright specs, so
 * dropping `blob:` from `img-src` left every other check green while the editor opened blank on every server install
 * (2.2.1 and 2.2.2). The Docker browser spec `tests/e2e-docker/imageEditor.spec.ts` proves it in a real browser; this
 * keeps the line itself from being edited out unnoticed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function imgSrcSources(): string[] {
  const match = /imgSrc:\s*\[([^\]]*)\]/.exec(read('server/index.ts'));
  expect(match, 'server/index.ts must declare imgSrc in the helmet CSP').toBeTruthy();
  return [...match![1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

describe('Content Security Policy img-src', () => {
  it('allows blob: and data: images', () => {
    const sources = imgSrcSources();
    expect(sources).toContain('blob:');
    expect(sources).toContain('data:');
  });

  it('still allows blob: where the app feeds an object URL to an <img>', () => {
    // If one of these stops using an object URL as an image, remove it here; if a new one starts, add it.
    for (const rel of ['src/components/ImageEditorModal.tsx', 'src/components/GalleryImageModal.tsx', 'src/components/UploadProcessedModal.tsx']) {
      expect(read(rel), `${rel} no longer uses URL.createObjectURL`).toContain('URL.createObjectURL');
    }
    expect(imgSrcSources()).toContain('blob:');
  });
});
