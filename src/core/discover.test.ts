// discover.ts composition tests.
//
// Profile parsing, negotiation, MCP transport, and cache primitives have their
// own suites; this file protects the cross-layer shape: agent identity in,
// verbatim business profile plus negotiated dispatch view out, and the
// two-layer cache behavior for profile + tools/list.
//
// Tests inject singleton DIY Profiles or exercise the implicit managed
// Profile. Discovery reads the Business offer before selecting one exact
// rendering; there is no range or date-order inference in this file.
//
// Scenario names (S3′, S4, S5, S6, S8) refer to the negotiation design doc's
// consumer-experience section.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { profileFixture, rendering } from '../test-utils.js'
import { urlToFilename } from './cache.js'
import { discover } from './discover.js'
import { RELEASES } from './releases.js'
import { setVerboseWriter } from './verbose.js'

const BUSINESS_URL = 'https://shop.example.invalid'
const MCP_ENDPOINT = 'https://shop.example.invalid/ucp/mcp'

/** The default identity: Shopify's published agent profile for the latest release. */
const PROFILE = profileFixture({ version: '2026-08-25' })
/** Same binary, other profile. S3′ / S6 use this one. */
const PROFILE_0408 = profileFixture({ version: '2026-04-08', name: 'agent-0408' })

const SAMPLE_PROFILE = {
  ucp: {
    version: '2026-08-25',
    services: {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp', endpoint: MCP_ENDPOINT }],
    },
    payment_handlers: {},
  },
}

/** The 2026-04-08 rendering of the same business (S3′). */
const SAMPLE_PROFILE_0408 = {
  ucp: {
    version: '2026-04-08',
    services: {
      'dev.ucp.shopping': [
        { version: '2026-04-08', transport: 'mcp', endpoint: MCP_ENDPOINT },
        { version: '2026-04-08', transport: 'embedded', endpoint: MCP_ENDPOINT },
      ],
    },
    payment_handlers: {},
  },
}

const SAMPLE_TOOLS_LIST = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    tools: [
      {
        name: 'search_catalog',
        description: 'Find products',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        name: 'get_product',
        inputSchema: { type: 'object' },
      },
    ],
  },
}

interface MockFetchOpts {
  /** Body returned for `/.well-known/ucp` (defaults to SAMPLE_PROFILE). */
  profile?: object
  profileCacheControl?: string
  /** Body returned for the JSON-RPC POST (defaults to SAMPLE_TOOLS_LIST). */
  toolsList?: object
  /**
   * Bodies served at `/.well-known/ucp/<version>` (the `supported_versions`
   * leaves), keyed by version. Unlisted versions 404.
   */
  versionedProfiles?: Record<string, object>
}

