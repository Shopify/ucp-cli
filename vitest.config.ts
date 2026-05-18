import { defineConfig } from 'vitest/config'
import { buildDefines } from './scripts/defines.mjs'

export default defineConfig({
  define: buildDefines(),
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 10_000,
  },
})
