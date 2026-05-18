// Generic operation dispatcher tests.
//
// These pin the boundary between discovery's dispatch view and MCP tools/call:
// tool lookup, agent-profile metadata, input-schema validation, and payload
// shape sent to the business.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  callOperation,
  isDryRunPreview,
  patchKnownUpstreamSchemaDefects,
  unwrapMcpCallResult,
} from './operation.js'
import type { AgentRange } from './profile.js'

const BUSINESS_URL = 'https://shop.example.invalid'
const MCP_ENDPOINT = 'https://shop.example.invalid/ucp/mcp'
const PROFILE_URL = 'https://agent.example.com/.well-known/ucp'
const RANGE: AgentRange = { min: '2026-01-23', max: '2026-04-08' }

const PROFILE = {
  ucp: {
    version: '2026-04-08',
    services: {
      'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp', endpoint: MCP_ENDPOINT }],
    },
    payment_handlers: {},
  },
}

const SEARCH_SCHEMA = {
  type: 'object',
  required: ['meta', 'catalog'],
  properties: {
    meta: {
      type: 'object',
      required: ['ucp-agent'],
      properties: {
        'ucp-agent': {
          type: 'object',
          required: ['profile'],
          properties: { profile: { type: 'string', format: 'uri' } },
        },
      },
    },
    catalog: {
      type: 'object',
      required: ['query'],
      additionalProperties: true,
      properties: {
        query: { type: 'string' },
        context: {
          type: 'object',
          additionalProperties: true,
          properties: {
            address_country: { type: 'string' },
            address_region: { type: 'string' },
            postal_code: { type: 'string' },
          },
        },
        pagination: {
          type: 'object',
          properties: { limit: { type: 'integer' } },
        },
      },
    },
  },
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
  })
}

