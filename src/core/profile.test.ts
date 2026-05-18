// Tests for profile defaults and business profile fetch behavior.
//
// Generic fetch/cache mechanics are covered in cache.test.ts; this suite checks
// profile-specific URL construction, schema validation, and HTTPS enforcement.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CacheEntry } from './cache.js'
import {
  type BusinessProfile,
  DEFAULT_AGENT_CAPABILITY_IDS,
  DEFAULT_PROFILE_URL,
  fetchBusinessProfile,
  localAgentProfileBody,
  parsePlatformProfile,
} from './profile.js'

describe('temporary profile URL fallback', () => {
  it('DEFAULT_PROFILE_URL matches the build-time-defined template', () => {
    // Internal-testing stopgap: points at a known-reachable UCP-shaped profile
    // until we publish a shopify.github.io-hosted default. Friction-logged.
    expect(DEFAULT_PROFILE_URL).toMatch(/^https:\/\/[\w.-]+\/.+\.json(\?.*)?$/)
  })
})

describe('localAgentProfileBody — local profile template', () => {
  // The body is the on-disk template `profile init` writes. Pin the shape so a
  // careless edit doesn't silently drop a capability that EXTENSION_HINTS or an
  // integration test relies on.
  it('schema-validates as a PlatformProfile', () => {
    // If the schema ever rejects, `profile init` is broken at runtime — pinning
    // here catches it at unit-test time instead.
    expect(() => parsePlatformProfile(localAgentProfileBody())).not.toThrow()
  })

  it('returns a fresh deep-cloned object on every call', () => {
    const a = localAgentProfileBody()
    const b = localAgentProfileBody()
    expect(a).not.toBe(b)
    expect(a.ucp.capabilities).not.toBe(b.ucp.capabilities)
    // Mutating one must not bleed into the next call.
    if (a.ucp.capabilities) a.ucp.capabilities['dev.shopify.catalog'] = []
    expect(
      localAgentProfileBody().ucp.capabilities?.['dev.shopify.catalog']?.length,
    ).toBeGreaterThan(0)
  })

  it('advertises the core shopping ops and Shopify catalog extensions', () => {
    const body = localAgentProfileBody()
    const ids = Object.keys(body.ucp.capabilities ?? {})
    // Core shopping ops + Shopify storefront/global-catalog extensions. If we
    // drop one, agents lose advertised support — explicit list catches that.
    expect(ids).toEqual(
      expect.arrayContaining([
        'dev.ucp.shopping.checkout',
        'dev.ucp.shopping.cart',
        'dev.ucp.shopping.fulfillment',
        'dev.ucp.shopping.discount',
        'dev.ucp.shopping.catalog.search',
        'dev.ucp.shopping.catalog.lookup',
        'dev.ucp.shopping.order',
        'dev.shopify.catalog',
        'dev.shopify.catalog.global',
      ]),
    )
  })

  it('DEFAULT_AGENT_CAPABILITY_IDS matches the bundled body keys', () => {
    // The exported constant is the source for the response-filter allowlist;
    // it must stay in sync with the body or the filter rejects things we
    // advertise (or vice-versa).
    const bodyKeys = Object.keys(localAgentProfileBody().ucp.capabilities ?? {})
    expect([...DEFAULT_AGENT_CAPABILITY_IDS].sort()).toEqual([...bodyKeys].sort())
  })
})

interface MockResponseInit {
  status?: number
  headers?: Record<string, string>
  body: string | object
}

interface MockFetch {
  fn: typeof fetch
  calls: Array<{ url: string; init?: RequestInit }>
}

function mockResponse(init: MockResponseInit): Response {
  const body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

function makeMockFetch(responses: MockResponseInit[]): MockFetch {
  const calls: MockFetch['calls'] = []
  let i = 0
  const fn: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, ...(init === undefined ? {} : { init }) })
    const next = responses[i++]
    if (next === undefined) throw new Error(`mock fetch: no response queued for ${url}`)
    return mockResponse(next)
  }
  return { fn, calls }
}

const SAMPLE_PROFILE: BusinessProfile = {
  ucp: {
    version: '2026-04-08',
    status: 'success',
    services: {
      'dev.ucp.shopping': [
        { version: '2026-04-08', transport: 'rest', endpoint: 'https://shop.example.com/api/ucp' },
      ],
    },
    payment_handlers: {},
  },
}

