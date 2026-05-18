// discover.ts unit tests.
//
// These are composition tests. Profile parsing, negotiation, MCP transport, and
// cache primitives have their own suites; this file protects the cross-layer
// shape: verbatim profile plus negotiated dispatch view, and the two-layer
// cache behavior for profile + tools/list.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { discover } from './discover.js'
import type { AgentRange } from './profile.js'

const BUSINESS_URL = 'https://shop.example.invalid'
const MCP_ENDPOINT = 'https://shop.example.invalid/ucp/mcp'
const RANGE: AgentRange = { min: '2026-01-23', max: '2026-04-08' }

const SAMPLE_PROFILE = {
  ucp: {
    version: '2026-04-08',
    services: {
      'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp', endpoint: MCP_ENDPOINT }],
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
}

function mockFetch(opts: MockFetchOpts = {}): {
  fetch: typeof fetch
  calls: { url: string; method: string }[]
} {
  const calls: { url: string; method: string }[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method ?? 'GET' })
    if (u.endsWith('/.well-known/ucp')) {
      return new Response(JSON.stringify(opts.profile ?? SAMPLE_PROFILE), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': opts.profileCacheControl ?? 'max-age=300',
        },
      })
    }
    const requestBody =
      typeof init.body === 'string' ? (JSON.parse(init.body) as { id?: unknown }) : undefined
    const requestId =
      typeof requestBody?.id === 'string' || typeof requestBody?.id === 'number'
        ? requestBody.id
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
    const result = await discover(BUSINESS_URL, { cacheDir, agentRange: RANGE, fetch })

    expect(result.business).toBe('https://shop.example.invalid')
    expect(result.profile.ucp.version).toBe('2026-04-08')

    const shopping = result.negotiated['dev.ucp.shopping']
    if (shopping === undefined) throw new Error('expected shopping capability')
    expect(shopping.version).toBe('2026-04-08')
    expect(shopping.transport).toBe('mcp')
    expect(shopping.endpoint).toBe(MCP_ENDPOINT)
    expect(Object.keys(shopping.tools).sort()).toEqual(['get_product', 'search_catalog'])
    expect(shopping.tools.search_catalog?.description).toBe('Find products')
    expect(shopping.tools.search_catalog?.inputSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
    })
  })

  it('issues exactly one profile fetch + one tools/list per capability', async () => {
    const { fetch, calls } = mockFetch()
    await discover(BUSINESS_URL, { cacheDir, agentRange: RANGE, fetch })

    const profileCalls = calls.filter((c) => c.url.endsWith('/.well-known/ucp'))
    const rpcCalls = calls.filter((c) => c.method === 'POST')
    expect(profileCalls).toHaveLength(1)
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]?.url).toBe(MCP_ENDPOINT)
  })

  it('respects an explicit capability filter', async () => {
    const profile = {
      ucp: {
        version: '2026-04-08',
        services: {
          'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp', endpoint: MCP_ENDPOINT }],
          'dev.ucp.checkout': [
            {
              version: '2026-04-08',
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
      agentRange: RANGE,
      capabilities: ['dev.ucp.shopping'],
      fetch,
    })

    expect(Object.keys(result.negotiated)).toEqual(['dev.ucp.shopping'])
    const rpcCalls = calls.filter((c) => c.method === 'POST')
    expect(rpcCalls.map((c) => c.url)).toEqual([MCP_ENDPOINT])
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

  it('writes tools/list to <cache>/toolslist/<origin>/<capability>.json', async () => {
    const { fetch } = mockFetch()
    await discover(BUSINESS_URL, { cacheDir, agentRange: RANGE, fetch })

    const cacheFile = join(cacheDir, 'toolslist', 'shop.example.invalid', 'dev.ucp.shopping.json')
    const cached = JSON.parse(await readFile(cacheFile, 'utf-8')) as {
      body: { tools: { name: string }[] }
    }
    expect(cached.body.tools.map((t) => t.name).sort()).toEqual(['get_product', 'search_catalog'])
  })

  it('second discover call hits caches — no network', async () => {
    const { fetch, calls } = mockFetch()
    await discover(BUSINESS_URL, { cacheDir, agentRange: RANGE, fetch })
    await discover(BUSINESS_URL, { cacheDir, agentRange: RANGE, fetch })
    // 1 profile + 1 tools/list, total 2 — second call is fully cached.
    expect(calls).toHaveLength(2)
  })

  it('force:true re-issues both profile and tools/list', async () => {
    const { fetch, calls } = mockFetch()
    await discover(BUSINESS_URL, { cacheDir, agentRange: RANGE, fetch })
    await discover(BUSINESS_URL, { cacheDir, agentRange: RANGE, fetch, force: true })
    const profileCalls = calls.filter((c) => c.url.endsWith('/.well-known/ucp'))
    const rpcCalls = calls.filter((c) => c.method === 'POST')
    expect(profileCalls).toHaveLength(2)
    expect(rpcCalls).toHaveLength(2)
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

  it('surfaces negotiation failures (CAPABILITY_NOT_OFFERED) when a requested capability is absent', async () => {
    const { fetch } = mockFetch()
    await expect(
      discover(BUSINESS_URL, {
        cacheDir,
        agentRange: RANGE,
        capabilities: ['dev.ucp.checkout'],
        fetch,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_NOT_OFFERED' }) as unknown as Error,
    )
  })

  it('throws SERVICE_ENDPOINT_MISSING when the negotiated entry has no endpoint', async () => {
    const profile = {
      ucp: {
        version: '2026-04-08',
        services: {
          'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp' }],
        },
        payment_handlers: {},
      },
    }
    const { fetch } = mockFetch({ profile })
    await expect(
      discover(BUSINESS_URL, { cacheDir, agentRange: RANGE, fetch }),
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
    await expect(discover(BUSINESS_URL, { cacheDir, agentRange: RANGE, fetch })).rejects.toThrow(
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
      discover(BUSINESS_URL, { cacheDir, agentRange: RANGE, fetch }),
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
      discover('http://shop.example.invalid', { cacheDir, agentRange: RANGE, fetch }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', layer: 'client' }) as unknown as Error,
    )
  })

  it('sanitizes cache key for capabilities that are not filesystem-safe', async () => {
    const unsafeCapability = '../bad'
    const profile = {
      ucp: {
        version: '2026-04-08',
        services: {
          [unsafeCapability]: [{ version: '2026-04-08', transport: 'mcp', endpoint: MCP_ENDPOINT }],
        },
        payment_handlers: {},
      },
    }
    const { fetch } = mockFetch({ profile })
    await discover(BUSINESS_URL, {
      cacheDir,
      agentRange: RANGE,
      fetch,
      capabilities: [unsafeCapability],
    })
    const toolsDir = join(cacheDir, 'toolslist', 'shop.example.invalid')
    const entries = await readdir(toolsDir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^[a-f0-9]{64}\.json$/)
  })
})
