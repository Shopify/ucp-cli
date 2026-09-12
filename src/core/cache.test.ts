// Generic fetch + on-disk cache primitive tests.
//
// Covers canonical full-URL cache naming, legacy origin-key reads,
// Cache-Control TTL parsing, home-directory resolution, and fetch/cache
// failure modes. Higher-level tests cover artifact-specific schemas and error
// codes.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { z } from 'incur'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UcpError } from '../lib/errors.js'
import { clearProxyEnv } from '../test-utils.js'
import {
  type CacheEntry,
  cacheCompute,
  fetchCached,
  MIN_CACHE_SECONDS,
  originToFilename,
  parseMaxAge,
  ucpHomeDir,
  urlToFilename,
} from './cache.js'
import { installProxyDispatcher, resetProxyStateForTests } from './proxy.js'

describe('originToFilename', () => {
  it.each([
    ['https://shop.example.com', 'shop.example.com'],
    ['https://shop.example.com/', 'shop.example.com'],
    ['https://shop.example.com/.well-known/ucp', 'shop.example.com'],
    // case folding: WHATWG URL parser lowercases hostnames
    ['https://Shop.Example.com', 'shop.example.com'],
    // default port (443 for https) is stripped
    ['https://shop.example.com:443', 'shop.example.com'],
    // non-default port: : → _ for Windows compat
    ['https://shop.example.com:8443', 'shop.example.com_8443'],
    // http default (80) is stripped
    ['http://shop.example.com:80', 'shop.example.com'],
    // http non-default
    ['http://localhost:3000', 'localhost_3000'],
    ['http://localhost:8080', 'localhost_8080'],
  ])('canonicalizes %s → %s', (input, expected) => {
    expect(originToFilename(input)).toBe(expected)
  })

  it('accepts a parsed URL as input', () => {
    expect(originToFilename(new URL('https://shop.example.com:8443/api'))).toBe(
      'shop.example.com_8443',
    )
  })

  it('produces filenames safe under [a-z0-9._-]', () => {
    const inputs = [
      'https://shop.example.com',
      'https://shop.example.com:8443',
      'http://localhost:3000',
      'https://my-shop.example.co.uk',
    ]
    for (const url of inputs) {
      expect(originToFilename(url)).toMatch(/^[a-z0-9._-]+$/)
    }
  })
})

describe('urlToFilename', () => {
  it('uses the canonical full URL and produces a SHA-256 filename', () => {
    const canonical = 'https://example.com/profiles/a.json?release=2026-04-08'
    const equivalent = 'https://EXAMPLE.com:443/ignored/../profiles/a.json?release=2026-04-08'

    expect(urlToFilename(equivalent)).toBe(urlToFilename(canonical))
    expect(urlToFilename(canonical)).toMatch(/^[a-f0-9]{64}$/)
    expect(urlToFilename(canonical)).not.toBe(
      urlToFilename('https://example.com/profiles/b.json?release=2026-04-08'),
    )
    expect(urlToFilename(canonical)).not.toBe(
      urlToFilename('https://example.com/profiles/a.json?release=2026-08-25'),
    )
  })
})

describe('parseMaxAge (UCP 60s floor)', () => {
  it.each([
    ['public, max-age=600', 600],
    ['max-age=300, must-revalidate', 300],
    // Below floor → clamped up
    ['max-age=10', MIN_CACHE_SECONDS],
    ['max-age=0', MIN_CACHE_SECONDS],
    // No max-age directive → floor
    ['must-revalidate', MIN_CACHE_SECONDS],
    ['public', MIN_CACHE_SECONDS],
    // Whitespace tolerant
    ['max-age = 90', 90],
    ['MAX-AGE=200', 200],
  ])('parses %j → %d seconds', (header, expected) => {
    expect(parseMaxAge(header)).toBe(expected)
  })

  it.each([[null], [undefined], ['']])('falls back to floor when header is %j', (header) => {
    expect(parseMaxAge(header)).toBe(MIN_CACHE_SECONDS)
  })

  it('returns null for no-store (must not cache)', () => {
    expect(parseMaxAge('no-store')).toBeNull()
    expect(parseMaxAge('no-store, max-age=60')).toBeNull()
    expect(parseMaxAge('public, no-store')).toBeNull()
  })

  it('does not confuse no-store with no-cache (latter still cacheable with revalidation)', () => {
    expect(parseMaxAge('no-cache, max-age=120')).toBe(120)
  })

  it('honors a custom floor', () => {
    expect(parseMaxAge('max-age=10', 30)).toBe(30)
    expect(parseMaxAge('max-age=100', 30)).toBe(100)
  })
})

