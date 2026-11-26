import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { pageRuntime } from './tools/build/page-runtime.ts'
import { sandboxShim } from './tools/build/sandbox-shim.ts'

export default defineConfig({
  plugins: [
    pageRuntime(resolve('src/shared/artifact-runtime/runtime.ts')),
    sandboxShim(resolve('src/renderer/src/web/sandbox-shim.ts')),
  ],
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve('src/shared') },
      { find: '@renderer', replacement: resolve('src/renderer/src') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
})
