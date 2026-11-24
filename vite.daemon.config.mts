// The daemon's build: the `kettu` CLI and the hosts it forks, for Node.js, into out/daemon/. Every
// package is bundled except node-pty, which is native and loads from beside the bundle.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { pageRuntime } from './tools/build/page-runtime'
import { standaloneThirdPartyNotices } from './tools/build/third-party-notices'

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

// The plugin host's script engine, which it reads as a file from beside the bundles.
function pluginEngine(): Plugin {
  const file = createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync/wasm')
  return {
    name: 'kettu:plugin-engine',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'quickjs.wasm', source: readFileSync(file) })
    },
  }
}

export default defineConfig({
  root,
  resolve: { alias: { '@shared': source('src/shared') } },
  ssr: { noExternal: true },
  plugins: [
    noElectron(),
    pluginEngine(),
    standaloneThirdPartyNotices(root, ['node-pty']),
    pageRuntime(source('src/shared/artifact-runtime/runtime.ts')),
  ],
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
        'device-host': source('src/device-host/node-main.ts'),
        'plugin-host': source('src/plugin-host/node-main.ts'),
        'remote-host': source('src/remote-host/node-main.ts'),
        'thread-worker': source('src/agent-host/threads/worker.ts'),
        'usage-worker': source('src/agent-host/usage/worker.ts'),
        'session-router': source('src/agent-host/session-router/router.ts'),
        'cline-host': source('src/agent-host/cline/cline-host.ts'),
      },
      external: [/^node:/, 'node-pty'],
      output: {
        format: 'cjs',
        entryFileNames: '[name].cjs',
        chunkFileNames: 'chunks/[name]-[hash].cjs',
      },
    },
  },
})