describe('ucpHomeDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('honors $UCP_HOME', () => {
    vi.stubEnv('UCP_HOME', '/custom/ucp')
    expect(ucpHomeDir()).toBe('/custom/ucp')
  })

  it('falls back to ~/.ucp when $UCP_HOME unset', () => {
    vi.stubEnv('UCP_HOME', undefined)
    expect(ucpHomeDir().endsWith(`${sep}.ucp`)).toBe(true)
  })
})

// ─── fetchCached primitive ───────────────────────────────────────────────

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

const codes = {
  fetchFailed: 'TEST_FETCH_FAILED',
  invalidJson: 'TEST_INVALID_JSON',
  schemaInvalid: 'TEST_SCHEMA_INVALID',
}

async function writeFreshCache<T>(path: string, url: string, body: T): Promise<void> {
  const now = Date.now()
  const entry: CacheEntry<T> = {
    url,
    fetched_at: now,
    expires_at: now + 300_000,
    body,
  }
  await writeFile(path, JSON.stringify(entry), 'utf-8')
}

describe('fetchCached', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-cache-test-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('fetches, returns parsed body, and writes the cache envelope', async () => {
    const url = 'https://example.com/x'
    const mock = makeMockFetch([
      { body: { hello: 'world' }, headers: { 'cache-control': 'max-age=300' } },
    ])
    const body = await fetchCached(url, {
      cacheDir,
      errorCodes: codes,
      fetch: mock.fn,
    })

    expect(body).toStrictEqual({ hello: 'world' })
    const cached = JSON.parse(
      await readFile(join(cacheDir, `${urlToFilename(url)}.json`), 'utf-8'),
    ) as CacheEntry<unknown>
    expect(cached.url).toBe(url)
    expect(cached.body).toStrictEqual({ hello: 'world' })
    expect(cached.expires_at - cached.fetched_at).toBe(300_000)
  })

  it('returns cached body on second call within TTL (no second fetch)', async () => {
    const mock = makeMockFetch([
      { body: { hello: 'world' }, headers: { 'cache-control': 'max-age=300' } },
    ])
    await fetchCached('https://example.com/x', { cacheDir, errorCodes: codes, fetch: mock.fn })
    await fetchCached('https://example.com/x', { cacheDir, errorCodes: codes, fetch: mock.fn })
    expect(mock.calls).toHaveLength(1)
  })

  it('keeps same-origin URLs with distinct paths in separate cache entries', async () => {
    const firstUrl = 'https://cdn.example.com/profiles/business-a.json?release=2026-04-08'
    const secondUrl = 'https://cdn.example.com/profiles/business-b.json?release=2026-04-08'
    const mock = makeMockFetch([
      { body: { business: 'A' }, headers: { 'cache-control': 'max-age=300' } },
      { body: { business: 'B' }, headers: { 'cache-control': 'max-age=300' } },
    ])

    const first = await fetchCached(firstUrl, { cacheDir, errorCodes: codes, fetch: mock.fn })
    const second = await fetchCached(secondUrl, { cacheDir, errorCodes: codes, fetch: mock.fn })

    expect(first).toEqual({ business: 'A' })
    expect(second).toEqual({ business: 'B' })
    expect(mock.calls.map((call) => call.url)).toEqual([firstUrl, secondUrl])
    expect((await readdir(cacheDir)).sort()).toEqual(
      [`${urlToFilename(firstUrl)}.json`, `${urlToFilename(secondUrl)}.json`].sort(),
    )
  })

  it('treats a primary entry whose envelope names another URL as a miss', async () => {
    const requestedUrl = 'https://cdn.example.com/profiles/business-b.json'
    await writeFreshCache(
      join(cacheDir, `${urlToFilename(requestedUrl)}.json`),
      'https://cdn.example.com/profiles/business-a.json',
      { business: 'A' },
    )
    const mock = makeMockFetch([
      { body: { business: 'B' }, headers: { 'cache-control': 'max-age=300' } },
    ])

    const result = await fetchCached(requestedUrl, {
      cacheDir,
      errorCodes: codes,
      fetch: mock.fn,
    })

    expect(result).toEqual({ business: 'B' })
    expect(mock.calls).toHaveLength(1)
  })

  it('accepts a canonically equivalent URL in the stored envelope', async () => {
    const requestedUrl = 'https://example.com/profiles/business-a.json?release=2026-04-08'
    const storedUrl =
      'https://EXAMPLE.com:443/ignored/../profiles/business-a.json?release=2026-04-08'
    await writeFreshCache(join(cacheDir, `${urlToFilename(requestedUrl)}.json`), storedUrl, {
      source: 'cache',
    })
    const mock = makeMockFetch([])

    const result = await fetchCached(requestedUrl, {
      cacheDir,
      errorCodes: codes,
      fetch: mock.fn,
    })

    expect(result).toEqual({ source: 'cache' })
    expect(mock.calls).toHaveLength(0)
  })

  it('reads a matching fresh legacy origin-key entry without rewriting it', async () => {
    const requestedUrl = 'https://example.com/profiles/business-a.json'
    const legacyPath = join(cacheDir, `${originToFilename(requestedUrl)}.json`)
    await writeFreshCache(
      legacyPath,
      'https://EXAMPLE.com:443/ignored/../profiles/business-a.json',
      { source: 'legacy' },
    )
    const mock = makeMockFetch([])

    const result = await fetchCached(requestedUrl, {
      cacheDir,
      errorCodes: codes,
      fetch: mock.fn,
    })

    expect(result).toEqual({ source: 'legacy' })
    expect(mock.calls).toHaveLength(0)
    expect(await readdir(cacheDir)).toEqual([`${originToFilename(requestedUrl)}.json`])
  })

  it('does not roll an expired primary back to an older fresh legacy entry', async () => {
    const requestedUrl = 'https://example.com/profiles/business-a.json'
    const now = Date.now()
    const primary: CacheEntry<{ source: string }> = {
      url: requestedUrl,
      fetched_at: now - 60_000,
      expires_at: now - 1,
      body: { source: 'expired-primary' },
    }
    const legacy: CacheEntry<{ source: string }> = {
      url: requestedUrl,
      fetched_at: now - 120_000,
      expires_at: now + 60_000,
      body: { source: 'legacy' },
    }
    await Promise.all([
      writeFile(
        join(cacheDir, `${urlToFilename(requestedUrl)}.json`),
        JSON.stringify(primary),
        'utf-8',
      ),
      writeFile(
        join(cacheDir, `${originToFilename(requestedUrl)}.json`),
        JSON.stringify(legacy),
        'utf-8',
      ),
    ])
    const mock = makeMockFetch([
      { body: { source: 'network' }, headers: { 'cache-control': 'max-age=300' } },
    ])

    const result = await fetchCached(requestedUrl, {
      cacheDir,
      errorCodes: codes,
      fetch: mock.fn,
    })

    expect(mock.calls).toHaveLength(1)
    expect(result).toEqual({ source: 'network' })
  })

  it('never reuses a mismatching legacy origin-key entry', async () => {
    const requestedUrl = 'https://cdn.example.com/profiles/business-b.json'
    const legacyPath = join(cacheDir, `${originToFilename(requestedUrl)}.json`)
    await writeFreshCache(legacyPath, 'https://cdn.example.com/profiles/business-a.json', {
      business: 'A',
    })
    const mock = makeMockFetch([
      { body: { business: 'B' }, headers: { 'cache-control': 'max-age=300' } },
    ])

    const result = await fetchCached(requestedUrl, {
      cacheDir,
      errorCodes: codes,
      fetch: mock.fn,
    })

    expect(result).toEqual({ business: 'B' })
    expect(mock.calls).toHaveLength(1)
    expect(await readdir(cacheDir)).toContain(`${urlToFilename(requestedUrl)}.json`)
  })

  it('force:true bypasses cache even when fresh', async () => {
    const mock = makeMockFetch([
      { body: { v: 1 }, headers: { 'cache-control': 'max-age=300' } },
      { body: { v: 2 }, headers: { 'cache-control': 'max-age=300' } },
    ])
    await fetchCached('https://example.com/x', { cacheDir, errorCodes: codes, fetch: mock.fn })
    const refreshed = await fetchCached<{ v: number }>('https://example.com/x', {
      cacheDir,
      errorCodes: codes,
      fetch: mock.fn,
      force: true,
    })
    expect(refreshed.v).toBe(2)
    expect(mock.calls).toHaveLength(2)
  })

  it('does not write a cache file when Cache-Control is no-store', async () => {
    const mock = makeMockFetch([{ body: {}, headers: { 'cache-control': 'no-store' } }])
    await fetchCached('https://example.com/x', { cacheDir, errorCodes: codes, fetch: mock.fn })

    expect(await readdir(cacheDir)).toEqual([])
  })

  it('validates body against the supplied zod schema', async () => {
    const schema = z.object({ count: z.number() })
    const mock = makeMockFetch([
      { body: { count: 42 }, headers: { 'cache-control': 'max-age=60' } },
    ])
    const body = await fetchCached('https://example.com/x', {
      cacheDir,
      schema,
      errorCodes: codes,
      fetch: mock.fn,
    })
    expect(body.count).toBe(42)
  })

  it('throws schemaInvalid code when body parses as JSON but fails the schema', async () => {
    const schema = z.object({ count: z.number() })
    const mock = makeMockFetch([
      { body: { count: 'not-a-number' }, headers: { 'cache-control': 'max-age=60' } },
    ])
    await expect(
      fetchCached('https://example.com/x', {
        cacheDir,
        schema,
        errorCodes: codes,
        fetch: mock.fn,
      }),
    ).rejects.toMatchObject({ code: 'TEST_SCHEMA_INVALID', layer: 'transport' })
  })

  it('throws fetchFailed code on HTTP 4xx with retryable=false', async () => {
    const mock = makeMockFetch([{ status: 404, body: 'nope' }])
    await expect(
      fetchCached('https://example.com/x', { cacheDir, errorCodes: codes, fetch: mock.fn }),
    ).rejects.toMatchObject({
      code: 'TEST_FETCH_FAILED',
      http_status: 404,
      retryable: false,
      layer: 'transport',
    })
  })

  it('throws fetchFailed code when fetch rejects (network/timeout)', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof globalThis.fetch
    await expect(
      fetchCached('https://example.com/x', { cacheDir, errorCodes: codes, fetch }),
    ).rejects.toMatchObject({
      code: 'TEST_FETCH_FAILED',
      layer: 'transport',
      retryable: true,
    })
  })

  // Not the caller's fetchFailed code: a redirecting profile URL is a
  // permanent hosting fault, and wrapping it would mark it `retryable` and
  // bury the Location in a `cause` the error envelope never serializes.
  it('passes a refused redirect through, naming the Location, not retryable', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: { location: 'https://www.example.com/.well-known/ucp' },
        }),
    ) as unknown as typeof globalThis.fetch
    const err = await fetchCached('https://example.com/.well-known/ucp', {
      cacheDir,
      errorCodes: codes,
      fetch,
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: 'TRANSPORT_REDIRECT_REFUSED',
      http_status: 301,
      retryable: false,
    })
    expect((err as Error).message).toContain('https://www.example.com/.well-known/ucp')
  })

  it('throws fetchFailed code on HTTP 5xx with retryable=true', async () => {
    const mock = makeMockFetch([{ status: 503, body: 'unavailable' }])
    await expect(
      fetchCached('https://example.com/x', { cacheDir, errorCodes: codes, fetch: mock.fn }),
    ).rejects.toMatchObject({ code: 'TEST_FETCH_FAILED', http_status: 503, retryable: true })
  })

  it('throws invalidJson code when body is not parseable as JSON', async () => {
    const mock = makeMockFetch([
      { body: '<html>nope</html>', headers: { 'content-type': 'text/html' } },
    ])
    let caught: unknown
    try {
      await fetchCached('https://example.com/x', { cacheDir, errorCodes: codes, fetch: mock.fn })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UcpError)
    expect((caught as UcpError).code).toBe('TEST_INVALID_JSON')
  })

  it('honors a custom errorLayer', async () => {
    const mock = makeMockFetch([{ status: 400, body: 'bad' }])
    await expect(
      fetchCached('https://example.com/x', {
        cacheDir,
        errorCodes: codes,
        errorLayer: 'client',
        fetch: mock.fn,
      }),
    ).rejects.toMatchObject({ layer: 'client' })
  })

  it('rejects with a clear error when schema is set but schemaInvalid code is missing', async () => {
    const mock = makeMockFetch([{ body: { ok: true } }])
    await expect(
      fetchCached('https://example.com/x', {
        cacheDir,
        schema: z.object({ ok: z.boolean() }),
        errorCodes: { fetchFailed: 'X', invalidJson: 'Y' }, // schemaInvalid missing
        fetch: mock.fn,
      }),
    ).rejects.toThrow(/errorCodes.schemaInvalid is required/)
  })
})