function mockFetch(opts: MockFetchOpts = {}): {
  fetch: typeof fetch
  calls: { url: string; method: string; body?: unknown }[]
} {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url)
    const requestBody =
      typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    calls.push({
      url: u,
      method: init.method ?? 'GET',
      ...(requestBody !== undefined ? { body: requestBody } : {}),
    })
    if (u.endsWith('/.well-known/ucp')) {
      return new Response(JSON.stringify(opts.profile ?? SAMPLE_PROFILE), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': opts.profileCacheControl ?? 'max-age=300',
        },
      })
    }
    const versioned = /\/\.well-known\/ucp\/([^/]+)$/.exec(u)
    if (versioned !== null) {
      const body = opts.versionedProfiles?.[versioned[1] as string]
      if (body === undefined) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
      })
    }
    const requestId =
      typeof (requestBody as { id?: unknown } | undefined)?.id === 'string' ||
      typeof (requestBody as { id?: unknown } | undefined)?.id === 'number'
        ? ((requestBody as { id: string | number }).id as string | number)
        : 1
    const toolsList =
      opts.toolsList === undefined
        ? { ...SAMPLE_TOOLS_LIST, id: requestId }
        : { ...(opts.toolsList as Record<string, unknown>), id: requestId }
    return new Response(JSON.stringify(toolsList), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

describe('discover — composition', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-discover-test-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('returns verbatim profile + dispatch view keyed by capability and tool name', async () => {
    const { fetch } = mockFetch()
    const result = await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })

    expect(result.business).toBe('https://shop.example.invalid')
    expect(result.profile.ucp.version).toBe('2026-08-25')

    const shopping = result.negotiated['dev.ucp.shopping']
    if (shopping === undefined) throw new Error('expected shopping capability')
    expect(shopping.version).toBe('2026-08-25')
    expect(shopping.transport).toBe('mcp')
    expect(shopping.endpoint).toBe(MCP_ENDPOINT)
    expect(Object.keys(shopping.tools).sort()).toEqual(['get_product', 'search_catalog'])
    expect(shopping.tools.search_catalog?.description).toBe('Find products')
    expect(shopping.tools.search_catalog?.inputSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
    })
  })

  it('reports which document supplied the rendering and at what version', async () => {
    const { fetch } = mockFetch()
    const result = await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })

    // No `businessVersion`: `source` already carries that bit, and a second
    // date invites date-order compatibility inference.
    expect(result.protocol).toEqual({
      version: '2026-08-25',
      source: 'well-known',
      agentProfileUrl: rendering(PROFILE, '2026-08-25').url,
      businessProfileUrl: `${BUSINESS_URL}/.well-known/ucp`,
    })
  })

  it('expectedCapabilities is the advisory agent ∩ business intersection', async () => {
    const profile = {
      ucp: {
        ...SAMPLE_PROFILE.ucp,
        capabilities: {
          // Two the default agent profile declares…
          'dev.ucp.shopping.cart': [{ version: '2026-08-25' }],
          'dev.shopify.catalog': [{ version: '2026-08-25' }],
          // …and one it does not.
          'com.acme.loyalty': [{ version: '2026-08-25' }],
        },
      },
    }
    const { fetch } = mockFetch({ profile })
    const result = await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })

    expect([...result.expectedCapabilities].sort()).toEqual([
      'dev.shopify.catalog',
      'dev.ucp.shopping.cart',
    ])
    // Lossless: the business's own capability stays visible in `profile`.
    expect(Object.keys(result.profile.ucp.capabilities ?? {}).includes('com.acme.loyalty')).toBe(
      true,
    )
  })

  it('a SELF-DECLARED third-party capability reaches expectedCapabilities', async () => {
    // The case a compile-time-frozen CTA allowlist would make invisible: a
    // user who declares `com.acme.loyalty` in their own hosted profile,
    // against a business that advertises it. The server negotiates it (it
    // fetches the same document); `expectedCapabilities` is the client-side
    // prediction the CTA layer reads, so it must contain it.
    const runtimeProfile = profileFixture({
      version: '2026-08-25',
      url: 'https://you.example/agent.json',
      name: 'mine',
      services: { 'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }] },
      capabilities: {
        'dev.ucp.shopping.cart': [{ version: '2026-08-25' }],
        'com.acme.loyalty': [{ version: '2025-11-01' }],
      },
    })
    const profile = {
      ucp: {
        ...SAMPLE_PROFILE.ucp,
        capabilities: {
          'dev.ucp.shopping.cart': [{ version: '2026-08-25' }],
          'com.acme.loyalty': [{ version: '2025-11-01' }],
        },
      },
    }
    const { fetch } = mockFetch({ profile })
    const result = await discover(BUSINESS_URL, { cacheDir, profile: runtimeProfile, fetch })

    expect([...result.expectedCapabilities].sort()).toEqual([
      'com.acme.loyalty',
      'dev.ucp.shopping.cart',
    ])
  })

  it('issues exactly one profile fetch + one tools/list per capability', async () => {
    const { fetch, calls } = mockFetch()
    await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })

    const profileCalls = calls.filter((c) => c.url.endsWith('/.well-known/ucp'))
    const rpcCalls = calls.filter((c) => c.method === 'POST')
    expect(profileCalls).toHaveLength(1)
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]?.url).toBe(MCP_ENDPOINT)
  })

  it('sends the selected AgentProfile URL in tools/list metadata', async () => {
    const selectedUrl = 'https://agent.example.invalid/selected.json'
    const { fetch, calls } = mockFetch()
    const result = await discover(BUSINESS_URL, {
      cacheDir,
      profile: profileFixture({ version: '2026-08-25', url: selectedUrl }),
      fetch,
    })

    const rpc = calls.find((call) => call.method === 'POST')
    expect(result.protocol.agentProfileUrl).toBe(selectedUrl)
    expect(rpc?.body).toMatchObject({
      method: 'tools/list',
      params: { arguments: { meta: { 'ucp-agent': { profile: selectedUrl } } } },
    })
  })

  it('respects an explicit capability filter', async () => {
    const profile = {
      ucp: {
        version: '2026-08-25',
        services: {
          'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp', endpoint: MCP_ENDPOINT }],
          'dev.ucp.checkout': [
            {
              version: '2026-08-25',
              transport: 'mcp',
              endpoint: 'https://shop.example.invalid/ucp/checkout-mcp',
            },
          ],
        },
        payment_handlers: {},
      },
    }
    const { fetch, calls } = mockFetch({ profile })
    const result = await discover(BUSINESS_URL, {
      cacheDir,
      profile: PROFILE,
      capabilities: ['dev.ucp.shopping'],
      fetch,
    })

    expect(Object.keys(result.negotiated)).toEqual(['dev.ucp.shopping'])
    const rpcCalls = calls.filter((c) => c.method === 'POST')
    expect(rpcCalls.map((c) => c.url)).toEqual([MCP_ENDPOINT])
  })

  it('bare discover negotiates the declared intersection and leaves the rest in `profile`', async () => {
    // A business service the profile does not declare has no platform side to
    // negotiate with. It is not an error, and it is not lost — but it must not
    // be SILENT either: the adjacent stale-version case vlogs, and without a
    // line here "the business advertises it and `negotiated` has no entry" is
    // indistinguishable from a bug.
    const lines: string[] = []
    setVerboseWriter((msg) => {
      lines.push(msg)
    })
    const profile = {
      ucp: {
        version: '2026-08-25',
        services: {
          'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp', endpoint: MCP_ENDPOINT }],
          'com.other.x': [
            {
              version: '2026-08-25',
              transport: 'mcp',
              endpoint: 'https://shop.example.invalid/ucp/other',
            },
          ],
        },
        payment_handlers: {},
      },
    }
    const { fetch, calls } = mockFetch({ profile })
    const result = await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })

    expect(Object.keys(result.negotiated)).toEqual(['dev.ucp.shopping'])
    expect(Object.keys(result.profile.ucp.services ?? {}).sort()).toEqual([
      'com.other.x',
      'dev.ucp.shopping',
    ])
    // No tools/list against the undeclared service's endpoint.
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([MCP_ENDPOINT])
    expect(lines.join('')).toContain('not negotiating [com.other.x]')
    expect(lines.join('')).toContain('declares no service entry for them')
    setVerboseWriter(null)
  })

  it('does not log an exclusion when the agent declares everything the business offers', async () => {
    const lines: string[] = []
    setVerboseWriter((msg) => {
      lines.push(msg)
    })
    const { fetch } = mockFetch()
    await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })
    expect(lines.join('')).not.toContain('not negotiating')
    setVerboseWriter(null)
  })

  it('explicitly requesting a service the business offers and we do not declare is AGENT_PROFILE_SERVICE_UNDECLARED', async () => {
    const profile = {
      ucp: {
        version: '2026-08-25',
        services: {
          'com.other.x': [
            {
              version: '2026-08-25',
              transport: 'mcp',
              endpoint: 'https://shop.example.invalid/ucp/other',
            },
          ],
        },
        payment_handlers: {},
      },
    }
    const { fetch } = mockFetch({ profile })
    await expect(
      discover(BUSINESS_URL, {
        cacheDir,
        profile: PROFILE,
        capabilities: ['com.other.x'],
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_PROFILE_SERVICE_UNDECLARED', layer: 'client' })
  })

  it('uses managed when the caller supplies no Profile', async () => {
    const { fetch } = mockFetch()
    const result = await discover(BUSINESS_URL, { cacheDir, fetch })

    expect(result.protocol.version).toBe('2026-08-25')
  })
})

// ─── Local Profile resolution costs no round trip ────────────────────────
//
// Session resolution materializes a named DIY Profile before discovery. The
// identity therefore adds no pre-flight fetch; only Business GETs and MCP
// POSTs appear here.
describe('discover — the agent identity never costs a request', () => {
  const SELF_HOSTED = 'https://agent.example.invalid/agent.json'
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-discover-test-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('uses a release-default DIY rendering with Business traffic only', async () => {
    const { fetch, calls } = mockFetch()
    const result = await discover(BUSINESS_URL, {
      cacheDir,
      fetch,
      profile: profileFixture({ version: '2026-08-25' }),
    })

    expect(result.protocol.version).toBe('2026-08-25')
    expect(calls.map((c) => c.url)).toEqual([`${BUSINESS_URL}/.well-known/ucp`, MCP_ENDPOINT])
  })

  it('uses a self-hosted singleton rendering with Business traffic only', async () => {
    const leafUrl = `${BUSINESS_URL}/.well-known/ucp/2026-04-08`
    const { fetch, calls } = mockFetch({
      profile: { ucp: { ...SAMPLE_PROFILE.ucp, supported_versions: { '2026-04-08': leafUrl } } },
      versionedProfiles: { '2026-04-08': SAMPLE_PROFILE_0408 },
    })

    const result = await discover(BUSINESS_URL, {
      cacheDir,
      fetch,
      profile: profileFixture({ version: '2026-04-08', name: 'mine', url: SELF_HOSTED }),
    })

    expect(result.protocol.version).toBe('2026-04-08')
    expect(result.protocol.agentProfileUrl).toBe(SELF_HOSTED)
    expect(calls.map((c) => c.url)).toEqual([
      `${BUSINESS_URL}/.well-known/ucp`,
      leafUrl,
      MCP_ENDPOINT,
    ])
  })
})

describe('discover — caching', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-discover-test-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('writes tools/list under a negotiation-scoped hash', async () => {
    const { fetch } = mockFetch()
    await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })

    const toolsDir = join(cacheDir, 'toolslist', 'shop.example.invalid')
    const entries = await readdir(toolsDir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^[a-f0-9]{64}\.json$/)
    const cached = JSON.parse(await readFile(join(toolsDir, entries[0] as string), 'utf-8')) as {
      body: { tools: { name: string }[] }
    }
    expect(cached.body.tools.map((t) => t.name).sort()).toEqual(['get_product', 'search_catalog'])
  })

  it('second discover call hits caches — no network', async () => {
    const { fetch, calls } = mockFetch()
    await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })
    await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })
    // 1 profile + 1 tools/list, total 2 — second call is fully cached.
    expect(calls).toHaveLength(2)
  })

  it('force:true re-issues both profile and tools/list', async () => {
    const { fetch, calls } = mockFetch()
    await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })
    await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch, force: true })
    const profileCalls = calls.filter((c) => c.url.endsWith('/.well-known/ucp'))
    const rpcCalls = calls.filter((c) => c.method === 'POST')
    expect(profileCalls).toHaveLength(2)
    expect(rpcCalls).toHaveLength(2)
  })

  const toolsResult = (name: string) => ({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [{ name, inputSchema: { type: 'object' } }] },
  })

  it('does not reuse tools/list across selected protocol versions', async () => {
    const sharedUrl = 'https://agent.example.invalid/shared.json'
    const first = mockFetch({
      profile: SAMPLE_PROFILE_0408,
      profileCacheControl: 'no-store',
      toolsList: toolsResult('from_0408'),
    })
    await discover(BUSINESS_URL, {
      cacheDir,
      profile: profileFixture({ version: '2026-04-08', url: sharedUrl }),
      fetch: first.fetch,
    })

    const second = mockFetch({
      profile: SAMPLE_PROFILE,
      profileCacheControl: 'no-store',
      toolsList: toolsResult('from_0825'),
    })
    const result = await discover(BUSINESS_URL, {
      cacheDir,
      profile: profileFixture({ version: '2026-08-25', url: sharedUrl }),
      fetch: second.fetch,
    })

    expect(Object.keys(result.negotiated['dev.ucp.shopping']?.tools ?? {})).toEqual(['from_0825'])
    expect(second.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('does not reuse tools/list across selected AgentProfile URLs', async () => {
    const first = mockFetch({
      profileCacheControl: 'no-store',
      toolsList: toolsResult('from_first_profile'),
    })
    await discover(BUSINESS_URL, {
      cacheDir,
      profile: profileFixture({ url: 'https://agent.example.invalid/first.json' }),
      fetch: first.fetch,
    })

    const second = mockFetch({
      profileCacheControl: 'no-store',
      toolsList: toolsResult('from_second_profile'),
    })
    const result = await discover(BUSINESS_URL, {
      cacheDir,
      profile: profileFixture({ url: 'https://agent.example.invalid/second.json' }),
      fetch: second.fetch,
    })

    expect(Object.keys(result.negotiated['dev.ucp.shopping']?.tools ?? {})).toEqual([
      'from_second_profile',
    ])
    expect(second.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('does not reuse tools/list across full endpoints', async () => {
    const selectedProfile = profileFixture({ url: 'https://agent.example.invalid/shared.json' })
    const profileAt = (endpoint: string) => ({
      ucp: {
        ...SAMPLE_PROFILE.ucp,
        services: {
          'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp', endpoint }],
        },
      },
    })
    const first = mockFetch({
      profile: profileAt(`${MCP_ENDPOINT}?tenant=first`),
      profileCacheControl: 'no-store',
      toolsList: toolsResult('from_first_endpoint'),
    })
    await discover(BUSINESS_URL, { cacheDir, profile: selectedProfile, fetch: first.fetch })

    const second = mockFetch({
      profile: profileAt(`${MCP_ENDPOINT}?tenant=second`),
      profileCacheControl: 'no-store',
      toolsList: toolsResult('from_second_endpoint'),
    })
    const result = await discover(BUSINESS_URL, {
      cacheDir,
      profile: selectedProfile,
      fetch: second.fetch,
    })

    expect(Object.keys(result.negotiated['dev.ucp.shopping']?.tools ?? {})).toEqual([
      'from_second_endpoint',
    ])
    expect(second.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })
})

describe('discover — error propagation', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-discover-test-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('requesting a fine-grained CAPABILITY id the business does not offer as a service says so', async () => {
    // `dev.ucp.shopping.checkout` is a capability (a feature flag the server
    // negotiates), not a service (a dispatch endpoint). The profile declares
    // it — just not in `ucp.services`. The business does not offer it as a
    // service either, so by the 3a truth table this is CAPABILITY_NOT_OFFERED
    // (nothing the user can add to their profile makes the call work); the
    // capability-vs-service diagnosis rides along in the message.
    const { fetch } = mockFetch()
    await expect(
      discover(BUSINESS_URL, {
        cacheDir,
        profile: PROFILE,
        capabilities: ['dev.ucp.shopping.checkout'],
        fetch,
      }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_OFFERED',
      message: expect.stringContaining('as a capability, not a service') as unknown as string,
    })
  })

  it('CAPABILITY_NOT_OFFERED when the profile declares a service the business omits', async () => {
    const runtimeProfile = profileFixture({
      version: '2026-08-25',
      services: {
        'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
        'com.acme.svc': [{ version: '2025-11-01', transport: 'mcp' }],
      },
    })
    const { fetch } = mockFetch()
    await expect(
      discover(BUSINESS_URL, {
        cacheDir,
        profile: runtimeProfile,
        capabilities: ['com.acme.svc'],
        fetch,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_NOT_OFFERED' }) as unknown as Error,
    )
  })

  it('throws SERVICE_ENDPOINT_MISSING when the negotiated entry has no endpoint', async () => {
    const profile = {
      ucp: {
        version: '2026-08-25',
        services: {
          'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
        },
        payment_handlers: {},
      },
    }
    const { fetch } = mockFetch({ profile })
    await expect(
      discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'SERVICE_ENDPOINT_MISSING',
        layer: 'transport',
      }) as unknown as Error,
    )
  })

  it('surfaces tools/list shape failures (e.g. tools is not an array)', async () => {
    const { fetch } = mockFetch({
      toolsList: { jsonrpc: '2.0', id: 1, result: { tools: 'oops' } },
    })
    await expect(discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })).rejects.toThrow(
      /tools/,
    )
  })

  it('surfaces tools/list transport failures with their original error code', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/.well-known/ucp')) {
        return new Response(JSON.stringify(SAMPLE_PROFILE), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
        })
      }
      return new Response('boom', { status: 503 })
    }) as unknown as typeof globalThis.fetch

    await expect(
      discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'SERVICE_UNAVAILABLE',
        http_status: 503,
      }) as unknown as Error,
    )
  })

  it('rejects non-https business URLs', async () => {
    const { fetch } = mockFetch()
    await expect(
      discover('http://shop.example.invalid', { cacheDir, profile: PROFILE, fetch }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', layer: 'client' }) as unknown as Error,
    )
  })

  it('sanitizes cache key for capabilities that are not filesystem-safe', async () => {
    const unsafeCapability = '../bad'
    const runtimeProfile = profileFixture({
      version: '2026-08-25',
      services: { [unsafeCapability]: [{ version: '2026-08-25', transport: 'mcp' }] },
    })
    const profile = {
      ucp: {
        version: '2026-08-25',
        services: {
          [unsafeCapability]: [{ version: '2026-08-25', transport: 'mcp', endpoint: MCP_ENDPOINT }],
        },
        payment_handlers: {},
      },
    }
    const { fetch } = mockFetch({ profile })
    await discover(BUSINESS_URL, {
      cacheDir,
      profile: runtimeProfile,
      fetch,
      capabilities: [unsafeCapability],
    })
    const toolsDir = join(cacheDir, 'toolslist', 'shop.example.invalid')
    const entries = await readdir(toolsDir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^[a-f0-9]{64}\.json$/)
  })
})

