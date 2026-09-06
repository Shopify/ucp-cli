import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'))

/** @param {unknown} engine */
export function parseNodeEngineFloor(engine) {
  const match =
    typeof engine === 'string'
      ? /^\s*>=\s*((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\s*$/.exec(engine)
      : null
  if (match?.[1] === undefined) {
    throw new Error(
      `Cannot parse package.json engines.node=${JSON.stringify(engine)}; expected ">=major.minor.patch"`,
    )
  }
  return match[1]
}

export function buildDefines() {
  const cliVersion = pkg.version
  const minimumNodeVersion = parseNodeEngineFloor(pkg.engines?.node)
  let buildNumber = '0'
  try {
    buildNumber = execSync('git rev-list --count HEAD', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    // not a git repo, or no commits yet — fall back to '0'
  }
  // No protocol-version defines belong here: the version comes from the active
  // agent profile, and every version-specific artifact lives in
  // `src/core/releases.ts`.
  return {
    __CLI_VERSION__: JSON.stringify(cliVersion),
    __BUILD_NUMBER__: JSON.stringify(buildNumber),
    // Catalog MCP endpoint baked onto the synthetic `default` profile's
    // `meta.defaults.catalog` at boot in session.ts. Drives the zero-config
    // `ucp catalog search` flow: fresh installs route catalog ops here without
    // requiring `ucp profile init --catalog`. Runtime source of truth is the
    // synthetic profile; this define is the build-time provenance.
    __DEFAULT_CATALOG_URL__: JSON.stringify(pkg.ucp.default_catalog_url),
    // Keep the complete engines floor: npm only *warns* at install time, so
    // the CLI checks it itself (doctor `runtime` check, proxy load-failure
    // hint). A major-only check can silently admit excluded Node releases.
    __MIN_NODE_VERSION__: JSON.stringify(minimumNodeVersion),
  }
}
