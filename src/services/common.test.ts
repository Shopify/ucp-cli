// Common service helper tests.
//
// Mirrors shopping.test.ts: every helper in common.ts is a 1-line `serviceOp`
// invocation, so the unique signal per helper is the (capability, tool-name)
// binding. The dispatcher's wire-envelope behavior is pinned in
// operation.test.ts.
//
// Beyond the per-helper table, this file pins the negotiation properties that
// make `dev.ucp.common` its own service rather than an alias for shopping:
//   - a business that serves location tools ONLY under `dev.ucp.shopping` is
//     CAPABILITY_NOT_OFFERED for location helpers (no silent cross-service
//     fallback, even though the tools would be on the same endpoint);
//   - an agent profile that does not declare `dev.ucp.common` fails with
//     AGENT_PROFILE_SERVICE_UNDECLARED — the 2026-04-08 rendering is the real
//     case, since `dev.ucp.common.location.*` first shipped in 2026-08-25.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { profileFixture } from '../test-utils.js'
import { lookupLocations, searchLocations } from './common.js'

const BUSINESS_URL = 'https://shop.example.invalid'
const MCP_ENDPOINT = 'https://shop.example.invalid/api/ucp/mcp'
const PROFILE_URL = 'https://agent.example.com/.well-known/ucp'
// The platform side of negotiation: Shopify's published 2026-08-25 agent
// profile, which declares both `dev.ucp.shopping` and `dev.ucp.common` over mcp.
const RUNTIME_PROFILE = profileFixture({ version: '2026-08-25', url: PROFILE_URL })

// Shopify storefronts advertise both services at one MCP endpoint; mirror that
// so the test proves the helper picks the `dev.ucp.common` entry by service id.
const BUSINESS_PROFILE = {
  ucp: {
    version: '2026-08-25',
    services: {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp', endpoint: MCP_ENDPOINT }],
      'dev.ucp.common': [{ version: '2026-08-25', transport: 'mcp', endpoint: MCP_ENDPOINT }],
    },
    capabilities: {
      'dev.ucp.common.location.search': [{ version: '2026-08-25' }],
      'dev.ucp.common.location.lookup': [{ version: '2026-08-25' }],
    },
    payment_handlers: {},
  },
}

const META = {
  type: 'object',
  required: ['ucp-agent'],
  properties: {
    'ucp-agent': {
      type: 'object',
      required: ['profile'],
      properties: { profile: { type: 'string', format: 'uri' } },
    },
    'idempotency-key': { type: 'string' },
  },
}

// Wire shapes as advertised by a live Shopify storefront (UCP 2026-08-25),
// trimmed to the fields these tests exercise. `additionalProperties: false`
// at top level catches a regression that hoists body fields out of /location.
const SEARCH_LOCATION_BODY = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    distance: {
      type: 'object',
      required: ['center', 'max'],
      properties: {
        center: {
          type: 'object',
          required: ['latitude', 'longitude'],
          properties: {
            latitude: { type: 'number', minimum: -90, maximum: 90 },
            longitude: { type: 'number', minimum: -180, maximum: 180 },
          },
        },
        max: { type: 'number', minimum: 0 },
      },
    },
    filters: {
      type: 'object',
      properties: { items: { type: 'array', minItems: 1, items: { type: 'string' } } },
    },
    pagination: {
      type: 'object',
      properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
    },
  },
}
const LOOKUP_LOCATION_BODY = {
  type: 'object',
  required: ['ids'],
  properties: {
    ids: { type: 'array', minItems: 1, items: { type: 'string' } },
    filters: SEARCH_LOCATION_BODY.properties.filters,
  },
}

function topLevel(props: Record<string, object>, required = Object.keys(props)) {
  return { type: 'object', required, additionalProperties: false, properties: props }
}

interface Row {
  fn: typeof searchLocations
  tool: string
  input: Record<string, unknown>
  schema: object
}

const ROWS: Row[] = [
  {
    fn: searchLocations,
    tool: 'search_locations',
    input: {
      location: {
        query: 'New York',
        distance: { center: { latitude: 40.7128, longitude: -74.006 }, max: 10000 },
        pagination: { limit: 5 },
      },
    },
    schema: topLevel({ meta: META, location: SEARCH_LOCATION_BODY }),
  },
  {
    fn: lookupLocations,
    tool: 'lookup_locations',
    input: {
      location: {
        ids: ['gid://shopify/Location/337346566'],
        filters: { items: ['gid://shopify/ProductVariant/1'] },
      },
    },
    schema: topLevel({ meta: META, location: LOOKUP_LOCATION_BODY }),
  },
]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
  })
}

function makeFetch(opts: {
  businessProfile?: unknown
  tools: Array<{ name: string; inputSchema: object }>
  resultBody?: unknown
}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url)
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    if (body !== undefined) calls.push({ url: u, body })
    if (u.endsWith('/.well-known/ucp'))
      return jsonResponse(opts.businessProfile ?? BUSINESS_PROFILE)
    if (body?.method === 'tools/list') {
      return jsonResponse({ jsonrpc: '2.0', id: body?.id, result: { tools: opts.tools } })
    }
    return jsonResponse({ jsonrpc: '2.0', id: body?.id, result: opts.resultBody ?? { ok: true } })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

