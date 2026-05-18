// Profile CLI command-tree tests.
//
// Pins the local profile UX: small command surface, implicit managed init,
// HTTPS-only explicit profile URLs, default catalog inheritance, and the
// mocked managed upload seam. Hosting service behavior lives outside this
// test suite.

import { describe, expect, it } from 'vitest'

import { createUcpCli } from '../cli.js'
import type { ProfileMeta } from '../core/profile-store.js'
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
  protocol_versions: { min: '2026-01-23', max: '2026-04-08' },
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

  it('creates an implicit managed profile and accepts an empty upload seam result', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const uploads: string[] = []
    const cli = makeCli({
      saveUserProfile,
      uploadProfile: async (input) => {
        uploads.push(input.name)
        return {}
      },
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'init', '--name', 'fresh'])
    expect(exitCode).toBe(0)
    expect(uploads).toEqual(['fresh'])
    expect(saves[0]).toMatchObject({
      name: 'fresh',
      meta: {},
    })
    expect(saves[0]?.meta.profile_url).toBeUndefined()
    expect(JSON.parse(output)).toMatchObject({ name: 'fresh' })
  })

  it('stores flat upload metadata when the upload seam returns a profile URL', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      saveUserProfile,
      uploadProfile: async () => ({
        profileUrl: 'https://profiles.ucp.dev/p/abc/profile.json',
        profileId: 'abc',
        etag: '"123"',
        publishedAt: '2026-05-02T00:00:00.000Z',
      }),
    })
    const { exitCode } = await serveCli(cli, ['profile', 'init', '--name', 'fresh'])
    expect(exitCode).toBe(0)
    expect(saves[0]).toMatchObject({
      meta: {
        profile_url: 'https://profiles.ucp.dev/p/abc/profile.json',
        profile_id: 'abc',
        etag: '"123"',
        published_at: '2026-05-02T00:00:00.000Z',
      },
    })
  })

  it('does not call upload when --profile-url is provided', async () => {
    const { saveUserProfile } = captureSaves()
    const uploads: string[] = []
    const cli = makeCli({
      saveUserProfile,
      uploadProfile: async (input) => {
        uploads.push(input.name)
        return { profileUrl: 'https://profiles.ucp.dev/p/abc/profile.json' }
      },
    })
    const { exitCode } = await serveCli(cli, [
      'profile',
      'init',
      '--name',
      'fresh',
      '--profile-url',
      'https://example.com/.well-known/ucp',
    ])
    expect(exitCode).toBe(0)
    expect(uploads).toEqual([])
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

describe('ucp profile publish', () => {
  it('returns manual upload instructions for non-managed profile URLs', async () => {
    const cli = makeCli({
      readActive: async () => ({ profile: 'alpha' }),
      readUserProfile: async (name) => userProfile(name, { meta: META }),
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'publish'])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output)
    expect(parsed).toMatchObject({
      profile: 'alpha',
      published: false,
      profile_url: 'https://example.com/.well-known/ucp',
      cta: { commands: expect.any(Array) },
    })
    expect(parsed.cta.description).toMatch(/Upload profile\.json/)
  })

  it('allows publishing a local profile named default', async () => {
    const cli = makeCli({
      readActive: async () => ({ profile: 'default' }),
      readUserProfile: async (name) =>
        userProfile(name, { meta: { ...META, profile_url: undefined } }),
      uploadProfile: async () => ({}),
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'publish'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toMatchObject({
      profile: 'default',
      published: false,
      upload: 'not_configured',
    })
  })

  it('returns not_configured when managed upload seam returns empty', async () => {
    const cli = makeCli({
      readActive: async () => ({ profile: 'alpha' }),
      readUserProfile: async (name) =>
        userProfile(name, { meta: { ...META, profile_url: undefined } }),
      uploadProfile: async () => ({}),
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'publish'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toMatchObject({
      profile: 'alpha',
      published: false,
      upload: 'not_configured',
    })
  })

  it('updates managed metadata when upload returns a URL', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      readUserProfile: async (name) =>
        userProfile(name, { meta: { ...META, profile_url: undefined } }),
      saveUserProfile,
      uploadProfile: async () => ({ profileUrl: 'https://profiles.ucp.dev/p/abc/profile.json' }),
    })
    const { output, exitCode } = await serveCli(cli, ['profile', 'publish', 'alpha'])
    expect(exitCode).toBe(0)
    expect(saves[0]).toMatchObject({
      name: 'alpha',
      meta: { profile_url: 'https://profiles.ucp.dev/p/abc/profile.json' },
      overwrite: true,
    })
    expect(JSON.parse(output)).toMatchObject({ published: true })
  })

  it('treats known managed origins as publishable', async () => {
    const { saves, saveUserProfile } = captureSaves()
    const cli = makeCli({
      readUserProfile: async (name) =>
        userProfile(name, {
          meta: { ...META, profile_url: 'https://profiles.ucp.dev/p/abc/profile.json' },
        }),
      saveUserProfile,
      uploadProfile: async () => ({ profileUrl: 'https://profiles.ucp.dev/p/abc/profile.json' }),
    })
    const { exitCode } = await serveCli(cli, ['profile', 'publish', 'alpha'])
    expect(exitCode).toBe(0)
    expect(saves).toHaveLength(1)
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
