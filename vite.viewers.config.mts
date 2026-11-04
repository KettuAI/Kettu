// The artifact type viewers' build: one entry per viewer, each a script and a stylesheet named
// after it, into out/viewers/. Main and the remote host serve them on every typed artifact's
// origin, whose page loads them by relative paths, so the build's paths are relative too.

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viewerParts } from './tools/build/viewer-parts'

const source = (file: string): string => fileURLToPath(new URL(file, import.meta.url))

export default defineConfig({
  root: source('src/renderer/src/viewers'),
  base: './',
  resolve: {
    alias: [
      { find: '@shared', replacement: source('src/shared') },
      { find: '@renderer', replacement: source('src/renderer/src') },
      { find: /^cn$/, replacement: source('src/renderer/src/lib/utils.ts') },
    ],
  },
  plugins: [react(), tailwindcss(), viewerParts()],
  build: {
    outDir: source('out/viewers'),
    emptyOutDir: true,
    minify: true,
    cssCodeSplit: true,
    rolldownOptions: {
      input: {
        document: source('src/renderer/src/viewers/document/main.tsx'),
        slides: source('src/renderer/src/viewers/slides/main.tsx'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css'))
            ? '[name][extname]'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
})