describe('callOperation', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-operation-test-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('validates and calls the negotiated MCP tool', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (body !== undefined) bodies.push(body)
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)

      const id = body?.id
      if (body?.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id,
          result: { tools: [{ name: 'search_catalog', inputSchema: SEARCH_SCHEMA }] },
        })
      }
      return jsonResponse({ jsonrpc: '2.0', id, result: { products: [] } })
    }) as unknown as typeof globalThis.fetch

    await expect(
      callOperation(
        BUSINESS_URL,
        {
          capability: 'dev.ucp.shopping',
          toolName: 'search_catalog',
          input: { catalog: { query: 'boots', pagination: { limit: 2 } } },
        },
        { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL },
      ),
    ).resolves.toEqual({ products: [] })

    const params = bodies.find((body) => body.method === 'tools/call')?.params as {
      name: string
      arguments: { meta: Record<string, unknown>; catalog: unknown }
    }
    expect(params.name).toBe('search_catalog')
    expect(params.arguments).toMatchObject({
      meta: { 'ucp-agent': { profile: PROFILE_URL } },
      catalog: { query: 'boots', pagination: { limit: 2 } },
    })
    expect(typeof params.arguments.meta['idempotency-key']).toBe('string')
  })

  it('rejects user-supplied meta.ucp-agent (protocol-owned)', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      return jsonResponse({
        jsonrpc: '2.0',
        id: body?.id,
        result: { tools: [{ name: 'search_catalog', inputSchema: SEARCH_SCHEMA }] },
      })
    }) as unknown as typeof globalThis.fetch

    await expect(
      callOperation(
        BUSINESS_URL,
        {
          capability: 'dev.ucp.shopping',
          toolName: 'search_catalog',
          input: {
            meta: { 'ucp-agent': { profile: 'https://attacker.example.invalid/.well-known/ucp' } },
            catalog: { query: 'boots' },
          },
        },
        { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      layer: 'client',
    })
  })

  it('preserves user-supplied meta keys other than ucp-agent', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (body !== undefined) bodies.push(body)
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      const id = body?.id
      if (body?.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id,
          result: { tools: [{ name: 'search_catalog', inputSchema: { type: 'object' } }] },
        })
      }
      return jsonResponse({ jsonrpc: '2.0', id, result: { products: [] } })
    }) as unknown as typeof globalThis.fetch

    await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: { meta: { trace_id: 'abc-123' }, catalog: { query: 'boots' } },
      },
      { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL },
    )

    const args = bodies.find((body) => body.method === 'tools/call')?.params as {
      arguments: { meta: Record<string, unknown> }
    }
    expect(args.arguments.meta).toMatchObject({
      trace_id: 'abc-123',
      'ucp-agent': { profile: PROFILE_URL },
    })
    // dispatcher unconditionally injects idempotency-key (UUIDv4)
    expect(typeof args.arguments.meta['idempotency-key']).toBe('string')
  })

  it('preserves caller-supplied idempotency-key without overwriting', async () => {
    const CALLER_KEY = 'caller-supplied-key-1234'
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (body !== undefined) bodies.push(body)
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      const id = body?.id
      if (body?.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id,
          result: { tools: [{ name: 'search_catalog', inputSchema: { type: 'object' } }] },
        })
      }
      return jsonResponse({ jsonrpc: '2.0', id, result: { products: [] } })
    }) as unknown as typeof globalThis.fetch

    await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: {
          meta: { 'idempotency-key': CALLER_KEY },
          catalog: { query: 'boots' },
        },
      },
      { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL },
    )

    const args = bodies.find((body) => body.method === 'tools/call')?.params as {
      arguments: { meta: Record<string, unknown> }
    }
    expect(args.arguments.meta['idempotency-key']).toBe(CALLER_KEY)
  })

  it('fails before tools/call when input does not match the tool schema', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (body !== undefined) bodies.push(body)
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      return jsonResponse({
        jsonrpc: '2.0',
        id: body?.id,
        result: { tools: [{ name: 'search_catalog', inputSchema: SEARCH_SCHEMA }] },
      })
    }) as unknown as typeof globalThis.fetch

    // Assert via captured rejection so we can probe `error.context.schema`.
    // The thrown `UcpError` carries the operation input schema; library
    // callers (and the wire envelope, once incur preserves context) can
    // recover from a validation failure without an extra --input-schema call.
    let captured: unknown
    await callOperation(
      BUSINESS_URL,
      { capability: 'dev.ucp.shopping', toolName: 'search_catalog', input: { query: 'boots' } },
      { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL },
    ).catch((err) => {
      captured = err
    })
    const err = captured as { code: string; layer: string; context: { schema: unknown } }
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(err.layer).toBe('client')
    // The exact schema the upstream advertised — same object the dispatcher
    // ran ajv against — so the caller doesn't have to re-fetch tools/list.
    expect(err.context.schema).toEqual(SEARCH_SCHEMA)
    expect(bodies.some((body) => body.method === 'tools/call')).toBe(false)
  })

  it('rejects unknown plain fields before tools/call even when schema allows extensions', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (body !== undefined) bodies.push(body)
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      return jsonResponse({
        jsonrpc: '2.0',
        id: body?.id,
        result: { tools: [{ name: 'search_catalog', inputSchema: SEARCH_SCHEMA }] },
      })
    }) as unknown as typeof globalThis.fetch

    await expect(
      callOperation(
        BUSINESS_URL,
        {
          capability: 'dev.ucp.shopping',
          toolName: 'search_catalog',
          input: {
            catalog: {
              query: 'boots',
              context: {
                address_country: 'US',
                address_subdivision: 'CA',
                address_postal_code: '94105',
              },
            },
          },
        },
        { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL },
      ),
    ).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
      layer: 'client',
      context: {
        unknown_fields: [
          '/catalog/context/address_subdivision',
          '/catalog/context/address_postal_code',
        ],
      },
    })

    await expect(
      callOperation(
        BUSINESS_URL,
        {
          capability: 'dev.ucp.shopping',
          toolName: 'search_catalog',
          input: {
            catalog: {
              query: 'boots',
              context: { address_country: 'US', 'Com.Example.fulfillment_hint': 'dock' },
            },
          },
        },
        { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL },
      ),
    ).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
      layer: 'client',
      context: { unknown_fields: ['/catalog/context/Com.Example.fulfillment_hint'] },
    })

    expect(bodies.some((body) => body.method === 'tools/call')).toBe(false)
  })

  it('allows reverse-DNS extension keys at open schema extension points', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (body !== undefined) bodies.push(body)
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      const id = body?.id
      if (body?.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id,
          result: { tools: [{ name: 'search_catalog', inputSchema: SEARCH_SCHEMA }] },
        })
      }
      return jsonResponse({ jsonrpc: '2.0', id, result: { products: [] } })
    }) as unknown as typeof globalThis.fetch

    await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: {
          catalog: {
            query: 'boots',
            context: { address_country: 'US', 'com.example.fulfillment_hint': 'dock' },
          },
        },
      },
      { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL },
    )

    const params = bodies.find((body) => body.method === 'tools/call')?.params as {
      arguments: { catalog: { context: Record<string, unknown> } }
    }
    expect(params.arguments.catalog.context['com.example.fulfillment_hint']).toBe('dock')
  })

  it('dry-run: returns preview after validation, skips tools/call', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (body !== undefined) bodies.push(body)
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      return jsonResponse({
        jsonrpc: '2.0',
        id: body?.id,
        result: { tools: [{ name: 'search_catalog', inputSchema: SEARCH_SCHEMA }] },
      })
    }) as unknown as typeof globalThis.fetch

    const result = await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: { catalog: { query: 'boots' } },
      },
      { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL, dryRun: true },
    )
    expect(isDryRunPreview(result)).toBe(true)
    if (!isDryRunPreview(result)) throw new Error('unreachable')
    // Dispatch identity (business/endpoint/transport) is stamped at envelope
    // root by cli.ts opRun, not inside the preview — preview only carries
    // dry-run-specific metadata (capability + tool name + wire-faithful args).
    expect(result).toMatchObject({
      dry_run: true,
      capability: 'dev.ucp.shopping',
      tool: { name: 'search_catalog' },
    })
    expect(result).not.toHaveProperty('business')
    expect(result).not.toHaveProperty('endpoint')
    expect((result as { tool: Record<string, unknown> }).tool).not.toHaveProperty('endpoint')
    expect((result as { tool: Record<string, unknown> }).tool).not.toHaveProperty('transport')
    // `note` rides on the preview because incur strips empty-commands CTAs;
    // pin its presence so the agent-facing explanation can't silently drop.
    expect(typeof result.note).toBe('string')
    expect(result.note).toMatch(/dry-run|--dry-run|wire/i)
    expect(result.arguments).toMatchObject({
      catalog: { query: 'boots' },
      meta: { 'ucp-agent': { profile: PROFILE_URL } },
    })
    expect(typeof (result.arguments.meta as Record<string, unknown>)['idempotency-key']).toBe(
      'string',
    )
    // The whole point: no tools/call hit the wire.
    expect(bodies.some((body) => body.method === 'tools/call')).toBe(false)
  })

  it('dry-run: still fails on schema validation (matches real-call behavior)', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      return jsonResponse({
        jsonrpc: '2.0',
        id: body?.id,
        result: { tools: [{ name: 'search_catalog', inputSchema: SEARCH_SCHEMA }] },
      })
    }) as unknown as typeof globalThis.fetch

    await expect(
      callOperation(
        BUSINESS_URL,
        {
          capability: 'dev.ucp.shopping',
          // Missing required `catalog` — exact same error as a non-dry-run call.
          toolName: 'search_catalog',
          input: { query: 'boots' },
        },
        { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL, dryRun: true },
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' })
  })

  // The internal `_onDiscover` side-channel exists so the CLI can surface the
  // trusted negotiated view in CTAs without forcing a redundant discover() at
  // the call site or growing the public helper return shape. Two properties
  // matter: (1) the callback fires exactly once on a successful discover, and
  // (2) it fires BEFORE the OPERATION_NOT_OFFERED throw — so CTAs on the
  // transport-layer error path still get advertised-capability context.
  it('_onDiscover fires once with the resolved DiscoveredBusiness before tools/call', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      if (body?.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body?.id,
          result: { tools: [{ name: 'search_catalog', inputSchema: SEARCH_SCHEMA }] },
        })
      }
      return jsonResponse({ jsonrpc: '2.0', id: body?.id, result: { products: [] } })
    }) as unknown as typeof globalThis.fetch

    const captured: Array<{ business: string; negotiatedKeys: string[] }> = []
    await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: { catalog: { query: 'boots' } },
      },
      {
        cacheDir,
        agentRange: RANGE,
        fetch,
        profileUrl: PROFILE_URL,
        _onDiscover: (d) => {
          captured.push({ business: d.business, negotiatedKeys: Object.keys(d.negotiated) })
        },
      },
    )
    expect(captured).toEqual([{ business: BUSINESS_URL, negotiatedKeys: ['dev.ucp.shopping'] }])
  })

  it('_onDiscover fires even when the requested tool is not offered (CTA on error path)', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      // tools/list omits the requested tool — discover succeeds, but the
      // operation lookup will throw OPERATION_NOT_OFFERED. Callback must
      // still have fired by then.
      return jsonResponse({
        jsonrpc: '2.0',
        id: body?.id,
        result: { tools: [{ name: 'some_other_tool', inputSchema: SEARCH_SCHEMA }] },
      })
    }) as unknown as typeof globalThis.fetch

    let fired = false
    await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: { catalog: { query: 'boots' } },
      },
      {
        cacheDir,
        agentRange: RANGE,
        fetch,
        profileUrl: PROFILE_URL,
        _onDiscover: () => {
          fired = true
        },
      },
    ).catch((err: { code: string }) => {
      expect(err.code).toBe('OPERATION_NOT_OFFERED')
    })
    expect(fired).toBe(true)
  })
})

