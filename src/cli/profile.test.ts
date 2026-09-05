// Profile CLI command-tree tests.
//
// Pins the local profile UX: small command surface, HTTPS-only explicit
// profile URLs, and default catalog inheritance. There is no upload verb —
// ucp-cli never writes to a profile URL, so hosting is entirely the user's.

import { describe, expect, it } from 'vitest'

import { createUcpCli } from '../cli.js'
import type { ProfileMeta } from '../core/profile-store.js'
import { LATEST, RELEASES, SUPPORTED_VERSIONS } from '../core/releases.js'
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
}

function makeCli(overrides: Partial<ProfileCliDependencies> = {}) {
  return createUcpCli({ profile: { ...defaultProfileDeps(), ...overrides } })
}

describe('ucp profile list', () => {
  it('returns names with the active marker resolved', async () => {
    const cli = makeCli({
      listProfiles: async () => ['alpha', 'beta'],
      readActive: async () => ({ profile: 'beta' }),
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'list'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({
      active: 'beta',
      profiles: [
        { name: 'alpha', active: false },
        { name: 'beta', active: true },
      ],
    })
  })
})

describe('ucp profile show', () => {
  it('errors with CTA when no active profile is set', async () => {
    const cli = makeCli()
    const { output, exitCode } = await serveCli(cli, ['profile', 'show'])
    expect(exitCode).toBe(1)
    expect(output).toMatch(/PROFILE_NOT_FOUND/)
    expect(output).toMatch(/profile init --name agent/)
  })

  it('returns the named profile', async () => {
    const cli = makeCli({
      readUserProfile: async (name) => userProfile(name, { meta: META }),
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'show', 'alpha'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ name: 'alpha', meta: META })
  })

  it('falls back to the active profile when name is omitted', async () => {
    const reads: string[] = []
    const cli = makeCli({
      readActive: async () => ({ profile: 'live' }),
      readUserProfile: async (name) => {
        reads.push(name)
        return userProfile(name, { meta: META })
      },
    })
    const { output } = await serveCli(cli, ['profile', 'show'])
    expect(reads).toEqual(['live'])
    expect(JSON.parse(output)).toMatchObject({ name: 'live' })
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
    expect(output).toMatch(/profile init --name agent/)
    expect(output).toMatch(/--profile-url https:\/\/example\.com\/\.well-known\/ucp/)
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
      meta: { profile_url: 'https://p.example/.well-known/ucp' },
    })
    expect(JSON.parse(output)).toMatchObject({ name: 'prompted', activated: true })
  })

  it('creates a DIY profile when --profile-url is provided', async () => {
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
      },
      overwrite: false,
    })
    expect(writes).toEqual([{ profile: 'fresh' }])
    expect(JSON.parse(output)).toMatchObject({ name: 'fresh', activated: true })
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
    expect(saves[0]?.meta.profile_url).toBe(RELEASES[LATEST].defaultAgentProfileUrl)
    expect(JSON.parse(output)).toMatchObject({ name: 'fresh' })
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
    expect((saves[0]?.body as { ucp: { version: string } }).ucp.version).toBe('2026-04-08')
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
      'profile_url',
      'updated_at',
    ])
  })

  it('returns no-op output when the profile already exists', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({ profileExists: async () => true, saveUserProfile })
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

  it('honors --force by overwriting and preserving prior created_at', async () => {
    const PRIOR_CREATED = '2026-01-15T08:00:00.000Z'
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      profileExists: async () => true,
      readUserProfile: async (name) =>
        userProfile(name, { meta: { ...META, created_at: PRIOR_CREATED } }),
      saveUserProfile,
    })
    await serveCli(cli, ['profile', 'init', '--name', 'fresh', '--force'])
    expect(saves[0]).toMatchObject({
      meta: { created_at: PRIOR_CREATED },
      overwrite: true,
    })
  })
})

describe('ucp profile use', () => {
  it('writes active.yaml when the profile exists', async () => {
    const { writes, writeActive } = captureWrites()
    const cli = makeCli({
      profileExists: async () => true,
      readActive: async () => ({ profile: 'old' }),
      writeActive,
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'use', 'newp'])
    expect(exitCode).toBe(0)
    expect(writes).toEqual([{ profile: 'newp' }])
    expect(JSON.parse(output)).toEqual({ profile: 'newp', previous: 'old' })
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