describe('location helpers carry dev.ucp.common binding metadata', () => {
  it.each([
    [searchLocations, 'search_locations'],
    [lookupLocations, 'lookup_locations'],
  ])('%#: capability/toolName/opName', (fn, tool) => {
    // --input-schema and `--view :<alias>` introspect these own properties;
    // `opName` is also the CLI body key the dispatcher wraps input under.
    expect(fn.capability).toBe('dev.ucp.common')
    expect(fn.toolName).toBe(tool)
    expect(fn.opName).toBe('location')
  })
})

describe.each(ROWS)('$tool', ({ fn, tool, input, schema }) => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-common-test-'))
  })
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('dispatches via the expected tool name with user input passed through', async () => {
    const { fetch, calls } = makeFetch({ tools: [{ name: tool, inputSchema: schema }] })
    await fn(BUSINESS_URL, input, { cacheDir, profile: RUNTIME_PROFILE, fetch })

    const toolsCall = calls.find((c) => c.body.method === 'tools/call')
    expect(toolsCall?.url).toBe(MCP_ENDPOINT)
    const params = toolsCall?.body.params as { name: string; arguments: Record<string, unknown> }
    expect(params.name).toBe(tool)
    expect(params.arguments).toMatchObject(input)
    expect(params.arguments).toMatchObject({
      meta: { 'ucp-agent': { profile: PROFILE_URL } },
    })
  })

  it('returns the unwrapped location envelope', async () => {
    const locations = [
      {
        id: 'gid://shopify/Location/337346566',
        name: 'Fillmore Store',
        address: { address_locality: 'San Francisco', address_country: 'US' },
        geo: { latitude: 37.79, longitude: -122.43 },
      },
    ]
    const { fetch } = makeFetch({
      tools: [{ name: tool, inputSchema: schema }],
      resultBody: { structuredContent: { ucp: { version: '2026-08-25' }, locations } },
    })
    await expect(
      fn(BUSINESS_URL, input, { cacheDir, profile: RUNTIME_PROFILE, fetch }),
    ).resolves.toEqual({ ucp: { version: '2026-08-25' }, locations })
  })

  it('rejects a body field outside /location before tools/call (schema validation)', async () => {
    const { fetch, calls } = makeFetch({ tools: [{ name: tool, inputSchema: schema }] })
    await expect(
      fn(
        BUSINESS_URL,
        { query: 'hoisted out of location' },
        { cacheDir, profile: RUNTIME_PROFILE, fetch },
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED', layer: 'client' })
    expect(calls.some((c) => c.body.method === 'tools/call')).toBe(false)
  })

  it('throws OPERATION_NOT_OFFERED when tools/list omits the expected tool', async () => {
    const { fetch } = makeFetch({
      tools: [{ name: 'search_catalog', inputSchema: { type: 'object' } }],
    })
    await expect(
      fn(BUSINESS_URL, input, { cacheDir, profile: RUNTIME_PROFILE, fetch }),
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_OFFERED', layer: 'transport' })
  })

  it('throws CAPABILITY_NOT_OFFERED when the business only advertises dev.ucp.shopping', async () => {
    const { fetch, calls } = makeFetch({
      businessProfile: {
        ucp: {
          version: '2026-08-25',
          services: {
            'dev.ucp.shopping': [
              { version: '2026-08-25', transport: 'mcp', endpoint: MCP_ENDPOINT },
            ],
          },
          payment_handlers: {},
        },
      },
      // Even if the shared endpoint happened to list the tool, a business
      // that does not advertise the service has not offered it.
      tools: [{ name: tool, inputSchema: schema }],
    })
    await expect(
      fn(BUSINESS_URL, input, { cacheDir, profile: RUNTIME_PROFILE, fetch }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_OFFERED',
      context: { capability: 'dev.ucp.common' },
    })
    expect(calls.some((c) => c.body.method === 'tools/call')).toBe(false)
  })

  it('throws AGENT_PROFILE_SERVICE_UNDECLARED when the agent profile lacks dev.ucp.common', async () => {
    const shoppingOnly = profileFixture({
      version: '2026-08-25',
      url: PROFILE_URL,
      services: {
        'dev.ucp.shopping': [
          {
            version: '2026-08-25',
            spec: 'https://ucp.dev/2026-08-25/specification/overview',
            transport: 'mcp',
            schema: 'https://ucp.dev/2026-08-25/services/shopping/mcp.openrpc.json',
          },
        ],
      },
    })
    const { fetch } = makeFetch({ tools: [{ name: tool, inputSchema: schema }] })
    await expect(
      fn(BUSINESS_URL, input, { cacheDir, profile: shoppingOnly, fetch }),
    ).rejects.toMatchObject({
      code: 'AGENT_PROFILE_SERVICE_UNDECLARED',
      context: { capability: 'dev.ucp.common', declared: ['dev.ucp.shopping'] },
    })
  })
})
