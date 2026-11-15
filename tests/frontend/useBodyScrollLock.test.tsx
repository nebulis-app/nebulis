// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { lockBodyScroll } from '../../src/hooks/useBodyScrollLock';
import { BodyScrollLock } from '../../src/components/ui/BodyScrollLock';
import { Modal } from '../../src/components/ui/Modal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const locked = () => document.body.style.overflow === 'hidden' && document.documentElement.style.overflow === 'hidden';
const unlocked = () => document.body.style.overflow === '' && document.documentElement.style.overflow === '';

beforeEach(() => {
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
});

describe('page scroll lock', () => {
  it('locks while a dialog is on screen and restores what was there before', () => {
    document.body.style.overflow = 'scroll';
    const release = lockBodyScroll();
    expect(locked()).toBe(true);
    release();
    expect(document.body.style.overflow).toBe('scroll');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('stays locked until the LAST of several dialogs closes', () => {
    const outer = lockBodyScroll();
    const inner = lockBodyScroll();
    inner();
    // A picture viewer closing inside an object card must not free the page under the card.
    expect(locked()).toBe(true);
    outer();
    expect(unlocked()).toBe(true);
  });

  it('releasing twice does not free a lock another dialog still holds', () => {
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    a();
    a();
    expect(locked()).toBe(true);
    b();
    expect(unlocked()).toBe(true);
  });

  describe('in React', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    });

    it('a hand-built overlay locks for exactly as long as it is rendered', () => {
      act(() => root.render(<div className="fixed inset-0"><BodyScrollLock /></div>));
      expect(locked()).toBe(true);
      act(() => root.render(null));
      expect(unlocked()).toBe(true);
      act(() => root.unmount());
      host.remove();
    });

    it('a hand-built overlay inside a Modal keeps the page locked after the overlay closes', () => {
      const tree = (inner: boolean) => (
        <Modal isOpen onClose={() => {}} title="Outer">
          {inner && <div className="fixed inset-0"><BodyScrollLock /></div>}
        </Modal>
      );
      act(() => root.render(tree(true)));
      expect(locked()).toBe(true);
      act(() => root.render(tree(false)));
      expect(locked()).toBe(true);
      act(() => root.render(null));
      expect(unlocked()).toBe(true);
      act(() => root.unmount());
      host.remove();
    });
  });
});
