import { defineConfig, type Plugin, type ProxyOptions } from 'vite'
import { rmSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const API_TARGET = process.env.NEBULIS_API_PROXY ?? 'http://localhost:3002'

/**
 * `npm run dev` starts Vite and the Express server side by side, and Express takes a few seconds to
 * boot (migrations, backfills). `tsx watch` also restarts it on every server edit. Any request that
 * lands in that gap used to log a full "http proxy error" stack trace, once per request, and hand the
 * browser an empty 502, so a tab that polls (telescope status) filled the terminal.
 *
 * A refused connection just means the API is not up yet. Answer it with a 503 + Retry-After, which
 * the client already retries, and log a single line per outage instead. Every other proxy error
 * (timeouts, resets on a live server) still goes through Vite's own handler untouched.
 *
 * Vite attaches its handler after `configure` runs, so it cannot be replaced from here; the
 * `emit` wrapper below is what keeps a refused connection from reaching it.
 */
function apiProxy(): ProxyOptions {
  return {
    target: API_TARGET,
    changeOrigin: true,
    configure: proxy => {
      let announced = false;
      proxy.on('proxyRes', () => { announced = false; });

      const emit = proxy.emit.bind(proxy) as (event: string, ...args: unknown[]) => boolean;
      proxy.emit = ((event: string, ...args: unknown[]) => {
        const [err, , res] = args as [NodeJS.ErrnoException, unknown, import('http').ServerResponse | undefined];
        if (event === 'error' && err?.code === 'ECONNREFUSED' && res && 'writeHead' in res) {
          if (!announced) {
            announced = true;
            console.log(`[vite] API at ${API_TARGET} is not up yet. Requests get a 503 until it is.`);
          }
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' })
              .end(JSON.stringify({ data: null, error: { code: 'SERVER_STARTING', message: 'The server is starting. Try again in a moment.' } }));
          }
          return true;
        }
        return emit(event, ...args);
      }) as typeof proxy.emit;
    },
  };
}

/**
 * `public/stellarium/` is a gitignored local download of Stellarium Web (~50 MB) used only by the telescope
 * control center on feat/v2.3.0-alpaca. Vite copies all of `public/` into the build, ignored or not, so a copy
 * left on disk shipped in the 2.2.1 Mac app (and its host-named folders broke codesign). Nothing on this branch
 * uses it, so drop it from every build's output. Remove this plugin when the control center's sky view ships.
 */
function excludeStellarium(): Plugin {
  let outDir = ''
  return {
    name: 'exclude-stellarium',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      rmSync(path.join(outDir, 'stellarium'), { recursive: true, force: true })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excludeStellarium()],
  build: {
    outDir: 'releases/web',
  },
  server: {
    host: true,
    proxy: {
      '/api': apiProxy(),
      // Pre-generated catalog thumbnails are served directly by Express
      // (server/index.ts) as a static route outside /api, so it also needs
      // its own proxy entry here — otherwise Vite's dev server returns its
      // own SPA fallback HTML for these paths instead of the image.
      '/sky-cache': apiProxy(),
      // PixInsight update repository (/plugins/pixinsight/), served by Express.
      '/plugins': apiProxy(),
    },
  },
})