// ─── cacheCompute primitive ──────────────────────────────────────────────

describe('cacheCompute', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-cache-test-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('runs compute on miss, caches the result, and skips compute on the next call', async () => {
    let calls = 0
    const compute = async () => {
      calls++
      return { v: 1 }
    }
    const a = await cacheCompute({ cacheDir, cacheKey: 'k', ttlSeconds: 300, compute })
    const b = await cacheCompute({ cacheDir, cacheKey: 'k', ttlSeconds: 300, compute })
    expect(a).toEqual({ v: 1 })
    expect(b).toEqual({ v: 1 })
    expect(calls).toBe(1)
  })

  it('treats a fresh entry whose opaque envelope key mismatches as a miss', async () => {
    await writeFreshCache(join(cacheDir, 'k.json'), 'another-key', { v: 1 })
    let calls = 0

    const result = await cacheCompute({
      cacheDir,
      cacheKey: 'k',
      ttlSeconds: 300,
      compute: async () => {
        calls++
        return { v: 2 }
      },
    })

    expect(result).toEqual({ v: 2 })
    expect(calls).toBe(1)
    const rewritten = JSON.parse(await readFile(join(cacheDir, 'k.json'), 'utf-8')) as CacheEntry
    expect(rewritten.url).toBe('k')
  })

  it('force:true bypasses cache even when fresh', async () => {
    let calls = 0
    const compute = async () => ({ v: ++calls })
    await cacheCompute({ cacheDir, cacheKey: 'k', ttlSeconds: 300, compute })
    const refreshed = await cacheCompute({
      cacheDir,
      cacheKey: 'k',
      ttlSeconds: 300,
      force: true,
      compute,
    })
    expect(refreshed.v).toBe(2)
    expect(calls).toBe(2)
  })

  it('clamps ttl to MIN_CACHE_SECONDS', async () => {
    await cacheCompute({ cacheDir, cacheKey: 'k', ttlSeconds: 1, compute: async () => ({}) })
    const cached = JSON.parse(
      await readFile(join(cacheDir, 'k.json'), 'utf-8'),
    ) as CacheEntry<unknown>
    expect(cached.expires_at - cached.fetched_at).toBe(MIN_CACHE_SECONDS * 1000)
  })

  it('throws when computed value fails the supplied schema (and does not write cache)', async () => {
    const schema = z.object({ count: z.number() })
    await expect(
      cacheCompute({
        cacheDir,
        cacheKey: 'k',
        ttlSeconds: 60,
        schema,
        compute: async () => ({ count: 'oops' }) as unknown as { count: number },
      }),
    ).rejects.toThrow(/computed value failed schema/)

    const exists = await readFile(join(cacheDir, 'k.json'), 'utf-8').then(
      () => true,
      () => false,
    )
    expect(exists).toBe(false)
  })
})

