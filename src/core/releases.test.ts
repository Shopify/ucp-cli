// Invariant tests for the per-release spec registry. These guard the contract
// phase 2 negotiation builds on: exact-version lookup, ascending version
// order, and — load-bearing — that each release's verbatim agent-profile
// snapshot validates against that same release's generated platform schema
// (the codegen script enforces this at generation time; this re-checks it in
// CI without network).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isSupportedVersion, LATEST, RELEASES, release, SUPPORTED_VERSIONS } from './releases.js'

describe('release registry shape', () => {
  it('SUPPORTED_VERSIONS is sorted ascending, unique, and keys RELEASES exactly', () => {
    expect([...SUPPORTED_VERSIONS].sort()).toStrictEqual([...SUPPORTED_VERSIONS])
    expect(new Set(SUPPORTED_VERSIONS).size).toBe(SUPPORTED_VERSIONS.length)
    expect(Object.keys(RELEASES).sort()).toStrictEqual([...SUPPORTED_VERSIONS])
  })

  it('SUPPORTED_VERSIONS matches package.json#ucp.releases (codegen input)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect([...pkg.ucp.releases].sort()).toStrictEqual([...SUPPORTED_VERSIONS])
  })

  it('LATEST is the most recent supported version', () => {
    expect(LATEST).toBe(SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1])
  })

  it('release() is an exact-version lookup', () => {
    for (const version of SUPPORTED_VERSIONS) {
      expect(release(version)?.version).toBe(version)
    }
    expect(release('2026-01-23')).toBeUndefined() // real spec release we do not ship
    expect(release('2026-08-26')).toBeUndefined() // near-miss: ranges would accept this
    expect(isSupportedVersion('not-a-version')).toBe(false)
  })

  it('each entry agrees with its key', () => {
    for (const [version, entry] of Object.entries(RELEASES)) {
      expect(entry.version).toBe(version)
      expect(entry.defaultAgentProfileUrl).toContain(version)
      expect(() => new URL(entry.defaultAgentProfileUrl)).not.toThrow()
    }
  })
})

describe('agent profile snapshots', () => {
  it.each([...SUPPORTED_VERSIONS])(
    '%s: verbatim snapshot parses, matches the template, and declares its release version',
    (version) => {
      const entry = RELEASES[version]
      const parsed = JSON.parse(entry.agentProfileJson)
      expect(parsed).toStrictEqual(entry.agentProfileTemplate)
      expect((parsed as { ucp: { version: string } }).ucp.version).toBe(version)
    },
  )

  it.each([...SUPPORTED_VERSIONS])(
    '%s: snapshot validates against its own release platform schema',
    (version) => {
      const entry = RELEASES[version]
      const result = entry.platformProfileSchema.safeParse(entry.agentProfileTemplate)
      expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true)
    },
  )
})

describe('reverse-domain patterns', () => {
  it('both releases accept canonical UCP keys', () => {
    for (const version of SUPPORTED_VERSIONS) {
      const pattern = RELEASES[version].reverseDomainPattern
      expect(pattern.test('dev.ucp.shopping.checkout')).toBe(true)
      expect(pattern.test('com.example.loyalty_gold')).toBe(true)
      expect(pattern.test('not_reverse_dns')).toBe(false)
      expect(pattern.test('Dev.Ucp.Shopping')).toBe(false)
    }
  })

  it('captures the 2026-08-25 grammar widening (hyphens, digit-leading segments)', () => {
    // These keys are VALID in 2026-08-25 and INVALID in 2026-04-08 — the
    // reason the pattern is generated per release instead of hand-copied.
    for (const key of [
      'com.example-shop.checkout',
      'com.2example.cart',
      'xn--p1ai.example.checkout',
    ]) {
      expect(RELEASES['2026-08-25'].reverseDomainPattern.test(key)).toBe(true)
      expect(RELEASES['2026-04-08'].reverseDomainPattern.test(key)).toBe(false)
    }
  })
})