// ─── Step 1: exact-version business selection ────────────────────────────
//
// The business offers `{ucp.version} ∪ keys(supported_versions)`. The agent
// profile's version must be IN that set — never "close enough by date". When
// it is not the top-level rendering, the leaf for that exact version is
// fetched and MUST declare the version it was linked as.

describe('discover — supported_versions selection', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-discover-sv-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
    setVerboseWriter(null)
  })

  const LEAF_0408_URL = `${BUSINESS_URL}/.well-known/ucp/2026-04-08`
  const LEAF_0825_URL = `${BUSINESS_URL}/.well-known/ucp/2026-08-25`

  /** racing.shop today: 08-25 at the root, older renderings linked. */
  const TOP_0825 = {
    ucp: {
      ...SAMPLE_PROFILE.ucp,
      supported_versions: {
        '2026-04-08': LEAF_0408_URL,
        '2026-01-23': `${BUSINESS_URL}/.well-known/ucp/2026-01-23`,
      },
    },
  }

  /** S4: a release ucp-cli has never heard of, still linking ours. */
  const TOP_FUTURE = {
    ucp: {
      version: '2026-12-01',
      supported_versions: { '2026-08-25': LEAF_0825_URL, '2026-04-08': LEAF_0408_URL },
      services: {
        'dev.ucp.shopping': [{ version: '2026-12-01', transport: 'mcp', endpoint: MCP_ENDPOINT }],
      },
      payment_handlers: {},
    },
  }

  it.each([
    {
      name: '04-only',
      root: SAMPLE_PROFILE_0408,
      leaves: {},
      version: '2026-04-08' as const,
      source: 'well-known' as const,
    },
    {
      name: '08-only',
      root: SAMPLE_PROFILE,
      leaves: {},
      version: '2026-08-25' as const,
      source: 'well-known' as const,
    },
    {
      name: 'both chooses newest',
      root: {
        ucp: {
          ...SAMPLE_PROFILE_0408.ucp,
          supported_versions: { '2026-08-25': LEAF_0825_URL },
        },
      },
      leaves: { '2026-08-25': SAMPLE_PROFILE },
      version: '2026-08-25' as const,
      source: 'supported_versions' as const,
    },
    {
      name: 'future root with known leaves chooses newest leaf',
      root: TOP_FUTURE,
      leaves: { '2026-08-25': SAMPLE_PROFILE, '2026-04-08': SAMPLE_PROFILE_0408 },
      version: '2026-08-25' as const,
      source: 'supported_versions' as const,
    },
  ])('managed discovery: $name', async ({ root, leaves, version, source }) => {
    const { fetch } = mockFetch({ profile: root, versionedProfiles: leaves })
    const result = await discover(BUSINESS_URL, { cacheDir, fetch })

    expect(result.protocol).toMatchObject({
      version,
      source,
      agentProfileUrl: RELEASES[version].defaultAgentProfileUrl,
    })
  })

  it('managed discovery rejects a future-only Business before any MCP POST', async () => {
    const { supported_versions: _omitted, ...futureOnly } = TOP_FUTURE.ucp
    const { fetch, calls } = mockFetch({ profile: { ucp: futureOnly } })

    await expect(discover(BUSINESS_URL, { cacheDir, fetch })).rejects.toMatchObject({
      code: 'PROTOCOL_VERSION_INCOMPATIBLE',
      message: expect.stringContaining(
        "managed Profile already offers every rendering installed in this ucp-cli build, so no local Profile using this build's installed versions can recover",
      ),
      context: {
        offered: ['2026-12-01'],
        profileVersions: ['2026-04-08', '2026-08-25'],
        profileSource: 'managed',
      },
    })
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('does not fall back to an older root when the selected newest leaf fails', async () => {
    const root = {
      ucp: {
        ...SAMPLE_PROFILE_0408.ucp,
        supported_versions: { '2026-08-25': LEAF_0825_URL },
      },
    }
    const { fetch, calls } = mockFetch({ profile: root, versionedProfiles: {} })

    await expect(discover(BUSINESS_URL, { cacheDir, fetch })).rejects.toMatchObject({
      code: 'PROFILE_FETCH_FAILED',
    })
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', `${BUSINESS_URL}/.well-known/ucp`],
      ['GET', LEAF_0825_URL],
    ])
  })

  it('S3′: the 04-08 profile negotiates at 04-08 through the leaf — same binary', async () => {
    const { fetch, calls } = mockFetch({
      profile: TOP_0825,
      versionedProfiles: { '2026-04-08': SAMPLE_PROFILE_0408 },
    })
    const result = await discover(BUSINESS_URL, { cacheDir, profile: PROFILE_0408, fetch })

    expect(result.protocol).toEqual({
      version: '2026-04-08',
      source: 'supported_versions',
      agentProfileUrl: rendering(PROFILE_0408, '2026-04-08').url,
      businessProfileUrl: LEAF_0408_URL,
    })
    expect(result.profile.ucp.version).toBe('2026-04-08')
    expect(result.negotiated['dev.ucp.shopping']?.version).toBe('2026-04-08')
    expect(result.negotiated['dev.ucp.shopping']?.transport).toBe('mcp')
    // Exactly two GETs: the well-known document, then the leaf for OUR version.
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([
      `${BUSINESS_URL}/.well-known/ucp`,
      LEAF_0408_URL,
    ])
  })

  it('S3: the 08-25 profile against the same business stays on the top-level document', async () => {
    const { fetch, calls } = mockFetch({
      profile: TOP_0825,
      versionedProfiles: { '2026-04-08': SAMPLE_PROFILE_0408 },
    })
    const result = await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })

    expect(result.protocol.source).toBe('well-known')
    expect(result.protocol.version).toBe('2026-08-25')
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([
      `${BUSINESS_URL}/.well-known/ucp`,
    ])
  })

  it('S4: a business one release AHEAD still negotiates — this is the outage that cannot recur', async () => {
    // /.well-known/ucp is UCP 2026-12-01, a release ucp-cli does not support.
    // It offers 2026-08-25 as a leaf, so we speak 2026-08-25.
    const { fetch } = mockFetch({
      profile: TOP_FUTURE,
      versionedProfiles: { '2026-08-25': SAMPLE_PROFILE },
    })
    const result = await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })

    expect(result.protocol).toEqual({
      version: '2026-08-25',
      source: 'supported_versions',
      agentProfileUrl: rendering(PROFILE, '2026-08-25').url,
      businessProfileUrl: LEAF_0825_URL,
    })
    expect(result.negotiated['dev.ucp.shopping']?.endpoint).toBe(MCP_ENDPOINT)
  })

  it('caches the versioned rendering separately from the top-level document', async () => {
    const { fetch, calls } = mockFetch({
      profile: TOP_FUTURE,
      versionedProfiles: { '2026-08-25': SAMPLE_PROFILE },
    })
    await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })
    const firstPass = calls.length

    const topUrl = `${BUSINESS_URL}/.well-known/ucp`
    const top = JSON.parse(
      await readFile(join(cacheDir, 'businesses', `${urlToFilename(topUrl)}.json`), 'utf8'),
    ) as { body: { ucp: { version: string } } }
    const leaf = JSON.parse(
      await readFile(
        join(cacheDir, 'businesses', '2026-08-25', `${urlToFilename(LEAF_0825_URL)}.json`),
        'utf8',
      ),
    ) as { body: { ucp: { version: string } } }
    expect(top.body.ucp.version).toBe('2026-12-01')
    expect(leaf.body.ucp.version).toBe('2026-08-25')

    await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })
    expect(calls.length).toBe(firstPass)
  })

  it('S5: business at a single unknown release → PROTOCOL_VERSION_INCOMPATIBLE naming both sets', async () => {
    const { supported_versions: _omit, ...ucp } = TOP_FUTURE.ucp
    const { fetch } = mockFetch({ profile: { ucp } })
    await expect(
      discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch }),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_VERSION_INCOMPATIBLE',
      layer: 'transport',
      message:
        "https://shop.example.invalid offers UCP 2026-12-01; profile 'agent' offers 2026-08-25. ucp-cli supports 2026-04-08, 2026-08-25. A DIY Profile is pinned to this one rendering.",
      context: {
        businessVersion: '2026-12-01',
        offered: ['2026-12-01'],
        supported: ['2026-04-08', '2026-08-25'],
        profileSource: 'diy',
        profileUrlOverride: false,
        agentVersion: '2026-08-25',
      },
    })
  })

  it('reports explicit URL precedence independently from a DIY body source', async () => {
    const { fetch } = mockFetch({ profile: SAMPLE_PROFILE_0408 })
    const overridden = profileFixture({
      version: '2026-08-25',
      url: 'https://agent.example.invalid/override.json',
      urlOverride: true,
    })

    await expect(
      discover(BUSINESS_URL, { cacheDir, profile: overridden, fetch }),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_VERSION_INCOMPATIBLE',
      message: expect.stringContaining(
        'Remove --profile-url/UCP_AGENT_PROFILE_URL or make that URL serve the intended exact authored/bundled rendering',
      ),
      context: {
        offered: ['2026-04-08'],
        profileSource: 'diy',
        profileUrlOverride: true,
        agentVersion: '2026-08-25',
      },
    })
  })

  it('S6: business behind us, no leaf for our version → PROTOCOL_VERSION_INCOMPATIBLE', async () => {
    // The recovery is switching profiles, not upgrading the CLI: AGENT_0408
    // would negotiate with this same business.
    const { fetch } = mockFetch({ profile: SAMPLE_PROFILE_0408 })
    await expect(
      discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch }),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_VERSION_INCOMPATIBLE',
      context: {
        offered: ['2026-04-08'],
        profileSource: 'diy',
        agentVersion: '2026-08-25',
      },
    })
    const { fetch: fetch2 } = mockFetch({ profile: SAMPLE_PROFILE_0408 })
    const ok = await discover(BUSINESS_URL, { cacheDir, profile: PROFILE_0408, fetch: fetch2 })
    expect(ok.protocol).toMatchObject({ version: '2026-04-08', source: 'well-known' })
  })

  it('S8: a leaf that declares a different version is refused (kind: supported_versions)', async () => {
    const { fetch } = mockFetch({
      profile: TOP_0825,
      // Linked as 2026-04-08, declares 2026-08-25.
      versionedProfiles: { '2026-04-08': SAMPLE_PROFILE },
    })
    await expect(
      discover(BUSINESS_URL, { cacheDir, profile: PROFILE_0408, fetch }),
    ).rejects.toMatchObject({
      code: 'PROFILE_VERSION_MISMATCH',
      layer: 'transport',
      context: {
        kind: 'supported_versions',
        expected: '2026-04-08',
        actual: '2026-08-25',
        url: LEAF_0408_URL,
      },
    })
  })

  it('ignores (and logs) a leaf that carries its own supported_versions', async () => {
    const lines: string[] = []
    setVerboseWriter((msg) => {
      lines.push(msg)
    })
    const nested = {
      ucp: {
        ...SAMPLE_PROFILE_0408.ucp,
        supported_versions: { '2026-01-23': `${BUSINESS_URL}/.well-known/ucp/2026-01-23` },
      },
    }
    const { fetch, calls } = mockFetch({
      profile: TOP_0825,
      versionedProfiles: { '2026-04-08': nested },
    })
    const result = await discover(BUSINESS_URL, { cacheDir, profile: PROFILE_0408, fetch })

    expect(result.protocol.version).toBe('2026-04-08')
    expect(lines.join('')).toContain('version-specific documents are leaves')
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2)
  })

  it('reads supported_versions even when the top-level document no longer fits the profile schema', async () => {
    // Envelope-first parse: a future release could reshape the profile body.
    // The fallback must still be reachable, otherwise it cannot do the one
    // job it exists for.
    const profile = { ucp: { ...TOP_FUTURE.ucp, services: 'reshaped' } }
    const { fetch } = mockFetch({ profile, versionedProfiles: { '2026-08-25': SAMPLE_PROFILE } })
    const result = await discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch })
    expect(result.negotiated['dev.ucp.shopping']?.version).toBe('2026-08-25')
  })

  it('still validates a selected top-level document against the full profile schema', async () => {
    const profile = { ...SAMPLE_PROFILE, ucp: { ...SAMPLE_PROFILE.ucp, services: 'reshaped' } }
    const { fetch } = mockFetch({ profile })
    await expect(
      discover(BUSINESS_URL, { cacheDir, profile: PROFILE, fetch }),
    ).rejects.toMatchObject({
      code: 'PROFILE_SCHEMA_INVALID',
      layer: 'transport',
    })
  })

  it('validates the leaf against the AGENT release schema, after the version check', async () => {
    const { fetch } = mockFetch({
      profile: TOP_0825,
      versionedProfiles: {
        '2026-04-08': { ucp: { ...SAMPLE_PROFILE_0408.ucp, services: 'reshaped' } },
      },
    })
    await expect(
      discover(BUSINESS_URL, { cacheDir, profile: PROFILE_0408, fetch }),
    ).rejects.toMatchObject({ code: 'PROFILE_SCHEMA_INVALID', layer: 'transport' })
  })

  it('surfaces a failed leaf fetch as PROFILE_FETCH_FAILED', async () => {
    const { fetch } = mockFetch({ profile: TOP_0825, versionedProfiles: {} })
    await expect(
      discover(BUSINESS_URL, { cacheDir, profile: PROFILE_0408, fetch }),
    ).rejects.toMatchObject({ code: 'PROFILE_FETCH_FAILED' })
  })

  it('rejects a non-https supported_versions URL as PROFILE_SCHEMA_INVALID', async () => {
    const profile = {
      ucp: {
        ...TOP_0825.ucp,
        supported_versions: { '2026-04-08': 'http://shop.example.invalid/.well-known/ucp/0408' },
      },
    }
    const { fetch } = mockFetch({ profile })
    await expect(
      discover(BUSINESS_URL, { cacheDir, profile: PROFILE_0408, fetch }),
    ).rejects.toMatchObject({ code: 'PROFILE_SCHEMA_INVALID', layer: 'transport' })
  })
})
