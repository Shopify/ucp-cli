import { defineConfig } from 'tsup'
import { buildDefines } from './scripts/defines.mjs'

export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  clean: true,
  shims: false,
  splitting: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  define: buildDefines(),
})
