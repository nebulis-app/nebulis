// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shareImage, warmShareImage } from '../../src/components/lightbox/shareImage';

/**
 * Safari lets `navigator.share` and clipboard writes run only straight from the click that asked for them. Waiting on a
 * download first spends that permission, so the share and the link copy after it both failed ("Could not share this
 * image"). The picture is now fetched when the pointer reaches the button, and a click on a picture that is ready
 * shares in the same tick.
 */

let n = 0;
const nextSrc = () => `/api/library/file/thumbnail?path=share-test-${++n}.jpg`;

const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });

function setNavigator(over: { share?: unknown; canShare?: unknown; clipboard?: unknown }) {
  for (const [key, value] of Object.entries(over)) {
    Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  }
}

/** Let every pending promise callback run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('shareImage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(jpeg(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setNavigator({ canShare: () => true, share: vi.fn(async () => {}), clipboard: { writeText: vi.fn(async () => {}) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shares in the same tick as the click when the picture was fetched ahead', async () => {
    const src = nextSrc();
    warmShareImage(src);
    await settle();

    const pending = shareImage(src, 'a.jpg', 'A');
    // Nothing has been awaited yet: a browser that wants the share inside the click sees it there.
    expect(navigator.share).toHaveBeenCalledTimes(1);
    expect(await pending).toBe('shared');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still shares when nothing was fetched ahead, by fetching first', async () => {
    const src = nextSrc();
    expect(await shareImage(src, 'a.jpg', 'A')).toBe('shared');
    expect(navigator.share).toHaveBeenCalledTimes(1);
  });

  it('fetches a picture once however often the pointer passes over the button', async () => {
    const src = nextSrc();
    warmShareImage(src);
    warmShareImage(src);
    warmShareImage(src);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('copies the link when the share sheet refuses', async () => {
    setNavigator({ share: vi.fn(async () => { throw new DOMException('no gesture', 'NotAllowedError'); }) });
    const src = nextSrc();
    warmShareImage(src);
    await settle();
    expect(await shareImage(src, 'a.jpg', 'A')).toBe('copied-link');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(new URL(src, window.location.href).href);
  });

  it('fails, and says why in the console, when neither the share nor the link copy is allowed', async () => {
    setNavigator({
      share: vi.fn(async () => { throw new DOMException('no gesture', 'NotAllowedError'); }),
      clipboard: { writeText: vi.fn(async () => { throw new DOMException('no gesture', 'NotAllowedError'); }) },
    });
    const src = nextSrc();
    warmShareImage(src);
    await settle();
    expect(await shareImage(src, 'a.jpg', 'A')).toBe('failed');
    expect(console.warn).toHaveBeenCalled();
  });

  it('treats dismissing the share sheet as a cancel, not a failure', async () => {
    setNavigator({ share: vi.fn(async () => { throw new DOMException('dismissed', 'AbortError'); }) });
    const src = nextSrc();
    warmShareImage(src);
    await settle();
    expect(await shareImage(src, 'a.jpg', 'A')).toBe('cancelled');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('falls back to copying the link when the picture cannot be fetched', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 404 }));
    const src = nextSrc();
    expect(await shareImage(src, 'a.jpg', 'A')).toBe('copied-link');
    expect(navigator.share).not.toHaveBeenCalled();
  });
});
