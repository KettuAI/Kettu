// The web client's build: the renderer for a browser, with its own entry that reaches the host over
// the encrypted channel, into out/web/. The remote host serves it on its direct port.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cn } from 'cn/vite'

const source = (file: string): string => fileURLToPath(new URL(file, import.meta.url))

// The page says hello with the version of Kettu it ships with, as the desktop app does.
const { version } = JSON.parse(readFileSync(source('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  root: source('src/renderer/web'),
  define: { __KETTU_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: [
      { find: '@shared', replacement: source('src/shared') },
      { find: '@renderer', replacement: source('src/renderer/src') },
      // The shadcn CLI imports cn from the package; give it the theme-aware instance.
      { find: /^cn$/, replacement: source('src/renderer/src/lib/utils.ts') },
    ],
  },
  // The renderer's build writes the same tables; both read the renderer's sources.
  plugins: [
    react(),
    tailwindcss(),
    cn({ full: true, out: 'src/lib/cn-tables.ts', cwd: source('src/renderer') }),
  ],
  server: {
    // A dev server beside the app: the channel goes on to the host's direct port. The page's
    // Origin and Host stay this server's, so the host's Origin check holds.
    proxy: process.env.KETTU_WEB_HOST
      ? { '/channel': { target: process.env.KETTU_WEB_HOST, ws: true } }
      : undefined,
  },
  build: {
    outDir: source('out/web'),
    emptyOutDir: true,
    minify: true,
  },
})
