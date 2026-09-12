// resolveSession tests.

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDiyProfile } from '../core/agent.js'
import { PROFILE_FORMAT_VERSION } from '../core/legacy-profile.js'
import type { PlatformProfile } from '../core/profile.js'
import { saveUserProfile, writeActive } from '../core/profile-store.js'
import { LATEST, RELEASES } from '../core/releases.js'
import { setWarnWriter } from '../core/verbose.js'
import { resolveSession } from './session.js'

const SAMPLE_BODY: PlatformProfile = {
  ucp: {
    version: '2026-08-25',
    status: 'success',
    services: {},
    payment_handlers: {},
  },
  // `keys` is the published JWK Set a counterparty would use to
  // verify signatures. We carry one so fixtures look realistic, but v0.1 does
  // not exercise signing — see session.ts header.
  keys: [
    {
      kid: 'agent-key-1',
      kty: 'EC',
      crv: 'P-256',
      x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
      y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
      alg: 'ES256',
    },
  ],
}

const SAMPLE_META = {
  created_at: '2026-05-05T12:00:00Z',
  profile_url: 'https://mybot.example.com/.well-known/ucp',
}

async function seedUserProfile(homeDir: string, name = 'prod'): Promise<void> {
  await saveUserProfile({ name, body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
}

function onlyProfileUrl(session: Awaited<ReturnType<typeof resolveSession>>): string {
  const renderings = Object.values(session.profile.renderings)
  expect(renderings).toHaveLength(1)
  return (renderings[0] as (typeof renderings)[number]).url
}

afterEach(() => {
  setWarnWriter(null)
})

describe('resolveSession — implicit managed Profile', () => {
  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-session-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('resolves a fresh home to managed renderings plus the catalog default', async () => {
    const session = await resolveSession({ homeDir, env: {} })

    expect(session.profile.source).toBe('managed')
    expect(session.profile).not.toHaveProperty('kind')
    expect(session.profile.urlOverride).toBe(false)
    expect(session.profile.name).toBeUndefined()
    expect(Object.keys(session.profile.renderings).sort()).toEqual(['2026-04-08', '2026-08-25'])
    expect(session.profileMeta?.defaults?.catalog).toBe('https://catalog.shopify.com')
  })

  it('turns a known --profile-url with no name into that release singleton without warning', async () => {
    const warnings: string[] = []
    setWarnWriter((message) => warnings.push(message))
    const url = RELEASES['2026-04-08'].defaultAgentProfileUrl
    const session = await resolveSession({ homeDir, env: {}, profileUrl: url })

    expect(session.profile.source).toBe('url')
    expect(session.profile.urlOverride).toBe(true)
    expect(session.profile.name).toBeUndefined()
    expect(Object.keys(session.profile.renderings)).toEqual(['2026-04-08'])
    expect(onlyProfileUrl(session)).toBe(url)
    expect(warnings).toEqual([])
  })

  it('warns that unknown UCP_AGENT_PROFILE_URL uses the latest bundled body', async () => {
    const warnings: string[] = []
    setWarnWriter((message) => warnings.push(message))
    const url = 'https://agent.example.com/custom.json'
    const session = await resolveSession({
      homeDir,
      env: { UCP_AGENT_PROFILE_URL: url },
    })

    expect(session.profile.source).toBe('url')
    expect(session.profile.urlOverride).toBe(true)
    expect(Object.keys(session.profile.renderings)).toEqual([LATEST])
    expect(onlyProfileUrl(session)).toBe(url)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`bundled UCP ${LATEST} body`)
    expect(warnings[0]).toMatch(/planning and negotiation/i)
    expect(warnings[0]).toContain('ucp doctor')
  })

  it("treats active.yaml profile 'default' as a normal local profile name", async () => {
    await seedUserProfile(homeDir, 'default')
    await writeActive({ profile: 'default' }, { homeDir })
    const session = await resolveSession({ homeDir, env: {} })
    expect(session.profile.name).toBe('default')
  })
})

describe('resolveSession — user profile branch', () => {
  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-session-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('loads profile from disk when --profile names a user profile', async () => {
    await seedUserProfile(homeDir, 'prod')
    const session = await resolveSession({ homeDir, env: {}, profile: 'prod' })
    expect(session.profile).toMatchObject({
      source: 'diy',
      urlOverride: false,
      name: 'prod',
    })
    expect(Object.keys(session.profile.renderings)).toEqual(['2026-08-25'])
    expect(onlyProfileUrl(session)).toBe('https://mybot.example.com/.well-known/ucp')
  })

  it('throws PROFILE_NOT_FOUND when the named profile is not on disk', async () => {
    await expect(resolveSession({ homeDir, env: {}, profile: 'ghost' })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
      layer: 'client',
    })
  })

  it("falls back to the body release's published URL when meta.profile_url is absent", async () => {
    const body = JSON.parse(RELEASES['2026-04-08'].agentProfileJson) as PlatformProfile
    await saveUserProfile(
      {
        name: 'pinned-0408',
        body,
        // Marked DIY on purpose. These bytes ARE the 04-08 release template,
        // so an unmarked copy is a generated body and upgrades to managed
        // (see profile-store.test.ts); the URL fallback under test is the DIY
        // one, and the marker is how a user keeps a template body pinned.
        meta: { ...SAMPLE_META, profile_url: undefined, format_version: 2, kind: 'diy' },
      },
      { homeDir },
    )
    const session = await resolveSession({ homeDir, env: {}, profile: 'pinned-0408' })

    expect(Object.keys(session.profile.renderings)).toEqual(['2026-04-08'])
    expect(onlyProfileUrl(session)).toBe(RELEASES['2026-04-08'].defaultAgentProfileUrl)
  })

  it('--profile-url wins over env and named profile metadata', async () => {
    await seedUserProfile(homeDir, 'hosted')
    const session = await resolveSession({
      homeDir,
      env: { UCP_AGENT_PROFILE_URL: 'https://env.example.com/profile.json' },
      profile: 'hosted',
      profileUrl: 'https://flag.example.com/profile.json',
    })
    expect(session.profile).toMatchObject({ source: 'diy', urlOverride: true })
    expect(onlyProfileUrl(session)).toBe('https://flag.example.com/profile.json')
  })

  it('marks an explicit URL override even when it equals stored metadata', async () => {
    await seedUserProfile(homeDir, 'same-url')
    const session = await resolveSession({
      homeDir,
      env: { UCP_AGENT_PROFILE_URL: SAMPLE_META.profile_url },
      profile: 'same-url',
    })

    expect(session.profile).toMatchObject({ source: 'diy', urlOverride: true })
    expect(session.profile.renderings['2026-08-25']).toMatchObject({
      source: 'diy',
      urlOverride: true,
      url: SAMPLE_META.profile_url,
    })
  })

  it('preserves an exact custom DIY body without a bundled-body substitution warning', async () => {
    const warnings: string[] = []
    setWarnWriter((message) => warnings.push(message))
    const customBody = structuredClone(SAMPLE_BODY)
    customBody.ucp.services = {
      'com.example.override_service': [
        { version: '2025-11-01', transport: 'mcp', config: { marker: 'unique-service' } },
      ],
    }
    customBody.ucp.capabilities = {
      'com.example.override_capability': [
        { version: '2025-11-01', config: { marker: 'unique-capability' } },
      ],
    }
    await saveUserProfile({ name: 'hosted', body: customBody, meta: SAMPLE_META }, { homeDir })

    const overrideUrl = 'https://env.example.com/profile.json'
    const session = await resolveSession({
      homeDir,
      env: { UCP_AGENT_PROFILE_URL: overrideUrl },
      profile: 'hosted',
    })
    const selected = session.profile.renderings['2026-08-25']

    // Assert authored content before provenance labels so a bundled-body
    // substitution mutant is killed by the behavior this test exists to pin.
    expect(selected?.body).toStrictEqual(customBody)
    expect(selected?.services['com.example.override_service']).toStrictEqual(
      customBody.ucp.services['com.example.override_service'],
    )
    expect(selected?.capabilities).toContain('com.example.override_capability')
    expect(session.profile).toMatchObject({
      source: 'diy',
      urlOverride: true,
      name: 'hosted',
    })
    expect(Object.keys(session.profile.renderings)).toEqual(['2026-08-25'])
    expect(selected).toMatchObject({
      source: 'diy',
      urlOverride: true,
      url: overrideUrl,
      version: customBody.ucp.version,
    })
    expect(warnings).toEqual([])
  })

  it('passes user profile meta through to ResolvedSession', async () => {
    // The catalog-op handler needs `profileMeta.defaults.catalog` after a
    // resolveSession() that returned no business; surfacing meta is the seam
    // that lets the handler decide whether to fire the fallback rung without
    // re-reading the profile from disk.
    await saveUserProfile(
      {
        name: 'with-defaults',
        body: SAMPLE_BODY,
        meta: {
          ...SAMPLE_META,
          defaults: { catalog: 'https://custom-catalog.example.com' },
        },
      },
      { homeDir },
    )
    const session = await resolveSession({ homeDir, env: {}, profile: 'with-defaults' })
    expect(session.profileMeta?.defaults?.catalog).toBe('https://custom-catalog.example.com')
    expect(session.profileMeta?.created_at).toBe(SAMPLE_META.created_at)
  })

  it('falls back to the baked-in default catalog when profile + env are unset', async () => {
    await seedUserProfile(homeDir, 'no-defaults')
    const session = await resolveSession({ homeDir, env: {}, profile: 'no-defaults' })
    expect(session.profileMeta).toBeDefined()
    expect(session.profileMeta?.defaults?.catalog).toBe('https://catalog.shopify.com')
  })

  it('UCP_DEFAULT_CATALOG overrides the baked-in default but loses to the profile value', async () => {
    await seedUserProfile(homeDir, 'env-override')
    const envOnly = await resolveSession({
      homeDir,
      env: { UCP_DEFAULT_CATALOG: 'https://staging-catalog.example.com' },
      profile: 'env-override',
    })
    expect(envOnly.profileMeta?.defaults?.catalog).toBe('https://staging-catalog.example.com')

    await saveUserProfile(
      {
        name: 'profile-wins',
        body: SAMPLE_BODY,
        meta: { ...SAMPLE_META, defaults: { catalog: 'https://from-profile.example.com' } },
      },
      { homeDir },
    )
    const profileWins = await resolveSession({
      homeDir,
      env: { UCP_DEFAULT_CATALOG: 'https://staging-catalog.example.com' },
      profile: 'profile-wins',
    })
    expect(profileWins.profileMeta?.defaults?.catalog).toBe('https://from-profile.example.com')
  })
})

