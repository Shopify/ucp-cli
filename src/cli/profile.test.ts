// Profile CLI command-tree tests.
//
// Pins the local profile UX: small command surface, HTTPS-only explicit
// profile URLs, and default catalog inheritance. There is no upload verb —
// ucp-cli never writes to a profile URL, so hosting is entirely the user's.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createUcpCli } from '../cli.js'
import { PROFILE_FORMAT_VERSION } from '../core/legacy-profile.js'
import type { PlatformProfile } from '../core/profile.js'
import {
  listProfiles as listStoredProfiles,
  type ProfileMeta,
  readActive as readStoredActive,
  readUserProfile as readStoredUserProfile,
  profileExists as storedProfileExists,
  writeActive as writeStoredActive,
} from '../core/profile-store.js'
import { LATEST, RELEASES, SUPPORTED_VERSIONS, type Version } from '../core/releases.js'
import { setWarnWriter } from '../core/verbose.js'
import {
  captureSaves,
  captureWrites,
  defaultProfileDeps,
  serveCli,
  userProfile,
} from '../test-utils.js'
import type { ProfileCliDependencies } from './profile.js'

const META: ProfileMeta = {
  created_at: '2026-05-01T00:00:00.000Z',
  defaults: { catalog: 'https://catalog.shopify.com/api/ucp/mcp' },
  profile_url: 'https://example.com/.well-known/ucp',
  format_version: PROFILE_FORMAT_VERSION,
  kind: 'diy',
}

const MANAGED_RENDERINGS = SUPPORTED_VERSIONS.map((version) => ({
  version,
  profile_url: RELEASES[version].defaultAgentProfileUrl,
}))

function profileBody(version: Version = LATEST): PlatformProfile {
  return JSON.parse(RELEASES[version].agentProfileJson) as PlatformProfile
}

function internallyInconsistentDiyBody(): PlatformProfile {
  const body = profileBody()
  body.ucp.services = {
    'dev.ucp.shopping': [
      { version: LATEST, transport: 'mcp' },
      { version: '2026-04-08', transport: 'mcp' },
    ],
  }
  return body
}

function makeCli(overrides: Partial<ProfileCliDependencies> = {}) {
  return createUcpCli({ profile: { ...defaultProfileDeps(), ...overrides } })
}

function makeStoredCli(homeDir: string) {
  return makeCli({
    listProfiles: () => listStoredProfiles({ homeDir }),
    profileExists: (name) => storedProfileExists(name, { homeDir }),
    readUserProfile: (name, options = {}) => readStoredUserProfile(name, { ...options, homeDir }),
    readActive: () => readStoredActive({ homeDir }),
    writeActive: (active) => writeStoredActive(active, { homeDir }),
  })
}

const temporaryHomes = new Set<string>()

