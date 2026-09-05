import { describe, expect, it } from 'vitest'

import { parseNodeEngineFloor } from '../scripts/defines.mjs'
import { isRootVersionInvocation, runUcpCli, versionLine } from './cli.js'
import { LATEST, RELEASES, SUPPORTED_VERSIONS } from './core/releases.js'

describe('build defines', () => {
  it('CLI version is a semver-shaped string', () => {
    expect(typeof __CLI_VERSION__).toBe('string')
    expect(__CLI_VERSION__).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('Node floor keeps all three engines components', () => {
    expect(__MIN_NODE_VERSION__).toMatch(/^\d+\.\d+\.\d+$/)
    expect(parseNodeEngineFloor(`>=${__MIN_NODE_VERSION__}`)).toBe(__MIN_NODE_VERSION__)
  })

  it('rejects an engines range without one parseable three-component floor', () => {
    expect(() => parseNodeEngineFloor('>=22')).toThrow('expected ">=major.minor.patch"')
    expect(() => parseNodeEngineFloor('^22.19.0')).toThrow('expected ">=major.minor.patch"')
  })

  it('build number is a numeric string', () => {
    expect(__BUILD_NUMBER__).toMatch(/^\d+$/)
  })

  // A registry lookup cannot disagree with the release it names; a build
  // define can.
  it('default profile URL comes from the release registry, not a define', () => {
    expect(RELEASES[LATEST].defaultAgentProfileUrl).toMatch(/^https:\/\/[\w.-]+\/.+\.json(\?.*)?$/)
    expect(RELEASES[LATEST].defaultAgentProfileUrl).toContain(LATEST)
  })

  it('no protocol-version define survives', () => {
    // No version-specific build defines: the version comes from the active
    // profile. `globalThis` probe rather than a bare identifier so
    // reintroducing one fails as an assertion, not a TypeScript error.
    const g = globalThis as Record<string, unknown>
    for (const name of ['__PROTOCOL_MIN__', '__PROTOCOL_MAX__', '__SPEC_VERSION__']) {
      expect(g[name]).toBeUndefined()
    }
  })
})

// `ucp --version` answers two questions: which build is this, and which
// protocol releases does it support? The first does not imply the second —
// the active profile picks one of the supported releases — so both are
// printed.
describe('ucp --version', () => {
  it('names the build and the supported releases, derived from the registry', () => {
    expect(versionLine()).toBe(`ucp ${__CLI_VERSION__} (UCP ${SUPPORTED_VERSIONS.join(', ')})`)
    // Shape, spelled out so a refactor cannot quietly drop the parenthetical.
    expect(versionLine()).toMatch(
      /^ucp \d+\.\d+\.\d+.* \(UCP \d{4}-\d{2}-\d{2}(, \d{4}-\d{2}-\d{2})*\)$/,
    )
    for (const v of SUPPORTED_VERSIONS) expect(versionLine()).toContain(v)
  })

  it('is never hardcoded: every registry version appears, and nothing else does', () => {
    const dates = versionLine().match(/\d{4}-\d{2}-\d{2}/g) ?? []
    expect(dates.sort()).toStrictEqual([...SUPPORTED_VERSIONS].sort())
  })

  it('runUcpCli prints it and exits without dispatching', async () => {
    let out = ''
    await runUcpCli(['--version'], (s) => {
      out += s
    })
    expect(out).toBe(`${versionLine()}\n`)
  })

  // The detector must agree with incur's own rule, or `ucp profile init
  // --version 2026-04-08` would print the CLI version instead of creating a
  // profile. incur treats `--version` as the builtin only when the next token
  // is absent or starts with `-`; `--help` outranks it.
  it('distinguishes the root flag from a command-local --version VALUE', () => {
    expect(isRootVersionInvocation(['--version'])).toBe(true)
    expect(isRootVersionInvocation(['discover', '--version'])).toBe(true)
    expect(isRootVersionInvocation(['--version', '--json'])).toBe(true)
    expect(isRootVersionInvocation(['profile', 'init', '--version', '2026-04-08'])).toBe(false)
    expect(isRootVersionInvocation(['--help', '--version'])).toBe(false)
    expect(isRootVersionInvocation(['profile', 'init', '-h', '--version'])).toBe(false)
    expect(isRootVersionInvocation([])).toBe(false)
  })

  it('does not intercept a command-local --version value', async () => {
    // Regression guard for the interception seam: if this ever returns the
    // version line, `profile init --version <v>` is unreachable.
    let out = ''
    await runUcpCli(['profile', 'init', '--version'], (s) => {
      out += s
    }).catch(() => {})
    // (`--version` with no value IS the builtin, per incur's rule.)
    expect(out).toBe(`${versionLine()}\n`)
    expect(isRootVersionInvocation(['profile', 'init', '--version', '2026-08-25'])).toBe(false)
  })
})
