import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'))

export function buildDefines() {
  const cliVersion = pkg.version
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
    // Major-version floor parsed from engines. npm only *warns* on engines at
    // install time, so the CLI checks this itself (doctor `runtime` check,
    // proxy load-failure hint) — package.json stays the single source.
    __MIN_NODE_MAJOR__: JSON.stringify(Number(pkg.engines.node.match(/\d+/)[0])),
  }
}
