import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { version } from './package.json'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Folio — PDF tools that stay on your device',
        short_name: 'Folio',
        description: 'Merge, split, rearrange, compress and convert PDFs — 100% in your browser, fully offline.',
        theme_color: '#faf7f2',
        background_color: '#faf7f2',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  define: {
    __FOLIO_VERSION__: JSON.stringify(version),
  },
  optimizeDeps: {
    include: ['pdfjs-dist', 'pdfjs-dist/build/pdf.worker.min.mjs', 'pdf-lib'],
  },
  worker: {
    format: 'es',
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('pdfjs-dist') || id.includes('pdf-lib')) return 'pdf'
            if (id.includes('framer-motion')) return 'motion'
            if (id.includes('react') || id.includes('react-dom')) return 'react-vendor'
          }
        },
      },
    },
  },
})