async function seedManagedAlias(bodyBytes?: string) {
  const homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-profile-managed-test-'))
  temporaryHomes.add(homeDir)
  const name = 'legacy'
  const dir = join(homeDir, 'profiles', name)
  const bodyPath = join(dir, 'profile.json')
  const meta = {
    created_at: '2026-06-01T10:00:00.000Z',
    format_version: PROFILE_FORMAT_VERSION,
    kind: 'managed' as const,
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
  if (bodyBytes !== undefined) await writeFile(bodyPath, bodyBytes, 'utf-8')
  return { homeDir, name, bodyPath, meta }
}

afterEach(async () => {
  setWarnWriter(null)
  await Promise.all([...temporaryHomes].map((homeDir) => rm(homeDir, { recursive: true })))
  temporaryHomes.clear()
})

describe('ucp profile list', () => {
  it('shows the virtual managed Profile as active on a fresh install', async () => {
    const { output, exitCode } = await serveCli(makeCli(), ['profile', 'list'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({
      profiles: [
        {
          kind: 'managed',
          label: 'Shopify managed',
          active: true,
          renderings: MANAGED_RENDERINGS,
        },
      ],
    })
  })

  it('marks non-empty UCP_PROFILE instead of active.yaml', async () => {
    const cli = makeCli({
      env: { UCP_PROFILE: 'from-env' },
      listProfiles: async () => ['from-active', 'from-env'],
      readActive: async () => ({ profile: 'from-active' }),
      readUserProfile: async (name) => userProfile(name, { meta: META, kind: 'diy' }),
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'list'])
    expect(exitCode).toBe(0)
    const profiles = JSON.parse(output).profiles as Array<{
      name?: string
      kind: string
      active: boolean
    }>
    expect(
      profiles.find((profile) => profile.kind === 'managed' && profile.name === undefined),
    ).toMatchObject({ active: false })
    expect(profiles.find((profile) => profile.name === 'from-active')).toMatchObject({
      active: false,
    })
    expect(profiles.find((profile) => profile.name === 'from-env')).toMatchObject({ active: true })
  })

  it('shows every managed rendering and a singleton pinned DIY rendering', async () => {
    const cli = makeCli({
      listProfiles: async () => ['legacy', 'pinned'],
      readActive: async () => ({ profile: 'legacy' }),
      readUserProfile: async (name) => {
        if (name === 'legacy') {
          return userProfile(name, {
            body: profileBody('2026-04-08'),
            meta: { ...META, kind: 'managed' },
            kind: 'managed',
          })
        }
        return userProfile(name, {
          body: profileBody('2026-04-08'),
          meta: {
            ...META,
            profile_url: 'https://agent.example.com/pinned.json',
            kind: 'diy',
          },
          kind: 'diy',
        })
      },
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'list'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({
      profiles: [
        {
          kind: 'managed',
          label: 'Shopify managed',
          active: false,
          renderings: MANAGED_RENDERINGS,
        },
        {
          name: 'legacy',
          kind: 'managed',
          active: true,
          renderings: MANAGED_RENDERINGS,
        },
        {
          name: 'pinned',
          kind: 'diy',
          active: false,
          renderings: [
            {
              version: '2026-04-08',
              profile_url: 'https://agent.example.com/pinned.json',
            },
          ],
        },
      ],
    })
  })

  it('shows and warns about the effective unknown URL on the active managed-alias row only', async () => {
    const warnings: string[] = []
    setWarnWriter((message) => warnings.push(message))
    const overrideUrl = 'https://override.example/profile.json'
    const cli = makeCli({
      env: { UCP_AGENT_PROFILE_URL: overrideUrl },
      listProfiles: async () => ['legacy', 'other'],
      readActive: async () => ({ profile: 'legacy' }),
      readUserProfile: async (name) =>
        name === 'legacy'
          ? userProfile(name, {
              body: profileBody('2026-04-08'),
              meta: { ...META, kind: 'managed' },
              kind: 'managed',
            })
          : userProfile(name, {
              body: profileBody('2026-04-08'),
              meta: META,
              kind: 'diy',
            }),
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'list'])
    expect(exitCode).toBe(0)
    const profiles = JSON.parse(output).profiles as Array<Record<string, unknown>>
    expect(profiles.find((profile) => profile.name === 'legacy')).toMatchObject({
      kind: 'managed',
      active: true,
      renderings: [{ version: LATEST, profile_url: overrideUrl }],
      overridden_by: ['UCP_AGENT_PROFILE_URL'],
    })
    expect(profiles.find((profile) => profile.name === 'other')).toMatchObject({
      active: false,
      renderings: [{ version: '2026-04-08', profile_url: META.profile_url }],
    })
    expect(profiles.find((profile) => profile.name === 'other')).not.toHaveProperty('overridden_by')
    expect(profiles[0]).toMatchObject({ active: false, renderings: MANAGED_RENDERINGS })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`bundled UCP ${LATEST} body`)
  })

  it('migrates only the effective active local Profile while scanning inactive rows read-only', async () => {
    const reads: Array<{ name: string; migrate: boolean | undefined }> = []
    const cli = makeCli({
      env: { UCP_PROFILE: 'active' },
      listProfiles: async () => ['active', 'inactive'],
      readUserProfile: async (name, options = {}) => {
        reads.push({ name, migrate: options.migrate })
        return userProfile(name, { meta: META, kind: 'diy' })
      },
    })

    const { exitCode } = await serveCli(cli, ['profile', 'list'])

    expect(exitCode).toBe(0)
    expect(reads).toEqual([
      { name: 'active', migrate: undefined },
      { name: 'inactive', migrate: false },
    ])
  })

  it('marks an active DIY Profile invalid when runtime materialization rejects its body', async () => {
    const cli = makeCli({
      env: { UCP_PROFILE: 'broken' },
      listProfiles: async () => ['broken'],
      readUserProfile: async (name) =>
        userProfile(name, { body: internallyInconsistentDiyBody(), meta: META, kind: 'diy' }),
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'list'])

    expect(exitCode).toBe(0)
    expect(JSON.parse(output).profiles).toContainEqual({
      name: 'broken',
      kind: 'invalid',
      active: true,
    })
  })

  it('keeps unreadable local Profiles visible as invalid rows', async () => {
    const cli = makeCli({
      listProfiles: async () => ['broken', 'good'],
      readUserProfile: async (name) => {
        if (name === 'broken') throw new Error('bad profile.json')
        return userProfile(name, { meta: META, kind: 'diy' })
      },
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'list'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output).profiles).toContainEqual({
      name: 'broken',
      kind: 'invalid',
      active: false,
    })
  })
})

describe('ucp profile commands — marked managed aliases', () => {
  it.each([
    { state: 'missing', bodyBytes: undefined },
    { state: 'corrupt', bodyBytes: '<not historical json>\n' },
  ])('lists, shows, and uses an alias with $state profile.json', async ({ bodyBytes }) => {
    const { homeDir, name, bodyPath, meta } = await seedManagedAlias(bodyBytes)

    const listed = await serveCli(makeStoredCli(homeDir), ['profile', 'list'])
    expect(listed.exitCode).toBe(0)
    expect(JSON.parse(listed.output).profiles).toContainEqual({
      name,
      kind: 'managed',
      active: false,
      renderings: MANAGED_RENDERINGS,
    })

    const shown = await serveCli(makeStoredCli(homeDir), ['profile', 'show', name])
    expect(shown.exitCode).toBe(0)
    expect(JSON.parse(shown.output)).toEqual({
      name,
      kind: 'managed',
      active: false,
      renderings: MANAGED_RENDERINGS,
      meta,
    })

    const used = await serveCli(makeStoredCli(homeDir), ['profile', 'use', name])
    expect(used.exitCode).toBe(0)
    expect(JSON.parse(used.output)).toEqual({ profile: name, previous: null })
    expect(await readStoredActive({ homeDir })).toEqual({ profile: name })

    if (bodyBytes === undefined) {
      await expect(readFile(bodyPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(await readFile(bodyPath, 'utf-8')).toBe(bodyBytes)
    }
  })
})

describe('ucp profile show', () => {
  it('returns the virtual managed descriptor when no local Profile is active', async () => {
    const { output, exitCode } = await serveCli(makeCli(), ['profile', 'show'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({
      kind: 'managed',
      label: 'Shopify managed',
      active: true,
      renderings: MANAGED_RENDERINGS,
    })
  })

  it.each([
    {
      label: 'known release-default',
      url: RELEASES['2026-04-08'].defaultAgentProfileUrl,
      version: '2026-04-08' as const,
      warns: false,
    },
    {
      label: 'unknown URL',
      url: 'https://override.example/profile.json',
      version: LATEST,
      warns: true,
    },
  ])(
    'pins effective managed show to one bundled rendering for a $label',
    async ({ url, version, warns }) => {
      const warnings: string[] = []
      setWarnWriter((message) => warnings.push(message))
      const cli = makeCli({ env: { UCP_AGENT_PROFILE_URL: url } })

      const { output, exitCode } = await serveCli(cli, ['profile', 'show'])

      expect(exitCode).toBe(0)
      expect(JSON.parse(output)).toEqual({
        kind: 'managed',
        label: 'Shopify managed',
        active: true,
        renderings: [{ version, profile_url: url }],
        overridden_by: ['UCP_AGENT_PROFILE_URL'],
      })
      expect(warnings).toHaveLength(warns ? 1 : 0)
      if (warns) expect(warnings[0]).toContain(`bundled UCP ${LATEST} body`)
    },
  )

  it('returns a named DIY Profile with its one pinned rendering, body, and meta', async () => {
    const body = profileBody('2026-04-08')
    const cli = makeCli({
      readUserProfile: async (name) => userProfile(name, { body, meta: META, kind: 'diy' }),
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'show', 'alpha'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({
      name: 'alpha',
      kind: 'diy',
      active: false,
      renderings: [
        {
          version: '2026-04-08',
          profile_url: META.profile_url,
        },
      ],
      body,
      meta: META,
    })
  })

  it('shows a named managed Profile with all renderings and meta, not its stale body', async () => {
    const legacyMeta: ProfileMeta = {
      ...META,
      profile_url: RELEASES['2026-04-08'].defaultAgentProfileUrl,
      kind: 'managed',
      legacy_note: 'preserved',
    }
    const cli = makeCli({
      readActive: async () => ({ profile: 'legacy' }),
      readUserProfile: async (name) =>
        userProfile(name, {
          body: profileBody('2026-04-08'),
          meta: legacyMeta,
          kind: 'managed',
        }),
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'show'])
    const shown = JSON.parse(output)
    expect(exitCode).toBe(0)
    expect(shown).toEqual({
      name: 'legacy',
      kind: 'managed',
      active: true,
      renderings: MANAGED_RENDERINGS,
      meta: legacyMeta,
    })
    expect(shown).not.toHaveProperty('body')
  })

  it('applies an effective URL override to a named DIY rendering without replacing its body or meta', async () => {
    const body = profileBody('2026-04-08')
    const meta = Object.freeze({ ...META })
    const overrideUrl = 'https://override.example/profile.json'
    const cli = makeCli({
      env: { UCP_AGENT_PROFILE_URL: overrideUrl },
      readActive: async () => ({ profile: 'alpha' }),
      readUserProfile: async (name) => userProfile(name, { body, meta, kind: 'diy' }),
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'show'])
    const shown = JSON.parse(output)

    expect(exitCode).toBe(0)
    expect(shown).toMatchObject({
      name: 'alpha',
      kind: 'diy',
      active: true,
      renderings: [{ version: '2026-04-08', profile_url: overrideUrl }],
      overridden_by: ['UCP_AGENT_PROFILE_URL'],
      body,
      meta: META,
    })
    expect(meta.profile_url).toBe(META.profile_url)
  })

  it('falls back to the active named Profile when name is omitted', async () => {
    const reads: string[] = []
    const cli = makeCli({
      readActive: async () => ({ profile: 'live' }),
      readUserProfile: async (name) => {
        reads.push(name)
        return userProfile(name, { meta: META, kind: 'diy' })
      },
    })
    const { output } = await serveCli(cli, ['profile', 'show'])
    expect(reads).toEqual(['live'])
    expect(JSON.parse(output)).toMatchObject({ name: 'live', kind: 'diy', active: true })
  })

  it('uses non-empty UCP_PROFILE before active.yaml when no name is passed', async () => {
    const reads: string[] = []
    const cli = makeCli({
      env: { UCP_PROFILE: 'from-env' },
      readActive: async () => ({ profile: 'from-active' }),
      readUserProfile: async (name) => {
        reads.push(name)
        return userProfile(name, { meta: META, kind: 'diy' })
      },
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'show'])
    expect(exitCode).toBe(0)
    expect(reads).toEqual(['from-env'])
    expect(JSON.parse(output)).toMatchObject({ name: 'from-env', active: true })
  })

  it('applies the effective URL override when the active DIY name is explicit', async () => {
    const reads: string[] = []
    const overrideUrl = 'https://override.example/profile.json'
    const cli = makeCli({
      env: {
        UCP_PROFILE: 'requested',
        UCP_AGENT_PROFILE_URL: overrideUrl,
      },
      readActive: async () => ({ profile: 'from-active' }),
      readUserProfile: async (name) => {
        reads.push(name)
        return userProfile(name, { meta: META, kind: 'diy' })
      },
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'show', 'requested'])
    expect(exitCode).toBe(0)
    expect(reads).toEqual(['requested'])
    expect(JSON.parse(output)).toMatchObject({
      name: 'requested',
      active: true,
      renderings: [{ profile_url: overrideUrl }],
      overridden_by: ['UCP_AGENT_PROFILE_URL'],
    })
  })

  it('applies the effective URL override when the active managed-alias name is explicit', async () => {
    const overrideUrl = RELEASES['2026-04-08'].defaultAgentProfileUrl
    const managedMeta: ProfileMeta = { ...META, kind: 'managed' }
    const cli = makeCli({
      env: {
        UCP_PROFILE: 'legacy',
        UCP_AGENT_PROFILE_URL: overrideUrl,
      },
      readUserProfile: async (name) => userProfile(name, { meta: managedMeta, kind: 'managed' }),
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'show', 'legacy'])

    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({
      name: 'legacy',
      kind: 'managed',
      active: true,
      renderings: [{ version: '2026-04-08', profile_url: overrideUrl }],
      overridden_by: ['UCP_AGENT_PROFILE_URL'],
      meta: managedMeta,
    })
  })

  it('canonicalizes a stored DIY rendering URL without changing inspected metadata', async () => {
    const rawProfileUrl = 'https://EXAMPLE.com:443/.well-known/ucp'
    const meta: ProfileMeta = { ...META, profile_url: rawProfileUrl }
    const cli = makeCli({
      readUserProfile: async (name) => userProfile(name, { meta, kind: 'diy' }),
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'show', 'other'])

    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toMatchObject({
      renderings: [{ profile_url: 'https://example.com/.well-known/ucp' }],
      meta: { profile_url: rawProfileUrl },
    })
  })

  it('keeps explicit foreign-name inspection on the stored DIY descriptor', async () => {
    const cli = makeCli({
      env: {
        UCP_PROFILE: 'active',
        UCP_AGENT_PROFILE_URL: 'https://override.example/profile.json',
      },
      readUserProfile: async (name) => userProfile(name, { meta: META, kind: 'diy' }),
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'show', 'other'])
    const shown = JSON.parse(output)

    expect(exitCode).toBe(0)
    expect(shown).toMatchObject({
      name: 'other',
      active: false,
      renderings: [{ profile_url: META.profile_url }],
    })
    expect(shown).not.toHaveProperty('overridden_by')
  })

  it('keeps explicit DIY inspection available when runtime snapshot validation would fail', async () => {
    const body = internallyInconsistentDiyBody()
    const cli = makeCli({
      readUserProfile: async (name) => userProfile(name, { body, meta: META, kind: 'diy' }),
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'show', 'broken'])

    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ name: 'broken', kind: 'diy', body })
  })
})

describe('ucp profile init', () => {
  it('errors with a CTA when non-interactive name is omitted', async () => {
    const cli = makeCli({
      saveUserProfile: async () => {
        throw new Error('should not be called')
      },
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'init'])
    expect(exitCode).toBe(1)
    expect(output).toMatch(/PROFILE_INIT_REQUIRES_NAME/)
    expect(output).toMatch(/normal users do not need to initialize/i)
    expect(output).toMatch(/custom or release-pinned DIY Profile/i)
    expect(output).toMatch(/profile init --name agent/)
    expect(output).toMatch(/--profile-url https:\/\/example\.com\/\.well-known\/ucp/)
  })

  it('describes init as an opt-in DIY command', async () => {
    const { output, exitCode } = await serveCli(makeCli(), ['profile', 'init', '--help'])
    expect(exitCode).toBe(0)
    expect(output).toMatch(/DIY Profile pinned to one UCP release/i)
    expect(output).toMatch(/without this flag.*Shopify managed/i)
    expect(output).toMatch(/custom.*URL.*preserv/i)
    expect(output).toMatch(/release-default URL.*rotate/i)
    expect(output).not.toMatch(/first profile is activated automatically/i)
  })

  it('prompts in TTY mode when name is omitted', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      canPrompt: true,
      promptInit: async () => ({
        name: 'prompted',
        profileUrl: 'https://p.example/.well-known/ucp',
      }),
      saveUserProfile,
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'init'])
    expect(exitCode).toBe(0)
    expect(saves[0]).toMatchObject({
      name: 'prompted',
      meta: {
        profile_url: 'https://p.example/.well-known/ucp',
        format_version: PROFILE_FORMAT_VERSION,
        kind: 'diy',
      },
    })
    expect(JSON.parse(output)).toMatchObject({ name: 'prompted', activated: false })
  })

  it('creates and marks a DIY Profile when --profile-url is provided', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({ saveUserProfile, writeActive })
    const { output, exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--profile-url',
      'https://example.com/.well-known/ucp',
    ])
    expect(exitCode).toBe(0)
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({
      name: 'fresh',
      meta: {
        profile_url: 'https://example.com/.well-known/ucp',
        format_version: PROFILE_FORMAT_VERSION,
        kind: 'diy',
      },
      overwrite: false,
    })
    expect(writes).toEqual([])
    expect(JSON.parse(output)).toMatchObject({ name: 'fresh', activated: false })
  })

  it('does not auto-activate the first local Profile', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      listProfiles: async () => [],
      writeActive,
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'init', '--name', 'first'])
    expect(exitCode).toBe(0)
    expect(writes).toEqual([])
    expect(JSON.parse(output)).toMatchObject({ name: 'first', activated: false })
  })

  it('activates only when --activate is explicit and preserves other session state', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      readActive: async () => ({ business: 'https://shop.example.com' }),
      writeActive,
    })
    const { output, exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--activate',
    ])

    expect(exitCode).toBe(0)
    expect(writes).toEqual([{ business: 'https://shop.example.com', profile: 'fresh' }])
    expect(JSON.parse(output)).toMatchObject({ name: 'fresh', activated: true })
  })

  it('does not blame an equal UCP_PROFILE while independently warning on the URL override', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      env: {
        UCP_PROFILE: 'fresh',
        UCP_AGENT_PROFILE_URL: 'https://override.example/profile.json',
      },
      writeActive,
    })

    const { output, exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--activate',
    ])

    expect(exitCode).toBe(0)
    expect(writes).toEqual([{ profile: 'fresh' }])
    expect(JSON.parse(output)).toMatchObject({
      name: 'fresh',
      created: true,
      activated: true,
      overridden_by: ['UCP_AGENT_PROFILE_URL'],
      message: expect.stringMatching(/stored identity.*UCP_AGENT_PROFILE_URL/i),
    })
    expect(output).not.toContain('UCP_PROFILE')
  })

  it('persists catalog only when --catalog is explicit', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({ saveUserProfile })
    const { exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--catalog',
      'https://catalog.example.com/mcp',
    ])
    expect(exitCode).toBe(0)
    expect(saves[0]).toMatchObject({
      meta: { defaults: { catalog: 'https://catalog.example.com/mcp' } },
    })
  })

  it('rejects positional profile names; use --name for agent-stable grammar', async () => {
    const cli = makeCli({
      saveUserProfile: async () => {
        throw new Error('should not be called')
      },
    })
    const { exitCode, output } = await serveCli(cli, ['profile', 'init', 'fresh'])
    expect(exitCode).toBe(1)
    expect(output).toMatch(/unexpected|argument|name/i)
  })

  it('writes the release default URL when no --profile-url is given', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({ saveUserProfile })
    const { output, exitCode } = await serveCli(cli, ['profile', 'init', '--name', 'fresh'])
    expect(exitCode).toBe(0)
    // `profile_url` is always written so the remote identity is explicit on
    // disk where `doctor` and the user can inspect it.
    expect(saves[0]?.meta).toMatchObject({
      profile_url: RELEASES[LATEST].defaultAgentProfileUrl,
      format_version: PROFILE_FORMAT_VERSION,
      kind: 'diy',
    })
    expect(JSON.parse(output)).toMatchObject({ name: 'fresh', activated: false })
  })

  // ── --version ─────────────────────────────────────────────────
  //
  // `--version` selects the release template written to profile.json and the
  // matching published URL used when --profile-url is omitted.

  it('defaults to LATEST: writes that release’s snapshot and its published URL', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({ saveUserProfile })
    const { output, exitCode } = await serveCli(cli, ['profile', 'init', '--name', 'fresh'])

    expect(exitCode).toBe(0)
    expect(saves[0]?.meta.profile_url).toBe(RELEASES[LATEST].defaultAgentProfileUrl)
    // profile.json is the VERBATIM published document, not a hand-written
    // template: byte-identity with what the URL serves is what makes
    // `ucp doctor`'s drift diff mean something.
    expect(saves[0]?.body).toStrictEqual(JSON.parse(RELEASES[LATEST].agentProfileJson))
    expect(JSON.parse(output)).toMatchObject({ name: 'fresh', version: LATEST })
  })

  it('--version 2026-04-08 selects that release’s URL and snapshot', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({ saveUserProfile })
    const { output, exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'agent-0408',
      '--version',
      '2026-04-08',
    ])

    expect(exitCode).toBe(0)
    expect(saves[0]?.meta.profile_url).toBe(RELEASES['2026-04-08'].defaultAgentProfileUrl)
    expect(saves[0]?.body).toStrictEqual(JSON.parse(RELEASES['2026-04-08'].agentProfileJson))
    expect(saves[0]?.body.ucp.version).toBe('2026-04-08')
    expect(JSON.parse(output)).toMatchObject({ version: '2026-04-08' })
  })

  it('rejects an unsupported --version and lists the supported set', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({ saveUserProfile })
    // 2026-01-23 is a REAL spec release the CLI cannot speak (its MCP binding
    // was never published). A well-formed date is exactly as unusable here as
    // a typo.
    const { output, exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'old',
      '--version',
      '2026-01-23',
    ])

    expect(exitCode).toBe(1)
    for (const v of SUPPORTED_VERSIONS) expect(output).toContain(v)
    expect(saves).toHaveLength(0)
  })

  it('--profile-url uses the requested URL while --version selects the template', async () => {
    // A custom capability set needs a URL the user controls because there is
    // no signing: whoever controls the URL controls what businesses see.
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({ saveUserProfile })
    const { exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'mine',
      '--version',
      '2026-04-08',
      '--profile-url',
      'https://you.example/agent.json',
    ])

    expect(exitCode).toBe(0)
    expect(saves[0]?.meta.profile_url).toBe('https://you.example/agent.json')
    expect(saves[0]?.body).toStrictEqual(JSON.parse(RELEASES['2026-04-08'].agentProfileJson))
  })

  it('rejects --protocol-min / --protocol-max', async () => {
    const cli = makeCli({
      saveUserProfile: async () => {
        throw new Error('should not be called')
      },
    })
    const { exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--protocol-min',
      '2026-01-23',
    ])
    expect(exitCode).toBe(1)
  })

  // `meta` is built and written directly from explicit init inputs.
  it('writes only the fields init derives; no hosting metadata is invented', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({ saveUserProfile })
    const { exitCode } = await serveCli(cli, ['profile', 'init', '--name', 'fresh'])
    expect(exitCode).toBe(0)
    expect(Object.keys(saves[0]?.meta ?? {}).sort()).toEqual([
      'created_at',
      'format_version',
      'kind',
      'profile_url',
      'updated_at',
    ])
  })

  it('returns a total no-op when the profile already exists and --activate is absent', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async () => {
        throw new Error('existing Profile must not be read')
      },
      readActive: async () => {
        throw new Error('active.yaml must not be read')
      },
      writeActive: async () => {
        throw new Error('active.yaml must not be written')
      },
      saveUserProfile,
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'init', '--name', 'fresh'])
    expect(exitCode).toBe(0)
    expect(saves).toEqual([])
    expect(JSON.parse(output)).toEqual({
      name: 'fresh',
      created: false,
      activated: false,
      message: 'profile already exists; no changes made',
    })
  })

  it('validates and activates an existing Profile with --activate without re-creating it', async () => {
    const events: string[] = []
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async (name) => {
        events.push(`read:${name}`)
        return userProfile(name, { meta: META, kind: 'diy' })
      },
      readActive: async () => ({
        profile: 'old',
        business: 'https://shop.example.com',
        future_state: 'preserved',
      }),
      writeActive: async (session) => {
        events.push(`write:${JSON.stringify(session)}`)
      },
      saveUserProfile,
    })

    const { output, exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--activate',
    ])
    expect(exitCode).toBe(0)
    expect(saves).toEqual([])
    expect(events).toEqual([
      'read:fresh',
      'write:{"profile":"fresh","business":"https://shop.example.com","future_state":"preserved"}',
    ])
    expect(JSON.parse(output)).toEqual({
      name: 'fresh',
      created: false,
      activated: true,
      message: 'profile already exists; activated without re-creating it',
    })
  })

  it('returns the profile-use override warning when existing init --activate is ineffective', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      env: {
        UCP_PROFILE: 'from-env',
        UCP_AGENT_PROFILE_URL: 'https://override.example/profile.json',
      },
      profileExists: async () => true,
      readUserProfile: async (name) => userProfile(name, { meta: META, kind: 'diy' }),
      readActive: async () => ({ profile: 'old' }),
      writeActive,
    })

    const { output, exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--activate',
    ])

    expect(exitCode).toBe(0)
    expect(writes).toEqual([{ profile: 'fresh' }])
    expect(JSON.parse(output)).toEqual({
      name: 'fresh',
      created: false,
      activated: true,
      overridden_by: ['UCP_PROFILE', 'UCP_AGENT_PROFILE_URL'],
      message:
        'active.yaml now selects local Profile "fresh", but UCP_PROFILE selects the effective name and UCP_AGENT_PROFILE_URL overrides its stored identity rendering; unset both environment variables to use this selection and its stored descriptor',
    })
  })

  it('does not activate an unchanged DIY Profile that fails runtime snapshot validation', async () => {
    const { writes, writeActive } = captureWrites()
    const body = internallyInconsistentDiyBody()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async (name) => userProfile(name, { body, meta: META, kind: 'diy' }),
      writeActive,
    })

    const { output, exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'broken',
      '--activate',
    ])

    expect(exitCode).toBe(1)
    expect(output).toContain('AGENT_PROFILE_VERSION_MISMATCH')
    expect(writes).toEqual([])
  })

  it('does not activate an existing Profile that fails validation', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async () => {
        throw new Error('invalid existing Profile')
      },
      writeActive,
    })

    const { output, exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'broken',
      '--activate',
    ])
    expect(exitCode).toBe(1)
    expect(output).toMatch(/invalid existing Profile/)
    expect(writes).toEqual([])
  })

  it('rejects HTTP profile URLs', async () => {
    const cli = makeCli({
      saveUserProfile: async () => {
        throw new Error('should not be called')
      },
    })
    const { exitCode, output } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--profile-url',
      'http://example.com/.well-known/ucp',
    ])
    expect(exitCode).toBe(1)
    expect(output).toMatch(/https|profile-url/i)
  })

  it('preserves prior metadata and a custom profile_url on --force when --profile-url is omitted', async () => {
    const priorMeta: ProfileMeta = {
      created_at: '2026-01-15T08:00:00.000Z',
      updated_at: '2026-01-16T08:00:00.000Z',
      profile_url: 'https://old.example.com/profile.json',
      defaults: {
        catalog: 'https://old-catalog.example.com',
        cart: 'https://cart.example.com',
      },
      format_version: PROFILE_FORMAT_VERSION,
      kind: 'diy',
      profile_id: 'legacy-id',
    }
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async (name) =>
        userProfile(name, {
          body: profileBody('2026-04-08'),
          meta: priorMeta,
          kind: 'diy',
        }),
      saveUserProfile,
    })
    const { exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--version',
      '2026-04-08',
      '--catalog',
      'https://new-catalog.example.com',
      '--force',
    ])

    expect(exitCode).toBe(0)
    expect(saves[0]?.overwrite).toBe(true)
    expect(saves[0]?.meta).toEqual({
      ...priorMeta,
      updated_at: expect.any(String),
      profile_url: priorMeta.profile_url,
      defaults: {
        catalog: 'https://new-catalog.example.com',
        cart: 'https://cart.example.com',
      },
      format_version: PROFILE_FORMAT_VERSION,
      kind: 'diy',
    })
    expect(saves[0]?.meta.updated_at).not.toBe(priorMeta.updated_at)
  })

  it('salvages a valid custom URL and unknown metadata when profile.json needs force repair', async () => {
    const priorMeta: ProfileMeta = {
      ...META,
      profile_url: 'https://owned.example/profile.json',
      future_metadata: { keep: true },
    }
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async () => {
        throw new Error('profile.json failed schema validation')
      },
      readProfileMeta: async () => priorMeta,
      saveUserProfile,
    })

    const { exitCode } = await serveCli(cli, ['profile', 'init', '--name', 'broken', '--force'])
    expect(exitCode).toBe(0)
    expect(saves[0]?.meta.profile_url).toBe('https://owned.example/profile.json')
    expect(saves[0]?.meta.future_metadata).toEqual({ keep: true })
  })

  it('rotates a canonically equivalent Shopify release-default URL on --force', async () => {
    const releaseDefault = new URL(RELEASES['2026-04-08'].defaultAgentProfileUrl)
    const priorMeta: ProfileMeta = {
      ...META,
      profile_url: `https://${releaseDefault.hostname.toUpperCase()}:443${releaseDefault.pathname}`,
    }
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async (name) => userProfile(name, { meta: priorMeta, kind: 'diy' }),
      saveUserProfile,
    })

    const { exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--version',
      LATEST,
      '--force',
    ])
    expect(exitCode).toBe(0)
    expect(saves[0]?.meta.profile_url).toBe(RELEASES[LATEST].defaultAgentProfileUrl)
  })

  it('lets explicit --profile-url replace an existing custom URL on --force', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async (name) => userProfile(name, { meta: META, kind: 'diy' }),
      saveUserProfile,
    })

    const { exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--profile-url',
      'https://replacement.example/profile.json',
      '--force',
    ])
    expect(exitCode).toBe(0)
    expect(saves[0]?.meta.profile_url).toBe('https://replacement.example/profile.json')
  })

  it('preserves the complete defaults block on --force when --catalog is omitted', async () => {
    const priorMeta: ProfileMeta = {
      ...META,
      defaults: {
        catalog: 'https://existing-catalog.example.com',
        checkout: 'https://checkout.example.com',
      },
      future_metadata: { keep: true },
    }
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async (name) => userProfile(name, { meta: priorMeta, kind: 'diy' }),
      saveUserProfile,
    })

    const { exitCode } = await serveCli(cli, ['profile', 'init', '--name', 'fresh', '--force'])
    expect(exitCode).toBe(0)
    expect(saves[0]?.meta.defaults).toEqual(priorMeta.defaults)
    expect(saves[0]?.meta.future_metadata).toEqual({ keep: true })
  })
})