// The upgraded-legacy path, end to end from disk. The classification itself is
// core/legacy-profile.test.ts's job; what matters here is that an operator who
// ran `ucp profile init` on 0.7.0 gets a working, multi-rendering session out
// of the same directory — today that profile cannot dispatch at all, because
// its generated body declares dev.ucp.shopping at 2026-01-23 inside a
// 2026-04-08 document and loadAgentProfile's snapshot rule rejects it.
describe('resolveSession — upgraded legacy profile', () => {
  const FIXTURE_DIR = fileURLToPath(
    new URL('../../test/fixtures/legacy-profiles/', import.meta.url),
  )
  /** meta.json as 0.4.2 … 0.8.0 wrote it: no profile_url, no marker. */
  const LEGACY_META = {
    created_at: '2026-06-01T10:00:00.000Z',
    updated_at: '2026-06-01T10:00:00.000Z',
    protocol_versions: { min: '2026-01-23', max: '2026-04-08' },
  }

  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-session-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  async function seedLegacy(name: string, fixture: string, meta = LEGACY_META): Promise<string> {
    const dir = join(homeDir, 'profiles', name)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(
      join(dir, 'profile.json'),
      await readFile(join(FIXTURE_DIR, fixture), 'utf-8'),
      'utf-8',
    )
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
    return dir
  }

  it('resolves an untouched v0.7 profile to every installed rendering, under its own name', async () => {
    const dir = await seedLegacy('legacy07', 'stock-a-2026-04-08.json')
    const before = await readFile(join(dir, 'profile.json'), 'utf-8')

    const session = await resolveSession({ homeDir, env: {}, profile: 'legacy07' })

    expect(session.profile.source).toBe('managed')
    expect(session.profile.urlOverride).toBe(false)
    // The name is what selects headers.json and addresses this identity.
    expect(session.profile.name).toBe('legacy07')
    expect(Object.keys(session.profile.renderings).sort()).toEqual(['2026-04-08', '2026-08-25'])
    for (const version of ['2026-04-08', '2026-08-25'] as const) {
      const installed = session.profile.renderings[version]
      expect(installed?.url).toBe(RELEASES[version].defaultAgentProfileUrl)
      expect(installed?.name).toBe('legacy07')
    }
    // Local metadata and defaults survive the upgrade.
    expect(session.profileMeta.created_at).toBe(LEGACY_META.created_at)
    expect(session.profileMeta.defaults?.catalog).toBe('https://catalog.shopify.com')
    // The old body is retained on disk for a downgrade; it just is not what
    // we negotiate from any more.
    expect(await readFile(join(dir, 'profile.json'), 'utf-8')).toBe(before)
  })

  it('does not raise AGENT_PROFILE_VERSION_MISMATCH on the v0.7 body', async () => {
    await seedLegacy('legacy07', 'stock-a-2026-04-08.json')

    // Guard the premise: that body really is the one the snapshot rule kills.
    expect(() =>
      createDiyProfile({
        name: 'legacy07',
        body: JSON.parse(
          readFileSync(join(FIXTURE_DIR, 'stock-a-2026-04-08.json'), 'utf-8'),
        ) as unknown,
      }),
    ).toThrow(expect.objectContaining({ code: 'AGENT_PROFILE_VERSION_MISMATCH' }))

    await expect(resolveSession({ homeDir, env: {}, profile: 'legacy07' })).resolves.toMatchObject({
      profile: { source: 'managed' },
    })
  })

  it('resolves an untouched v0.8 profile to managed too', async () => {
    await seedLegacy('legacy08', 'stock-b-2026-08-25.json')

    const session = await resolveSession({ homeDir, env: {}, profile: 'legacy08' })

    expect(session.profile.source).toBe('managed')
    expect(Object.keys(session.profile.renderings).sort()).toEqual(['2026-04-08', '2026-08-25'])
  })

  it.each([
    { state: 'missing', bodyBytes: undefined },
    { state: 'corrupt', bodyBytes: '<not historical json>\n' },
  ])('resolves a marked managed alias with $state profile.json', async ({ bodyBytes }) => {
    const name = 'marked-managed'
    const dir = join(homeDir, 'profiles', name)
    const bodyPath = join(dir, 'profile.json')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(
      join(dir, 'meta.json'),
      `${JSON.stringify({
        ...LEGACY_META,
        format_version: PROFILE_FORMAT_VERSION,
        kind: 'managed',
      })}\n`,
      'utf-8',
    )
    if (bodyBytes !== undefined) await writeFile(bodyPath, bodyBytes, 'utf-8')

    const session = await resolveSession({ homeDir, env: {}, profile: name })

    expect(session.profile).toMatchObject({ source: 'managed', name })
    expect(Object.keys(session.profile.renderings).sort()).toEqual(['2026-04-08', '2026-08-25'])
    if (bodyBytes !== undefined) expect(await readFile(bodyPath, 'utf-8')).toBe(bodyBytes)
  })

  it('keeps a stock body with a user-owned URL as a pinned DIY singleton', async () => {
    await seedLegacy('hosted', 'stock-b-2026-08-25.json', {
      ...LEGACY_META,
      profile_url: 'https://mybot.example.com/.well-known/ucp',
    } as typeof LEGACY_META)

    const session = await resolveSession({ homeDir, env: {}, profile: 'hosted' })

    expect(session.profile.source).toBe('diy')
    expect(Object.keys(session.profile.renderings)).toEqual(['2026-08-25'])
    expect(onlyProfileUrl(session)).toBe('https://mybot.example.com/.well-known/ucp')
  })

  it('lets an explicit --profile-url pin an upgraded profile to that one URL', async () => {
    const warnings: string[] = []
    setWarnWriter((message) => warnings.push(message))
    await seedLegacy('legacy07', 'stock-a-2026-04-08.json')

    const session = await resolveSession({
      homeDir,
      env: {},
      profile: 'legacy07',
      profileUrl: 'https://agent.example.com/custom.json',
    })

    // A scalar URL is one ad-hoc bundled rendering, never a managed spread —
    // but the local name (and so headers.json) still applies.
    expect(session.profile).toMatchObject({ source: 'url', urlOverride: true })
    expect(Object.keys(session.profile.renderings)).toEqual([LATEST])
    expect(onlyProfileUrl(session)).toBe('https://agent.example.com/custom.json')
    expect(session.profile.name).toBe('legacy07')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`bundled UCP ${LATEST} body`)
  })
})

