// user profile filesystem management.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlatformProfile } from './profile.js'
import {
  activeYamlPath,
  listProfiles,
  profileDir,
  profileExists,
  profileStoreHome,
  profilesRoot,
  readActive,
  readUserProfile,
  saveUserProfile,
  validateProfileName,
  writeActive,
} from './profile-store.js'

const SAMPLE_BODY: PlatformProfile = {
  ucp: {
    version: '2026-04-08',
    status: 'success',
    services: {},
    payment_handlers: {},
  },
  signing_keys: [],
}

const SAMPLE_META = {
  created_at: '2026-05-05T12:00:00Z',
  profile_url: 'https://mybot.example.com/.well-known/ucp',
  protocol_versions: { min: '2026-01-11', max: '2026-04-08' },
}

describe('path helpers', () => {
  it('profileStoreHome honors explicit homeDir option', () => {
    expect(profileStoreHome({ homeDir: '/tmp/x' })).toBe('/tmp/x')
  })

  it('profilesRoot/profileDir/activeYamlPath compose under the home', () => {
    const home = '/tmp/x'
    expect(profilesRoot({ homeDir: home })).toBe(join(home, 'profiles'))
    expect(profileDir('prod', { homeDir: home })).toBe(join(home, 'profiles', 'prod'))
    expect(activeYamlPath({ homeDir: home })).toBe(join(home, 'active.yaml'))
  })
})

describe('validateProfileName', () => {
  it.each([
    'prod',
    'my-bot',
    'shop.example',
    'a1',
    'a_b',
    'a-b-c',
    'default',
  ])('accepts %s', (name) => {
    expect(() => validateProfileName(name)).not.toThrow()
  })

  it.each([
    ['Prod', 'uppercase'],
    ['-leading-dash', 'leading non-alphanumeric'],
    ['.leading-dot', 'leading non-alphanumeric'],
    ['has space', 'whitespace'],
    ['has/slash', 'path separator'],
    ['..', 'parent directory literal'],
    ['', 'empty'],
  ])('rejects %s (%s)', (name) => {
    expect(() => validateProfileName(name)).toThrowError(
      expect.objectContaining({ code: 'PROFILE_INVALID_NAME' }) as unknown as Error,
    )
  })
})

describe('profile CRUD', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-store-test-'))
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('listProfiles returns [] when ~/.ucp/profiles is missing', async () => {
    expect(await listProfiles({ homeDir })).toStrictEqual([])
  })

  it('save → list → read round-trips body and meta', async () => {
    const saved = await saveUserProfile(
      { name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META },
      { homeDir },
    )
    expect(saved.name).toBe('prod')

    expect(await listProfiles({ homeDir })).toStrictEqual(['prod'])
    expect(await profileExists('prod', { homeDir })).toBe(true)

    const read = await readUserProfile('prod', { homeDir })
    expect(read.body.ucp.version).toBe('2026-04-08')
    expect(read.meta.profile_url).toBe('https://mybot.example.com/.well-known/ucp')
  })

  it('save with overwrite=false on existing profile throws PROFILE_ALREADY_EXISTS', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await expect(
      saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir }),
    ).rejects.toMatchObject({ code: 'PROFILE_ALREADY_EXISTS' })
  })

  it('save with overwrite=true on existing profile succeeds', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    const updatedMeta = {
      ...SAMPLE_META,
      profile_url: 'https://newhost.example.com/.well-known/ucp',
    }
    await saveUserProfile(
      { name: 'prod', body: SAMPLE_BODY, meta: updatedMeta, overwrite: true },
      { homeDir },
    )
    const read = await readUserProfile('prod', { homeDir })
    expect(read.meta.profile_url).toBe('https://newhost.example.com/.well-known/ucp')
  })

  it('readUserProfile on missing profile throws PROFILE_NOT_FOUND with layer=client', async () => {
    await expect(readUserProfile('ghost', { homeDir })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
      layer: 'client',
    })
  })

  it('listProfiles returns names in sorted order, ignoring stray files and bad names', async () => {
    for (const name of ['zebra', 'alpha', 'bravo']) {
      await saveUserProfile({ name, body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    }
    // Inject a stray file at the profiles root and a bogus-name dir
    const { mkdir } = await import('node:fs/promises')
    await writeFile(join(homeDir, 'profiles', 'README'), 'hi', 'utf-8')
    await mkdir(join(homeDir, 'profiles', 'BadCase'))

    expect(await listProfiles({ homeDir })).toStrictEqual(['alpha', 'bravo', 'zebra'])
  })

  it('readUserProfile rejects corrupt profile.json with SCHEMA_VALIDATION_FAILED', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    // Hand-corrupt profile.json: not even valid JSON
    await writeFile(join(profileDir('prod', { homeDir }), 'profile.json'), '<not json>', 'utf-8')
    await expect(readUserProfile('prod', { homeDir })).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    })
  })

  it('readUserProfile rejects schema-mismatched meta.json with SCHEMA_VALIDATION_FAILED', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    // meta.created_at must be a string per schema; supply a number
    await writeFile(
      join(profileDir('prod', { homeDir }), 'meta.json'),
      JSON.stringify({ created_at: 12345 }),
      'utf-8',
    )
    await expect(readUserProfile('prod', { homeDir })).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    })
  })

  it('readUserProfile rejects non-HTTPS profile_url with SCHEMA_VALIDATION_FAILED', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeFile(
      join(profileDir('prod', { homeDir }), 'meta.json'),
      JSON.stringify({ ...SAMPLE_META, profile_url: 'http://mybot.example.com/profile.json' }),
      'utf-8',
    )
    await expect(readUserProfile('prod', { homeDir })).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    })
  })

  // `defaults.catalog` is the v0.1 theme-2 routing fallback. The schema must
  // accept absent defaults (existing profiles), present-but-empty defaults,
  // populated defaults, and reject malformed URLs at parse time so a broken
  // meta.json fails fast rather than dispatch surfacing the error mid-call.
  it('readUserProfile preserves defaults.catalog when set', async () => {
    await saveUserProfile(
      {
        name: 'prod',
        body: SAMPLE_BODY,
        meta: {
          ...SAMPLE_META,
          defaults: { catalog: 'https://catalog.shopify.com/api/ucp/mcp' },
        },
      },
      { homeDir },
    )
    const read = await readUserProfile('prod', { homeDir })
    expect(read.meta.defaults?.catalog).toBe('https://catalog.shopify.com/api/ucp/mcp')
  })

  it('readUserProfile accepts meta with no defaults block (backward-compat)', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    const read = await readUserProfile('prod', { homeDir })
    expect(read.meta.defaults).toBeUndefined()
  })

  it('readUserProfile accepts defaults block without catalog', async () => {
    // Future-proofing: a user with `defaults.cart` set but no `defaults.catalog`
    // is a valid shape — catalog ops fall through to the no-business error,
    // cart ops use their default. The .loose() inner schema preserves the
    // unknown key. The intent is to verify "no catalog" doesn't reject.
    await saveUserProfile(
      { name: 'prod', body: SAMPLE_BODY, meta: { ...SAMPLE_META, defaults: {} } },
      { homeDir },
    )
    const read = await readUserProfile('prod', { homeDir })
    expect(read.meta.defaults).toStrictEqual({})
  })

  it('readUserProfile rejects non-URL defaults.catalog with SCHEMA_VALIDATION_FAILED', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeFile(
      join(profileDir('prod', { homeDir }), 'meta.json'),
      JSON.stringify({
        ...SAMPLE_META,
        defaults: { catalog: 'not-a-url' },
      }),
      'utf-8',
    )
    await expect(readUserProfile('prod', { homeDir })).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    })
  })

  it('readUserProfile preserves unknown defaults.* keys via .loose() (forward-compat)', async () => {
    // PROTOCOL §12 forward-compat: an old CLI reading a meta.json written by
    // a newer CLI that added `defaults.cart` must not strip it on round-trip.
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeFile(
      join(profileDir('prod', { homeDir }), 'meta.json'),
      JSON.stringify({
        ...SAMPLE_META,
        defaults: { catalog: 'https://x.example/mcp', cart: 'https://y.example/mcp' },
      }),
      'utf-8',
    )
    const read = await readUserProfile('prod', { homeDir })
    expect(read.meta.defaults).toMatchObject({
      catalog: 'https://x.example/mcp',
      cart: 'https://y.example/mcp',
    })
  })
})

