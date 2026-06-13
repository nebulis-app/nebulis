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
    },
  },
})