// TODO(upstream-fix): delete this block alongside patchKnownUpstreamSchemaDefects.
describe('unwrapMcpCallResult — structuredContent vs content[].text', () => {
  // Catalog endpoints (catalog.shopify.com) return only structuredContent, no
  // content[].text fallback. Without this branch, every catalog response would
  // leave the UCP envelope buried under `result.structuredContent.ucp` instead
  // of hoisted to envelope root.
  it('peels structuredContent when present (catalog shape)', () => {
    const payload = { ucp: { version: '2026-04-08' }, products: [{ id: 'gid://shopify/p/1' }] }
    expect(unwrapMcpCallResult({ structuredContent: payload })).toEqual(payload)
  })

  // Storefront endpoints return the JSON-stringified envelope in content[].text.
  // This is the original code path; pinning so a regression doesn't go silent.
  it('parses content[].text when structuredContent is absent (storefront shape)', () => {
    const payload = { ucp: { version: '2026-04-08' }, id: 'cart_123' }
    const wire = { content: [{ type: 'text', text: JSON.stringify(payload) }] }
    expect(unwrapMcpCallResult(wire)).toEqual(payload)
  })

  // Spec allows both; structuredContent wins because it's already parsed
  // (cheaper, no JSON round-trip lossiness on dates/numbers).
  it('prefers structuredContent when both are present', () => {
    const structured = { ucp: { version: 'STRUCTURED' } }
    const wire = {
      structuredContent: structured,
      content: [{ type: 'text', text: JSON.stringify({ ucp: { version: 'TEXT' } }) }],
    }
    expect(unwrapMcpCallResult(wire)).toEqual(structured)
  })

  it('returns the input unchanged when neither shape matches', () => {
    const odd = { unexpected: 'shape' }
    expect(unwrapMcpCallResult(odd)).toBe(odd)
  })

  it('returns the input unchanged when content[].text is not valid JSON', () => {
    const wire = { content: [{ type: 'text', text: 'not-json{' }] }
    expect(unwrapMcpCallResult(wire)).toBe(wire)
  })
})