// The message is the only field incur's error envelope surfaces (it emits
// {code, message, retryable} and drops `context`), so a configured proxy has
// to be named there. Profile discovery is the first network call in any flow,
// which makes this the most likely place a proxy failure shows up — and
// without the annotation it is indistinguishable from a dead merchant.
describe('fetchCached — proxy annotation on transport failure', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-cache-proxy-test-'))
    clearProxyEnv(vi.stubEnv)
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    resetProxyStateForTests()
  })

  const rejectingFetch = () =>
    vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof globalThis.fetch

  it('names the proxy in the message when one is configured', async () => {
    vi.stubEnv('https_proxy', 'http://proxy.example:3128')
    await installProxyDispatcher()
    await expect(
      fetchCached('https://example.com/x', {
        cacheDir,
        errorCodes: codes,
        fetch: rejectingFetch(),
      }),
    ).rejects.toMatchObject({
      code: 'TEST_FETCH_FAILED',
      message: expect.stringContaining('proxy: enabled'),
      retryable: true,
    })
  })

  it('annotates a filtering-proxy block page returned as an HTTP error', async () => {
    // Zscaler/Squid answer on the merchant's behalf with their own 403. The
    // status is the proxy's, so attributing it to the merchant is a misread.
    vi.stubEnv('https_proxy', 'http://proxy.example:3128')
    await installProxyDispatcher()
    const blocked = vi.fn(
      async () => new Response('<html>blocked by policy</html>', { status: 403 }),
    ) as unknown as typeof globalThis.fetch
    await expect(
      fetchCached('https://example.com/x', { cacheDir, errorCodes: codes, fetch: blocked }),
    ).rejects.toMatchObject({
      code: 'TEST_FETCH_FAILED',
      message: expect.stringContaining('proxy: enabled'),
    })
  })

  it('annotates a captive-portal HTML page served with HTTP 200', async () => {
    // The likeliest symptom of all, and the one that looks least like a proxy
    // problem: 200 OK, bytes on the wire, HTML where JSON was expected.
    vi.stubEnv('https_proxy', 'http://proxy.example:3128')
    await installProxyDispatcher()
    const captive = vi.fn(
      async () =>
        new Response('<html>sign in to continue</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    ) as unknown as typeof globalThis.fetch
    await expect(
      fetchCached('https://example.com/x', { cacheDir, errorCodes: codes, fetch: captive }),
    ).rejects.toMatchObject({
      code: 'TEST_INVALID_JSON',
      message: expect.stringContaining('proxy: enabled'),
    })
  })

  it('adds nothing to the message when no proxy is configured', async () => {
    await installProxyDispatcher()
    await expect(
      fetchCached('https://example.com/x', {
        cacheDir,
        errorCodes: codes,
        fetch: rejectingFetch(),
      }),
    ).rejects.toMatchObject({
      code: 'TEST_FETCH_FAILED',
      message: expect.not.stringContaining('proxy'),
    })
  })
})
