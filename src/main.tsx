import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { reloadOnceForStaleChunk } from './lib/chunkReload';
import './i18n';
import './index.css';
import { initUiScale } from './hooks/useUiScale';

// Vite dispatches this when a module preload or a wrapped dynamic import fails.
// The usual cause in production is a tab whose index.html predates the build the
// server is now serving, so reload once to pick up the current chunk hashes.
// Route-level imports are covered separately by lazyRoute() in lib/chunkReload.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  reloadOnceForStaleChunk();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      // Returning to the tab should not silently re-run every query. For this
      // app the heavy ones (library objects, all-images) trigger a full
      // server-side filesystem walk, so a focus refetch would re-scan the disk
      // for no benefit. Data is refreshed explicitly via invalidation after
      // mutations and via each query's own staleTime.
      refetchOnWindowFocus: false,
    },
  },
});

// index.html always ships #root; failing loudly here is what createRoot(null)
// did anyway, just with a clearer message.
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Nebulis: missing #root element in index.html');

initUiScale();

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
