// resolveSession tests.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlatformProfile } from '../core/profile.js'
import { saveUserProfile, writeActive } from '../core/profile-store.js'
import { resolveSession } from './session.js'

const SAMPLE_BODY: PlatformProfile = {
  ucp: {
    version: '2026-04-08',
    status: 'success',
    services: {},
    payment_handlers: {},
  },
  // signing_keys is the published JWK material a counterparty would use to
  // verify signatures. We carry one so fixtures look realistic, but v0.1 does
  // not exercise signing — see session.ts header.
  signing_keys: [
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
  protocol_versions: { min: '2026-01-11', max: '2026-04-08' },
}

async function seedUserProfile(homeDir: string, name = 'prod'): Promise<void> {
  await saveUserProfile({ name, body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
}

describe('resolveSession — profile required branch', () => {
  let homeDir: string
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-session-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('throws PROFILE_NOT_FOUND with CTA when no profile is selected', async () => {
    await expect(resolveSession({ homeDir, env: {} })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
      layer: 'client',
      cta: expect.objectContaining({
        commands: expect.arrayContaining([
          expect.objectContaining({ command: 'ucp profile init --name agent' }),
        ]),
      }),
    })
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
    expect(session.profile.name).toBe('prod')
    expect(session.profile.profileUrl).toBe('https://mybot.example.com/.well-known/ucp')
  })

  it('throws PROFILE_NOT_FOUND when the named profile is not on disk', async () => {
    await expect(resolveSession({ homeDir, env: {}, profile: 'ghost' })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
      layer: 'client',
    })
  })

  it('temporarily falls back to DEFAULT_PROFILE_URL when meta.profile_url is absent', async () => {
    // TODO(profile-upload): this fallback disappears once managed upload returns
    // per-profile URLs. It keeps local managed profiles usable while the upload
    // seam is a no-op.
    await saveUserProfile(
      {
        name: 'managed-local',
        body: SAMPLE_BODY,
        meta: { ...SAMPLE_META, profile_url: undefined },
      },
      { homeDir },
    )
    const session = await resolveSession({ homeDir, env: {}, profile: 'managed-local' })
    expect(session.profile.name).toBe('managed-local')
    expect(session.profile.profileUrl).toMatch(/^https:\/\/[\w.-]+\/.+\.json/)
  })

  it('--profile-url override fills in for a local profile without profile_url', async () => {
    await saveUserProfile(
      {
        name: 'deferred',
        body: SAMPLE_BODY,
        meta: { ...SAMPLE_META, profile_url: undefined },
      },
      { homeDir },
    )
    const session = await resolveSession({
      homeDir,
      env: {},
      profile: 'deferred',
      profileUrl: 'https://mybot.example.com/profile.json',
    })
    expect(session.profile.profileUrl).toBe('https://mybot.example.com/profile.json')
  })

  it('UCP_AGENT_PROFILE_URL fills in for a local profile without profile_url', async () => {
    await saveUserProfile(
      {
        name: 'deferred',
        body: SAMPLE_BODY,
        meta: { ...SAMPLE_META, profile_url: undefined },
      },
      { homeDir },
    )
    const session = await resolveSession({
      homeDir,
      env: { UCP_AGENT_PROFILE_URL: 'https://env.example.com/profile.json' },
      profile: 'deferred',
    })
    expect(session.profile.profileUrl).toBe('https://env.example.com/profile.json')
  })

  it('passes user profile meta through to ResolvedSession', async () => {
    // The catalog-op handler needs `profile.meta.defaults.catalog` after a
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
    expect(session.profile.meta?.defaults?.catalog).toBe('https://custom-catalog.example.com')
    expect(session.profile.meta?.created_at).toBe(SAMPLE_META.created_at)
  })

  it('falls back to the baked-in default catalog when profile + env are unset', async () => {
    await seedUserProfile(homeDir, 'no-defaults')
    const session = await resolveSession({ homeDir, env: {}, profile: 'no-defaults' })
    expect(session.profile.meta).toBeDefined()
    expect(session.profile.meta?.defaults?.catalog).toBe('https://catalog.shopify.com')
  })

  it('UCP_DEFAULT_CATALOG overrides the baked-in default but loses to the profile value', async () => {
    await seedUserProfile(homeDir, 'env-override')
    const envOnly = await resolveSession({
      homeDir,
      env: { UCP_DEFAULT_CATALOG: 'https://staging-catalog.example.com' },
      profile: 'env-override',
    })
    expect(envOnly.profile.meta?.defaults?.catalog).toBe('https://staging-catalog.example.com')

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
    expect(profileWins.profile.meta?.defaults?.catalog).toBe('https://from-profile.example.com')
  })
})

describe('resolveSession — precedence (flag > env > active.yaml > required profile)', () => {
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
