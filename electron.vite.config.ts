import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cn } from 'cn/vite'
import { thirdPartyNotices } from './tools/build/third-party-notices'

const sharedAlias = { '@shared': resolve('src/shared') }
const notices = thirdPartyNotices(resolve('.'))

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    plugins: [notices()],
  },
  preload: {
    resolve: { alias: sharedAlias },
    plugins: [notices()],
  },
  renderer: {
    resolve: {
      alias: [
        { find: '@shared', replacement: resolve('src/shared') },
        { find: '@renderer', replacement: resolve('src/renderer/src') },
        // The shadcn CLI imports cn from the package; give it the theme-aware instance.
        { find: /^cn$/, replacement: resolve('src/renderer/src/lib/utils.ts') },
      ],
    },
    // Full tables depend only on the theme, so tests can use the committed file as is.
    plugins: [react(), tailwindcss(), cn({ full: true, out: 'src/lib/cn-tables.ts' }), notices()],
    build: { minify: true },
  },
})
