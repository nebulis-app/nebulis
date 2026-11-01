// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import i18n from '../../src/i18n';
import { RouteErrorBoundary } from '../../src/components/RouteErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Broken(): never {
  throw new Error('render exploded');
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(initial: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={[initial]}>
        <nav><Link to="/ok" id="to-ok">ok</Link></nav>
        <RouteErrorBoundary>
          <Routes>
            <Route path="/broken" element={<Broken />} />
            <Route path="/ok" element={<p id="fine">fine page</p>} />
          </Routes>
        </RouteErrorBoundary>
      </MemoryRouter>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

beforeAll(async () => { await i18n.changeLanguage('en'); });

describe('RouteErrorBoundary', () => {
  it('keeps the navigation on screen when a page crashes, and recovers when the user leaves it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mount('/broken');
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('render exploded');
    expect(container!.querySelector('#to-ok')).not.toBeNull(); // the nav outside the boundary is still there

    act(() => { (container!.querySelector('#to-ok') as HTMLAnchorElement).click(); });
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(container!.querySelector('#fine')?.textContent).toBe('fine page');
    spy.mockRestore();
  });

  it('renders children untouched when nothing throws', () => {
    mount('/ok');
    expect(container!.querySelector('#fine')).not.toBeNull();
  });
});