describe('ucp profile use', () => {
  it('migrates and validates a named Profile before writing active.yaml', async () => {
    const events: string[] = []
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async (name) => {
        events.push(`read:${name}`)
        return userProfile(name, { meta: META, kind: 'diy' })
      },
      readActive: async () => ({ profile: 'old' }),
      writeActive: async (session) => {
        events.push(`write:${session.profile}`)
      },
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'use', 'newp'])
    expect(exitCode).toBe(0)
    expect(events).toEqual(['read:newp', 'write:newp'])
    expect(JSON.parse(output)).toEqual({ profile: 'newp', previous: 'old' })
  })

  it('uses --managed by removing only active.yaml.profile', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      readActive: async () => ({
        profile: 'custom',
        business: 'https://shop.example.com',
        future_state: 'preserved',
      }),
      profileExists: async () => {
        throw new Error('should not inspect a local profile')
      },
      readUserProfile: async () => {
        throw new Error('should not read a local profile')
      },
      writeActive,
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'use', '--managed'])
    expect(exitCode).toBe(0)
    expect(writes).toEqual([{ business: 'https://shop.example.com', future_state: 'preserved' }])
    expect(JSON.parse(output)).toEqual({ profile: null, previous: 'custom' })
  })

  it('warns that env overrides keep --managed from becoming effective', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      env: {
        UCP_PROFILE: 'from-env',
        UCP_AGENT_PROFILE_URL: 'https://override.example/profile.json',
      },
      readActive: async () => ({ profile: 'custom' }),
      writeActive,
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'use', '--managed'])
    expect(exitCode).toBe(0)
    expect(writes).toEqual([{}])
    expect(JSON.parse(output)).toEqual({
      profile: null,
      previous: 'custom',
      overridden_by: ['UCP_PROFILE', 'UCP_AGENT_PROFILE_URL'],
      message:
        'active.yaml now selects the Shopify managed Profile, but it is not effective while UCP_PROFILE and UCP_AGENT_PROFILE_URL are set; unset those environment variables to use it',
    })
  })

  it('does not claim UCP_PROFILE blocks profile use when it already selects that name', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      env: { UCP_PROFILE: 'chosen' },
      profileExists: async () => true,
      readUserProfile: async (name) => userProfile(name, { meta: META, kind: 'diy' }),
      writeActive,
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'use', 'chosen'])

    expect(exitCode).toBe(0)
    expect(writes).toEqual([{ profile: 'chosen' }])
    expect(JSON.parse(output)).toEqual({ profile: 'chosen', previous: null })
    expect(output).not.toContain('overridden_by')
  })

  it('warns when UCP_PROFILE overrides profile use <name>', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      env: { UCP_PROFILE: 'from-env' },
      profileExists: async () => true,
      readUserProfile: async (name) => userProfile(name, { meta: META, kind: 'diy' }),
      writeActive,
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'use', 'chosen'])
    expect(exitCode).toBe(0)
    expect(writes).toEqual([{ profile: 'chosen' }])
    expect(JSON.parse(output)).toEqual({
      profile: 'chosen',
      previous: null,
      overridden_by: ['UCP_PROFILE'],
      message:
        'active.yaml now selects local Profile "chosen", but UCP_PROFILE takes precedence; unset it to use this selection.',
    })
  })

  it('warns when UCP_AGENT_PROFILE_URL overrides a selected Profile rendering', async () => {
    const cli = makeCli({
      env: { UCP_AGENT_PROFILE_URL: 'https://override.example/profile.json' },
      profileExists: async () => true,
      readUserProfile: async (name) => userProfile(name, { meta: META, kind: 'diy' }),
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'use', 'chosen'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toMatchObject({
      profile: 'chosen',
      overridden_by: ['UCP_AGENT_PROFILE_URL'],
      message: expect.stringMatching(/stored identity.*UCP_AGENT_PROFILE_URL/i),
    })
  })

  it('rejects a name together with --managed', async () => {
    const { output, exitCode } = await serveCli(makeCli(), [
      'profile',
      'use',
      'custom',
      '--managed',
    ])
    expect(exitCode).toBe(1)
    expect(output).toMatch(/INVALID_INPUT/)
    expect(output).toMatch(/either.*name.*--managed|not both/i)
  })

  it('requires either a name or --managed', async () => {
    const { output, exitCode } = await serveCli(makeCli(), ['profile', 'use'])
    expect(exitCode).toBe(1)
    expect(output).toMatch(/name or --managed/i)
  })

  it.each(['managed', 'default'])('treats %s as an ordinary local Profile name', async (name) => {
    const reads: string[] = []
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async (readName) => {
        reads.push(readName)
        return userProfile(readName, { meta: META, kind: 'diy' })
      },
      writeActive,
    })

    const { output, exitCode } = await serveCli(cli, ['profile', 'use', name])
    expect(exitCode).toBe(0)
    expect(reads).toEqual([name])
    expect(writes).toEqual([{ profile: name }])
    expect(JSON.parse(output)).toEqual({ profile: name, previous: null })
  })

  it('does not activate a DIY Profile that fails runtime snapshot validation', async () => {
    const { writes, writeActive } = captureWrites()
    const body = internallyInconsistentDiyBody()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async (name) => userProfile(name, { body, meta: META, kind: 'diy' }),
      writeActive,
    })

    const { exitCode, output } = await serveCli(cli, ['profile', 'use', 'broken'])

    expect(exitCode).toBe(1)
    expect(output).toContain('AGENT_PROFILE_VERSION_MISMATCH')
    expect(writes).toEqual([])
  })

  it('does not activate a named Profile that fails validation', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async () => {
        throw new Error('invalid profile')
      },
      writeActive,
    })

    const { exitCode, output } = await serveCli(cli, ['profile', 'use', 'broken'])
    expect(exitCode).toBe(1)
    expect(output).toMatch(/invalid profile/i)
    expect(writes).toEqual([])
  })

  it('errors when the profile does not exist', async () => {
    const cli = makeCli({
      profileExists: async () => false,
      writeActive: async () => {
        throw new Error('should not be called')
      },
    })
    const { exitCode, output } = await serveCli(cli, ['profile', 'use', 'ghost'])
    expect(exitCode).toBe(1)
    expect(output).toMatch(/does not exist|PROFILE_NOT_FOUND/i)
  })
})