describe('active session', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-active-test-'))
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('readActive returns {} when active.yaml is missing', async () => {
    expect(await readActive({ homeDir })).toStrictEqual({})
  })

  it('writeActive then readActive round-trips', async () => {
    await writeActive({ profile: 'prod', business: 'https://shop.example.com' }, { homeDir })
    expect(await readActive({ homeDir })).toStrictEqual({
      profile: 'prod',
      business: 'https://shop.example.com',
    })
  })

  it('writeActive with empty session writes a parseable file', async () => {
    await writeActive({}, { homeDir })
    const raw = await readFile(activeYamlPath({ homeDir }), 'utf-8')
    expect(raw).toMatch(/^\{?\}?\s*$|^---/m) // empty YAML or empty doc — both acceptable
    expect(await readActive({ homeDir })).toStrictEqual({})
  })

  it('readActive treats malformed YAML as no session', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(homeDir, { recursive: true })
    // ~ in YAML parses as null; readActive should degrade to {} gracefully
    await writeFile(activeYamlPath({ homeDir }), '~\n', 'utf-8')
    expect(await readActive({ homeDir })).toStrictEqual({})
  })

  it('readActive degrades to {} when YAML parses but shape is wrong', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(homeDir, { recursive: true })
    // active.yaml is session state — a hand-edit with wrong types should
    // not take the dispatcher offline. Yields {} rather than throwing.
    await writeFile(activeYamlPath({ homeDir }), 'profile: 5\nbusiness:\n  - a\n  - b\n', 'utf-8')
    expect(await readActive({ homeDir })).toStrictEqual({})
  })

  it('readActive preserves unknown fields via .loose() passthrough', async () => {
    await writeActive({ profile: 'prod', business: 'https://shop.example.com' }, { homeDir })
    // Tack on a future field via raw write
    const { mkdir } = await import('node:fs/promises')
    await mkdir(homeDir, { recursive: true })
    await writeFile(
      activeYamlPath({ homeDir }),
      'profile: prod\nbusiness: https://shop.example.com\nfuture_field: ignore-me\n',
      'utf-8',
    )
    const session = await readActive({ homeDir })
    expect((session as Record<string, unknown>).future_field).toBe('ignore-me')
  })

  it('writeActive does not leave temp files behind on success', async () => {
    await writeActive({ profile: 'prod', business: 'https://shop.example.com' }, { homeDir })
    const entries = await readdir(homeDir)
    expect(entries.filter((name) => name.startsWith('active.yaml.tmp.'))).toHaveLength(0)
  })
})
