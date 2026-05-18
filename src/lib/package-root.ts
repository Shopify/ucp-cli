import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Locate this package's root from an ESM module URL.
 *
 * Runtime code may execute from `src/*.ts` under Vitest or from bundled
 * `dist/*.js` after publish. Walking upward to the nearest package.json keeps
 * both layouts working without hard-coding a relative depth.
 */
export function findPackageRoot(fromImportMetaUrl: string): string {
  let dir = dirname(fileURLToPath(fromImportMetaUrl))
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`could not locate package.json from ${fromImportMetaUrl}`)
    }
    dir = parent
  }
}
