import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { pageRuntime } from './tools/build/page-runtime'

export default defineConfig({
  plugins: [pageRuntime(resolve('src/shared/artifact-runtime/runtime.ts'))],
  resolve: {
    alias: [{ find: '@shared', replacement: resolve('src/shared') }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
