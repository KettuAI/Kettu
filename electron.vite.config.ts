import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cn } from 'cn/vite'
import { pageRuntime } from './tools/build/page-runtime'
import { thirdPartyNotices } from './tools/build/third-party-notices'

const sharedAlias = { '@shared': resolve('src/shared') }
const notices = thirdPartyNotices(resolve('.'))
const runtime = (): ReturnType<typeof pageRuntime> =>
  pageRuntime(resolve('src/shared/artifact-runtime/runtime.ts'))

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    plugins: [notices(), runtime()],
  },
  preload: {
    resolve: { alias: sharedAlias },
    plugins: [notices()],
    // Each page's preload is one file, since a sandboxed preload can require no chunk of its own.
    build: {
      isolatedEntries: true,
      rolldownOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          tray: resolve('src/preload/tray.ts'),
          overlay: resolve('src/preload/overlay.ts'),
        },
      },
    },
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
    plugins: [
      react(),
      tailwindcss(),
      cn({ full: true, out: 'src/lib/cn-tables.ts' }),
      notices(),
      runtime(),
    ],
    build: {
      minify: true,
      rolldownOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          tray: resolve('src/renderer/tray.html'),
          overlay: resolve('src/renderer/overlay.html'),
        },
      },
    },
  },
})
