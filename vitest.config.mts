import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [{ find: '@shared', replacement: resolve('src/shared') }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