describe('resolveSession — precedence (flag > env > active.yaml > managed)', () => {
  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-session-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('--profile flag wins over UCP_PROFILE env', async () => {
    await seedUserProfile(homeDir, 'flag-wins')
    const session = await resolveSession({
      homeDir,
      env: { UCP_PROFILE: 'env-loses' },
      profile: 'flag-wins',
    })
    expect(session.profile.name).toBe('flag-wins')
  })

  it('UCP_PROFILE env wins over active.yaml profile', async () => {
    await seedUserProfile(homeDir, 'env-wins')
    await writeActive({ profile: 'active-loses' }, { homeDir })
    const session = await resolveSession({ homeDir, env: { UCP_PROFILE: 'env-wins' } })
    expect(session.profile.name).toBe('env-wins')
  })

  it('active.yaml profile wins when no flag/env set', async () => {
    await seedUserProfile(homeDir, 'from-active')
    await writeActive({ profile: 'from-active' }, { homeDir })
    const session = await resolveSession({ homeDir, env: {} })
    expect(session.profile.name).toBe('from-active')
  })
})

describe('resolveSession — business precedence', () => {
  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-session-test-'))
    await seedUserProfile(homeDir, 'prod')
    await writeActive({ profile: 'prod' }, { homeDir })
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('--business flag wins over UCP_BUSINESS env', async () => {
    const session = await resolveSession({
      homeDir,
      env: { UCP_BUSINESS: 'https://env.example.com' },
      business: 'https://flag.example.com',
    })
    expect(session.business).toBe('https://flag.example.com')
    expect(session.businessSource).toBe('flag')
  })

  it('UCP_BUSINESS env wins over active.yaml business', async () => {
    await writeActive({ profile: 'prod', business: 'https://active.example.com' }, { homeDir })
    const session = await resolveSession({
      homeDir,
      env: { UCP_BUSINESS: 'https://env.example.com' },
    })
    expect(session.business).toBe('https://env.example.com')
    expect(session.businessSource).toBe('env')
  })

  it('active.yaml business wins when no flag/env set', async () => {
    await writeActive({ profile: 'prod', business: 'https://active.example.com' }, { homeDir })
    const session = await resolveSession({ homeDir, env: {} })
    expect(session.business).toBe('https://active.example.com')
    expect(session.businessSource).toBe('active.yaml')
  })

  it('treats empty-string active.yaml.business as unset', async () => {
    await writeActive({ profile: 'prod', business: '' }, { homeDir })
    const session = await resolveSession({ homeDir, env: {} })
    expect(session.business).toBeUndefined()
    expect(session.businessSource).toBeUndefined()
  })

  it('MCP mode drops the active.yaml leg but keeps flag and env', async () => {
    // `ucp --mcp` is one process for many unrelated conversations; the file is
    // per-user state that none of them chose. Flags and env vars arrive with
    // the invocation, so they stay authoritative.
    await writeActive({ profile: 'prod', business: 'https://active.example.com' }, { homeDir })

    const ignored = await resolveSession({ homeDir, env: {}, inMcpMode: true, profile: 'prod' })
    expect(ignored.business).toBeUndefined()
    expect(ignored.businessSource).toBeUndefined()

    const fromEnv = await resolveSession({
      homeDir,
      env: { UCP_PROFILE: 'prod', UCP_BUSINESS: 'https://env.example.com' },
      inMcpMode: true,
    })
    expect(fromEnv.profile.name).toBe('prod')
    expect(fromEnv.business).toBe('https://env.example.com')
    expect(fromEnv.businessSource).toBe('env')

    const fromFlag = await resolveSession({
      homeDir,
      env: {},
      inMcpMode: true,
      profile: 'prod',
      business: 'https://flag.example.com',
    })
    expect(fromFlag.business).toBe('https://flag.example.com')
    expect(fromFlag.businessSource).toBe('flag')
  })

  it('MCP mode ignores the active profile and defaults to managed', async () => {
    await writeActive({ profile: 'prod', business: 'https://active.example.com' }, { homeDir })
    const session = await resolveSession({ homeDir, env: {}, inMcpMode: true })

    expect(session.profile.source).toBe('managed')
    expect(session.profile.name).toBeUndefined()
    expect(session.business).toBeUndefined()
  })

  it('treats empty-string flag/env as unset (falls through precedence)', async () => {
    // Real-world: shell exports `UCP_BUSINESS=""` to disable, expects active.yaml
    // to take over. Earlier code coalesced empty strings only at the read site,
    // not the source attribution; pin the new behavior.
    await writeActive({ profile: 'prod', business: 'https://active.example.com' }, { homeDir })
    const session = await resolveSession({
      homeDir,
      env: { UCP_BUSINESS: '' },
      business: '',
    })
    expect(session.business).toBe('https://active.example.com')
    expect(session.businessSource).toBe('active.yaml')
  })
})
