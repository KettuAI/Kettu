// The daemon's build: the `kettu` CLI and the hosts it forks, for Node.js, into out/daemon/. Every
// package is bundled except node-pty, which is native and loads from beside the bundle.

import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const source = (file: string): string => fileURLToPath(new URL(file, import.meta.url))

// The daemon runs without Electron, so an import of it anywhere in its graph fails the build.
function noElectron(): Plugin {
  return {
    name: 'kettu:no-electron',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === 'electron' || id.startsWith('electron/')) {
        this.error(`${importer ?? 'An entry'} imports ${id}, which the daemon runs without`)
      }
      return null
    },
  }
}

export default defineConfig({
  root,
  resolve: { alias: { '@shared': source('src/shared') } },
  ssr: { noExternal: true },
  plugins: [noElectron()],
  build: {
    ssr: true,
    outDir: source('out/daemon'),
    emptyOutDir: true,
    minify: false,
    rolldownOptions: {
      input: {
        main: source('src/daemon/main.ts'),
        'agent-host': source('src/agent-host/node-main.ts'),
        'terminal-host': source('src/terminal-host/node-main.ts'),
        'thread-worker': source('src/agent-host/threads/worker.ts'),
        'usage-worker': source('src/agent-host/usage/worker.ts'),
        'session-router': source('src/agent-host/session-router/router.ts'),
      },
      external: [/^node:/, 'node-pty'],
      output: {
        format: 'cjs',
        entryFileNames: '[name].cjs',
        chunkFileNames: 'chunks/[name]-[hash].cjs',
        // The terminal host loads node-pty with import(), which must stay a require() here.
        dynamicImportInCjs: false,
      },
    },
  },
})