describe('patchKnownUpstreamSchemaDefects — \\A anchor stopgap', () => {
  it('rewrites a leading \\A to ^ at the root pattern', () => {
    const out = patchKnownUpstreamSchemaDefects({ pattern: '\\Agid://shopify/p/' })
    expect(out).toEqual({ pattern: '^gid://shopify/p/' })
  })

  it('rewrites nested patterns (the real catalog shape: properties → oneOf → items)', () => {
    // Path that bites in production:
    //   properties.catalog.properties.like.items.oneOf[0].properties.id.pattern
    const input = {
      type: 'object',
      properties: {
        catalog: {
          type: 'object',
          properties: {
            like: {
              type: 'array',
              items: {
                oneOf: [{ properties: { id: { type: 'string', pattern: '\\Agid://shopify/p/' } } }],
              },
            },
          },
        },
      },
    }
    const out = patchKnownUpstreamSchemaDefects(input) as typeof input
    const patched = out.properties.catalog.properties.like.items.oneOf[0]?.properties.id.pattern
    expect(patched).toBe('^gid://shopify/p/')
  })

  it('does not mutate the input schema (deep clone)', () => {
    const input = { pattern: '\\Agid://x' }
    patchKnownUpstreamSchemaDefects(input)
    expect(input.pattern).toBe('\\Agid://x')
  })

  it('leaves patterns without leading \\A untouched', () => {
    const input = { pattern: '^already-anchored', other: { pattern: '[a-z]+' } }
    expect(patchKnownUpstreamSchemaDefects(input)).toEqual(input)
  })

  it('ignores non-string pattern values (defensive)', () => {
    // A misshapen schema where `pattern` is not a string shouldn't crash —
    // AJV's own error path will surface the real defect.
    const input = { pattern: 42 }
    expect(patchKnownUpstreamSchemaDefects(input)).toEqual(input)
  })

  it('produces a regex AJV can compile under its default (u-flag) mode', async () => {
    const { default: Ajv } = await import('ajv')
    const ajv = new Ajv({ strict: false })
    const patched = patchKnownUpstreamSchemaDefects({
      type: 'string',
      pattern: '\\Agid://shopify/p/',
    })
    expect(() => ajv.compile(patched as object)).not.toThrow()
  })
})
