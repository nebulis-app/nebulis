// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useLightboxKeys } from '../../src/components/lightbox/useLightboxKeys';

function Harness({ onKeep, onReject }: { onKeep?: () => void; onReject?: () => void }) {
  useLightboxKeys({
    onPrev: vi.fn(), onNext: vi.fn(), onFirst: vi.fn(), onLast: vi.fn(), onClose: vi.fn(),
    onFit: vi.fn(), onActualSize: vi.fn(), onZoomIn: vi.fn(), onZoomOut: vi.fn(),
    onKeep, onReject,
  });
  return <input data-testid="field" />;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return { getByTestId: (id: string) => host.querySelector(`[data-testid="${id}"]`)!, unmount: () => act(() => root.unmount()) };
}

const press = (key: string, target: EventTarget = window) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('viewer keep / reject keys', () => {
  it('K keeps and X rejects the frame on screen, in either case', () => {
    const onKeep = vi.fn();
    const onReject = vi.fn();
    const { unmount } = render(<Harness onKeep={onKeep} onReject={onReject} />);
    press('k'); press('K');
    press('x'); press('X');
    expect(onKeep).toHaveBeenCalledTimes(2);
    expect(onReject).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does nothing where the viewer is not reviewing frames', () => {
    const { unmount } = render(<Harness />);
    expect(() => { press('k'); press('x'); }).not.toThrow();
    unmount();
  });

  it('leaves the keys to a text field that has focus', () => {
    const onKeep = vi.fn();
    const { getByTestId, unmount } = render(<Harness onKeep={onKeep} />);
    press('k', getByTestId('field'));
    expect(onKeep).not.toHaveBeenCalled();
    unmount();
  });

  it('ignores K with a modifier held, so a browser shortcut is not stolen', () => {
    const onKeep = vi.fn();
    const { unmount } = render(<Harness onKeep={onKeep} />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    expect(onKeep).not.toHaveBeenCalled();
    unmount();
  });
});
