// One-time legacy profile upgrade: the classifier, and the storage boundary
// that applies it.
//
// The fixtures under test/fixtures/legacy-profiles/ are the actual documents
// old releases wrote — see PROVENANCE.md for how each was extracted from git.
// They are frozen: a test that needs a variation copies and edits one here, so
// "what shipped" and "what a user did to it" never share a file.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  canonicalJson,
  classifyStoredProfile,
  GENERATED_BODY_FINGERPRINTS,
  generatedBodyVersion,
  HISTORICAL_GENERATED_BODY_PROVENANCE,
  PROFILE_FORMAT_VERSION,
  profileBodyFingerprint,
} from './legacy-profile.js'
import { type ProfileMeta, profileDir, readUserProfile } from './profile-store.js'
import { RELEASES } from './releases.js'
import { setWarnWriter } from './verbose.js'

const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/legacy-profiles/', import.meta.url))

/** STOCK-A: npm 0.4.2 … 0.7.0. */
const STOCK_A = 'stock-a-2026-04-08.json'
/** STOCK-B: npm 0.8.0. */
const STOCK_B = 'stock-b-2026-08-25.json'
/** STOCK-A0: internal 0.1.x dev builds, never published. */
const STOCK_A0 = 'stock-a0-prerelease-2026-04-08.json'

async function fixtureBytes(name: string): Promise<string> {
  return readFile(join(FIXTURE_DIR, name), 'utf-8')
}

async function fixtureBody(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fixtureBytes(name)) as Record<string, unknown>
}

/**
 * `meta.json` as 0.4.2 … 0.8.0 actually wrote it for a stock init: timestamps,
 * the since-removed `protocol_versions`, and NO `profile_url` (that field was
 * written only from an explicit `--profile-url`; the upload seam that could
 * otherwise have filled it always returned `{}`).
 */
const LEGACY_META: ProfileMeta = {
  created_at: '2026-06-01T10:00:00.000Z',
  updated_at: '2026-06-01T10:00:00.000Z',
  protocol_versions: { min: '2026-01-23', max: '2026-04-08' },
}