describe('fetchBusinessProfile', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-profile-test-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('appends /.well-known/ucp to the business URL and caches the response', async () => {
    const mock = makeMockFetch([
      { body: SAMPLE_PROFILE, headers: { 'cache-control': 'public, max-age=300' } },
    ])
    const profile = await fetchBusinessProfile('https://shop.example.com', {
      cacheDir,
      fetch: mock.fn,
    })

    expect(profile.ucp.version).toBe('2026-04-08')
    expect(mock.calls[0]?.url).toBe('https://shop.example.com/.well-known/ucp')

    const cached = JSON.parse(
      await readFile(join(cacheDir, 'shop.example.com.json'), 'utf-8'),
    ) as CacheEntry<BusinessProfile>
    expect(cached.body.ucp.version).toBe('2026-04-08')
  })

  it('throws PROFILE_FETCH_FAILED on HTTP 4xx (retryable=false) with layer=transport', async () => {
    const mock = makeMockFetch([{ status: 404, body: '<html>nope</html>' }])
    await expect(
      fetchBusinessProfile('https://shop.example.com', { cacheDir, fetch: mock.fn }),
    ).rejects.toMatchObject({
      code: 'PROFILE_FETCH_FAILED',
      retryable: false,
      layer: 'transport',
      http_status: 404,
    })
  })

  it('throws PROFILE_FETCH_FAILED on HTTP 5xx (retryable=true)', async () => {
    const mock = makeMockFetch([{ status: 503, body: 'unavailable' }])
    await expect(
      fetchBusinessProfile('https://shop.example.com', { cacheDir, fetch: mock.fn }),
    ).rejects.toMatchObject({ code: 'PROFILE_FETCH_FAILED', retryable: true })
  })

  it('throws PROFILE_INVALID_JSON when body is not parseable', async () => {
    const mock = makeMockFetch([{ body: '<not json>', headers: { 'content-type': 'text/html' } }])
    await expect(
      fetchBusinessProfile('https://shop.example.com', { cacheDir, fetch: mock.fn }),
    ).rejects.toMatchObject({ code: 'PROFILE_INVALID_JSON' })
  })

  it('throws PROFILE_SCHEMA_INVALID when JSON parses but the profile shape is wrong', async () => {
    // services.<key> must be an array; passing a number trips zod, not JSON.parse
    const mock = makeMockFetch([
      {
        body: { ucp: { version: '2026-04-08', services: { 'dev.ucp.shopping': 42 } } },
        headers: { 'cache-control': 'max-age=60' },
      },
    ])
    await expect(
      fetchBusinessProfile('https://shop.example.com', { cacheDir, fetch: mock.fn }),
    ).rejects.toMatchObject({ code: 'PROFILE_SCHEMA_INVALID' })
  })

  it('preserves business-specific extension fields through the parse boundary', async () => {
    const extended: Record<string, unknown> = {
      ...SAMPLE_PROFILE,
      vendor_specific: { foo: 'bar', count: 42 },
    }
    const mock = makeMockFetch([{ body: extended, headers: { 'cache-control': 'max-age=60' } }])
    const profile = await fetchBusinessProfile('https://shop.example.com', {
      cacheDir,
      fetch: mock.fn,
    })
    expect((profile as Record<string, unknown>).vendor_specific).toStrictEqual({
      foo: 'bar',
      count: 42,
    })
  })

  it('force:true bypasses cache even when fresh', async () => {
    const refreshed_profile: BusinessProfile = {
      ...SAMPLE_PROFILE,
      ucp: { ...SAMPLE_PROFILE.ucp, version: '2026-05-01' },
    }
    const mock = makeMockFetch([
      { body: SAMPLE_PROFILE, headers: { 'cache-control': 'max-age=300' } },
      { body: refreshed_profile, headers: { 'cache-control': 'max-age=300' } },
    ])
    await fetchBusinessProfile('https://shop.example.com', { cacheDir, fetch: mock.fn })
    const refreshed = await fetchBusinessProfile('https://shop.example.com', {
      cacheDir,
      fetch: mock.fn,
      force: true,
    })
    expect(refreshed.ucp.version).toBe('2026-05-01')
    expect(mock.calls).toHaveLength(2)
  })

  it('uses URL.origin for cache filename (different paths share a cache entry)', async () => {
    const mock = makeMockFetch([
      { body: SAMPLE_PROFILE, headers: { 'cache-control': 'max-age=300' } },
    ])
    // First fetch with extra path; second with bare origin — both map to the same cache file.
    await fetchBusinessProfile('https://shop.example.com/some/other/path', {
      cacheDir,
      fetch: mock.fn,
    })
    await fetchBusinessProfile('https://shop.example.com', { cacheDir, fetch: mock.fn })
    expect(mock.calls).toHaveLength(1)
  })

  it('rejects non-https URLs', async () => {
    await expect(
      fetchBusinessProfile('http://shop.example.com', { cacheDir }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      layer: 'client',
    })
  })
})
