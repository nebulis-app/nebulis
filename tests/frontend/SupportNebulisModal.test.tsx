// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from '../../src/i18n';
import { ThemeProvider } from '../../src/hooks/useTheme';
import { SupportNebulisModal } from '../../src/components/help/SupportNebulisModal';
import { SUPPORT_ASK_SEEN_KEY, COFFEE_URL } from '../../src/lib/support';

const { setSupportAskSeen } = vi.hoisted(() => ({ setSupportAskSeen: vi.fn(() => Promise.resolve({ seenAt: '2026-11-02T23:31:00.000Z' })) }));
vi.mock('../../src/lib/api/auth', () => ({ setSupportAskSeen }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => { await i18n.changeLanguage('en'); });
beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; setSupportAskSeen.mockClear(); });

function open(onClose = vi.fn()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<ThemeProvider><SupportNebulisModal isOpen onClose={onClose} /></ThemeProvider>); });
  return { onClose, root };
}

describe('SupportNebulisModal', () => {
  it('says the software is free, mentions app store apps, and shows the QR code and the coffee link', () => {
    open();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Enjoying Nebulis?');
    expect(text).toContain('free, and I intend to keep it that way');
    expect(text).toMatch(/app store/i);
    expect(document.body.querySelector('img')?.getAttribute('alt')).toMatch(/QR code/i);
    const link = [...document.body.querySelectorAll('a')].find(a => a.getAttribute('href') === COFFEE_URL);
    expect(link?.textContent).toContain('Buy me a coffee');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('closing with the button records that it was seen and tells the parent', () => {
    const { onClose } = open();
    const close = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Close')!;
    act(() => { close.click(); });
    expect(localStorage.getItem(SUPPORT_ASK_SEEN_KEY)).not.toBeNull();
    expect(setSupportAskSeen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still closes and keeps its local copy when saving to the server fails', async () => {
    setSupportAskSeen.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    const { onClose } = open();
    const close = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Close')!;
    await act(async () => { close.click(); });
    expect(localStorage.getItem(SUPPORT_ASK_SEEN_KEY)).not.toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the X button records it too', () => {
    const { onClose } = open();
    const x = document.body.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    act(() => { x.click(); });
    expect(localStorage.getItem(SUPPORT_ASK_SEEN_KEY)).not.toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape records it too', () => {
    const { onClose } = open();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    act(() => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(localStorage.getItem(SUPPORT_ASK_SEEN_KEY)).not.toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it('opening the coffee link records it, so a thank-you is never followed by the same ask', () => {
    open();
    const link = [...document.body.querySelectorAll('a')].find(a => a.getAttribute('href') === COFFEE_URL)!;
    link.addEventListener('click', e => e.preventDefault());
    act(() => { link.click(); });
    expect(localStorage.getItem(SUPPORT_ASK_SEEN_KEY)).not.toBeNull();
    expect(setSupportAskSeen).toHaveBeenCalledTimes(1);
  });
});
