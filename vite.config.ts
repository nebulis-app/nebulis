import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'releases/web',
  },
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:3002',
      // Pre-generated catalog thumbnails are served directly by Express
      // (server/index.ts) as a static route outside /api, so it also needs
      // its own proxy entry here — otherwise Vite's dev server returns its
      // own SPA fallback HTML for these paths instead of the image.
      '/sky-cache': 'http://localhost:3002',
    },
  },
})