/** Same document, every object's keys emitted in the opposite order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .reverse()
      .map((key) => [key, reverseKeys(record[key])]),
  )
}

// ─── the fingerprint table itself ─────────────────────────────────────────

describe('generated-body fingerprints', () => {
  it('matches the frozen fixtures byte-for-byte through canonical JSON', async () => {
    for (const entry of HISTORICAL_GENERATED_BODY_PROVENANCE) {
      expect(GENERATED_BODY_FINGERPRINTS.get(entry.sha256)).toBe(entry.version)
    }
    // Each fixture hashes to the historical digest recorded for it. If a
    // fixture is ever re-generated or reformatted, this is what catches it.
    const expected: Array<[string, string]> = [
      [STOCK_A, '508d145091f0efb805aacd7b21bc738b3dfa108c7b1d59748c66c00fe391b3cd'],
      [STOCK_B, '3a75f9cf8e416ecbc716c303b6356dc1c9f6dce702f419654460eda0bf692ff5'],
      [STOCK_A0, 'c928a7ed8d841f2da6571203845c8cb87d42c7d94fac28d48b39a65073e55c76'],
    ]
    for (const [file, sha256] of expected) {
      expect(profileBodyFingerprint(await fixtureBody(file))).toBe(sha256)
    }
  })

  it('recognizes every current release template', () => {
    for (const rel of Object.values(RELEASES)) {
      expect(generatedBodyVersion(JSON.parse(rel.agentProfileJson))).toBe(rel.version)
    }
  })

  it('reports the release each historical body declares', async () => {
    expect(generatedBodyVersion(await fixtureBody(STOCK_A))).toBe('2026-04-08')
    expect(generatedBodyVersion(await fixtureBody(STOCK_A0))).toBe('2026-04-08')
    expect(generatedBodyVersion(await fixtureBody(STOCK_B))).toBe('2026-08-25')
  })

  it('is blind to formatting and key order, and sensitive to values', async () => {
    const body = await fixtureBody(STOCK_B)
    expect(profileBodyFingerprint(reverseKeys(body))).toBe(profileBodyFingerprint(body))

    // Array order is data, not formatting.
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })
})

// ─── the pure classifier ──────────────────────────────────────────────────

describe('classifyStoredProfile', () => {
  it('reads an untouched generated body with no URL as managed', async () => {
    for (const file of [STOCK_A, STOCK_B, STOCK_A0]) {
      expect(classifyStoredProfile(await fixtureBody(file), LEGACY_META)).toEqual({
        kind: 'managed',
        needsMarker: true,
      })
    }
  })

  it('keeps a generated body managed under its own release default URL', async () => {
    // The one URL a managed rendering would advertise for these bytes anyway.
    expect(
      classifyStoredProfile(await fixtureBody(STOCK_A), {
        profile_url: RELEASES['2026-04-08'].defaultAgentProfileUrl,
      }).kind,
    ).toBe('managed')
    expect(
      classifyStoredProfile(await fixtureBody(STOCK_B), {
        profile_url: RELEASES['2026-08-25'].defaultAgentProfileUrl,
      }).kind,
    ).toBe('managed')
    // Trailing-slash / case-of-host normalization is not an edit either.
    expect(
      classifyStoredProfile(await fixtureBody(STOCK_B), {
        profile_url: RELEASES['2026-08-25'].defaultAgentProfileUrl.replace(
          'shopify.dev',
          'SHOPIFY.dev',
        ),
      }).kind,
    ).toBe('managed')
  })

  it('treats any other URL beside a stock body as DIY', async () => {
    const body = await fixtureBody(STOCK_A)
    for (const profile_url of [
      'https://mybot.example.com/.well-known/ucp',
      // A different release's default URL is still a decision: a managed
      // Profile would never advertise the 08-25 document for an 04-08 body.
      RELEASES['2026-08-25'].defaultAgentProfileUrl,
    ]) {
      expect(classifyStoredProfile(body, { ...LEGACY_META, profile_url }).kind).toBe('diy')
    }
  })

  it('treats one semantic edit as DIY', async () => {
    const body = await fixtureBody(STOCK_A)
    const ucp = body.ucp as Record<string, unknown>
    const capabilities = { ...(ucp.capabilities as Record<string, unknown>) }
    delete capabilities['dev.shopify.catalog.global']
    const edited = { ...body, ucp: { ...ucp, capabilities } }

    expect(classifyStoredProfile(edited, LEGACY_META).kind).toBe('diy')
  })

  it('honors an explicit marker over any fingerprint, in both directions', async () => {
    const stock = await fixtureBody(STOCK_B)
    expect(classifyStoredProfile(stock, { kind: 'diy', format_version: 2 })).toEqual({
      kind: 'diy',
      needsMarker: false,
    })
    expect(
      classifyStoredProfile({ hand: 'written' }, { kind: 'managed', format_version: 2 }),
    ).toEqual({ kind: 'managed', needsMarker: false })
  })

  it('re-stamps a kind written without a format_version', async () => {
    // Hand-edited or half-written marker: honor the stated kind, but finish
    // the marker so the next read is a plain lookup.
    expect(classifyStoredProfile(await fixtureBody(STOCK_B), { kind: 'diy' })).toEqual({
      kind: 'diy',
      needsMarker: true,
    })
  })

  it('accepts a marker from a newer format_version without downgrading it', async () => {
    expect(
      classifyStoredProfile(await fixtureBody(STOCK_B), {
        kind: 'diy',
        format_version: PROFILE_FORMAT_VERSION + 1,
      }),
    ).toEqual({ kind: 'diy', needsMarker: false })
  })
})

// ─── the storage boundary ─────────────────────────────────────────────────

describe('readUserProfile — one-time legacy upgrade', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-legacy-test-'))
  })

  afterEach(async () => {
    setWarnWriter(null)
    await rm(homeDir, { recursive: true, force: true })
  })

  /** Write a profile directory exactly as an old release left it: no marker. */
  async function seedLegacy(
    name: string,
    bodyBytes: string,
    meta: Record<string, unknown> = LEGACY_META,
  ): Promise<string> {
    const dir = profileDir(name, { homeDir })
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, 'profile.json'), bodyBytes, 'utf-8')
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
    return dir
  }

  it('upgrades an untouched v0.7 profile to managed and leaves profile.json alone', async () => {
    const bytes = await fixtureBytes(STOCK_A)
    const dir = await seedLegacy('legacy07', bytes)

    const read = await readUserProfile('legacy07', { homeDir })

    expect(read.kind).toBe('managed')
    expect(read).not.toHaveProperty('body')
    expect(await readFile(join(dir, 'profile.json'), 'utf-8')).toBe(bytes)
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8')) as ProfileMeta
    expect(meta).toEqual({
      ...LEGACY_META,
      format_version: PROFILE_FORMAT_VERSION,
      kind: 'managed',
    })
    // Everything the user (or an old release) owned survives, unmoved.
    expect(meta.created_at).toBe(LEGACY_META.created_at)
    expect(meta.updated_at).toBe(LEGACY_META.updated_at)
    expect(read.meta).toEqual(meta)
  })

  it('upgrades an untouched v0.8 profile to managed', async () => {
    const dir = await seedLegacy('legacy08', await fixtureBytes(STOCK_B))

    const read = await readUserProfile('legacy08', { homeDir })

    expect(read.kind).toBe('managed')
    expect((JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8')) as ProfileMeta).kind).toBe(
      'managed',
    )
  })

  it('reads a current managed marker without requiring profile.json', async () => {
    const dir = profileDir('bodyless', { homeDir })
    const meta = {
      ...LEGACY_META,
      format_version: PROFILE_FORMAT_VERSION,
      kind: 'managed' as const,
    }
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
    let writes = 0

    const read = await readUserProfile('bodyless', {
      homeDir,
      writeMeta: async () => {
        writes += 1
        throw new Error('a current marker must not be re-stamped')
      },
    })

    expect(read).toEqual({ name: 'bodyless', meta, kind: 'managed' })
    expect(read).not.toHaveProperty('body')
    expect(writes).toBe(0)
    await expect(stat(join(dir, 'profile.json'))).rejects.toThrow()
  })

  it('finishes an old managed marker without parsing or changing corrupt downgrade bytes', async () => {
    const corruptBody = '{ historical profile bytes are now corrupt\n'
    const dir = await seedLegacy('old-marker', corruptBody, {
      ...LEGACY_META,
      kind: 'managed',
    })

    const read = await readUserProfile('old-marker', { homeDir })

    expect(read.kind).toBe('managed')
    expect(read).not.toHaveProperty('body')
    expect(read.meta).toMatchObject({
      ...LEGACY_META,
      format_version: PROFILE_FORMAT_VERSION,
      kind: 'managed',
    })
    expect(await readFile(join(dir, 'profile.json'), 'utf-8')).toBe(corruptBody)
  })

  it.each([
    { damage: 'missing', code: 'PROFILE_NOT_FOUND' },
    { damage: 'corrupt', code: 'SCHEMA_VALIDATION_FAILED' },
  ])('rejects an unmarked legacy entry whose profile.json is $damage', async ({ damage, code }) => {
    const dir = await seedLegacy('unmarked-damage', await fixtureBytes(STOCK_A))
    const bodyPath = join(dir, 'profile.json')
    if (damage === 'missing') await rm(bodyPath)
    else await writeFile(bodyPath, '<not json>', 'utf-8')

    await expect(readUserProfile('unmarked-damage', { homeDir })).rejects.toMatchObject({
      code,
      context: { kind: 'profile-store', profile: 'unmarked-damage', file: 'profile.json' },
    })
  })

  it('upgrades a current generated body + default URL that carries no marker', async () => {
    await seedLegacy('fresh', `${RELEASES['2026-08-25'].agentProfileJson}`, {
      created_at: '2026-09-01T00:00:00.000Z',
      profile_url: RELEASES['2026-08-25'].defaultAgentProfileUrl,
    })

    expect((await readUserProfile('fresh', { homeDir })).kind).toBe('managed')
  })

  it('marks one semantic edit DIY and preserves the edited body and user meta', async () => {
    const body = await fixtureBody(STOCK_A)
    const ucp = body.ucp as Record<string, unknown>
    const services = ucp.services as Record<string, unknown>
    const edited = {
      ...body,
      ucp: {
        ...ucp,
        services: {
          ...services,
          'com.acme.loyalty': [{ version: '2026-04-08', transport: 'mcp' }],
        },
      },
    }
    const bytes = `${JSON.stringify(edited, null, 2)}\n`
    const dir = await seedLegacy('edited', bytes, {
      ...LEGACY_META,
      defaults: { catalog: 'https://catalog.acme.example' },
    })

    const read = await readUserProfile('edited', { homeDir })

    expect(read.kind).toBe('diy')
    expect(await readFile(join(dir, 'profile.json'), 'utf-8')).toBe(bytes)
    expect(read.meta).toMatchObject({
      created_at: LEGACY_META.created_at,
      protocol_versions: LEGACY_META.protocol_versions,
      defaults: { catalog: 'https://catalog.acme.example' },
      format_version: PROFILE_FORMAT_VERSION,
      kind: 'diy',
    })
    if (read.kind !== 'diy') throw new Error('expected edited legacy Profile to remain DIY')
    expect(
      ((read.body.ucp.services ?? {}) as Record<string, unknown>)['com.acme.loyalty'],
    ).toBeDefined()
  })

  it('marks a stock body under a custom URL DIY', async () => {
    await seedLegacy('hosted', await fixtureBytes(STOCK_B), {
      ...LEGACY_META,
      profile_url: 'https://mybot.example.com/.well-known/ucp',
    })

    const read = await readUserProfile('hosted', { homeDir })

    expect(read.kind).toBe('diy')
    expect(read.meta.profile_url).toBe('https://mybot.example.com/.well-known/ucp')
  })

  it('leaves an explicitly marked DIY stock body DIY, and writes nothing', async () => {
    const dir = await seedLegacy('pinned', await fixtureBytes(STOCK_B), {
      ...LEGACY_META,
      format_version: PROFILE_FORMAT_VERSION,
      kind: 'diy',
    })
    const before = await stat(join(dir, 'meta.json'))

    const read = await readUserProfile('pinned', {
      homeDir,
      writeMeta: async () => {
        throw new Error('a marked profile must not be re-stamped')
      },
    })

    expect(read.kind).toBe('diy')
    expect((await stat(join(dir, 'meta.json'))).mtimeMs).toBe(before.mtimeMs)
  })

  it('never touches headers.json', async () => {
    const dir = await seedLegacy('withheaders', await fixtureBytes(STOCK_A))
    // Deliberately ugly bytes: tabs, trailing newline-less end, key order the
    // formatter would change. Byte equality is the assertion.
    const headers = '{\n\t"default": {"X-Trace": "keep-me"},\n\t"businesses": {}\n}'
    await writeFile(join(dir, 'headers.json'), headers, 'utf-8')

    await readUserProfile('withheaders', { homeDir })

    expect(await readFile(join(dir, 'headers.json'), 'utf-8')).toBe(headers)
  })

  it('is idempotent: the second read neither writes nor changes anything', async () => {
    const dir = await seedLegacy('twice', await fixtureBytes(STOCK_A))
    let writes = 0
    const writeMeta = async (path: string, content: string) => {
      writes += 1
      await writeFile(path, content, 'utf-8')
    }

    const first = await readUserProfile('twice', { homeDir, writeMeta })
    const afterFirst = await readFile(join(dir, 'meta.json'), 'utf-8')
    const second = await readUserProfile('twice', { homeDir, writeMeta })

    expect(writes).toBe(1)
    expect(second.kind).toBe(first.kind)
    expect(second.meta).toEqual(first.meta)
    expect(await readFile(join(dir, 'meta.json'), 'utf-8')).toBe(afterFirst)
  })

  it('classifies an exploratory scan without stamping metadata or warning on a blocked write', async () => {
    const warnings: string[] = []
    setWarnWriter((msg) => warnings.push(msg))
    const dir = await seedLegacy('scanned', await fixtureBytes(STOCK_A))
    const untouched = await readFile(join(dir, 'meta.json'), 'utf-8')
    let writes = 0

    const read = await readUserProfile('scanned', {
      homeDir,
      migrate: false,
      writeMeta: async () => {
        writes += 1
        throw new Error('EROFS: scan must never try this write')
      },
    })

    expect(read.kind).toBe('managed')
    expect(read.meta.kind).toBeUndefined()
    expect(read.meta.format_version).toBeUndefined()
    expect(writes).toBe(0)
    expect(warnings).toEqual([])
    expect(await readFile(join(dir, 'meta.json'), 'utf-8')).toBe(untouched)
  })

  it('keeps working when the marker cannot be written', async () => {
    const warnings: string[] = []
    setWarnWriter((msg) => warnings.push(msg))
    const dir = await seedLegacy('readonly', await fixtureBytes(STOCK_A))
    const untouched = await readFile(join(dir, 'meta.json'), 'utf-8')

    const read = await readUserProfile('readonly', {
      homeDir,
      writeMeta: async () => {
        throw new Error('EROFS: read-only file system')
      },
    })

    // The classification still holds for this process: commerce does not wait
    // on a bookkeeping write.
    expect(read.kind).toBe('managed')
    expect(read.meta.kind).toBe('managed')
    expect(read.meta.format_version).toBe(PROFILE_FORMAT_VERSION)
    expect(warnings.join('')).toContain('EROFS')
    expect(warnings.join('')).toContain('readonly')
    // Nothing was half-written, and the next process retries.
    expect(await readFile(join(dir, 'meta.json'), 'utf-8')).toBe(untouched)
    expect((await readUserProfile('readonly', { homeDir })).kind).toBe('managed')
  })
})
