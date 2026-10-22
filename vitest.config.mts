import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve('src/shared') },
      { find: '@renderer', replacement: resolve('src/renderer/src') },
      { find: /^cn$/, replacement: resolve('src/renderer/src/lib/utils.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
    // Process tests spawn real child processes, which is slow on Windows runners.
    testTimeout: 20_000,
  },
})
