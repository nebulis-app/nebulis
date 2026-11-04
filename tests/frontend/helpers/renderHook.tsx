import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * A small renderHook for the hooks in src/hooks: mounts a probe component in jsdom, hands back
 * the latest return value, and lets a test re-render, wait for async state, and unmount.
 * (The project has no testing-library; react-dom and act are all this needs.)
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function queryWrapper(client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }): ReactElement => createElement(QueryClientProvider, { client }, children),
  };
}

export function renderHook<T>(hook: () => T, wrapper?: (props: { children: ReactNode }) => ReactElement) {
  const result = { current: undefined as unknown as T };
  function Probe() {
    result.current = hook();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const tree = () => (wrapper ? createElement(wrapper, null, createElement(Probe)) : createElement(Probe));
  act(() => { root.render(tree()); });
  return {
    result,
    rerender: () => act(() => { root.render(tree()); }),
    unmount: () => act(() => { root.unmount(); }),
  };
}

/** Lets pending promises and zero-delay timers settle inside act. */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

/** Polls until `predicate` holds, flushing between checks. */
export async function waitFor(predicate: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await flush();
  }
}
