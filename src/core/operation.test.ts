// Generic operation dispatcher tests.
//
// These pin the boundary between discovery's dispatch view and MCP tools/call:
// tool lookup, agent-profile metadata, input-schema validation, and payload
// shape sent to the business.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { callOperation, isDryRunPreview, unwrapMcpCallResult } from './operation.js'
import type { AgentRange } from './profile.js'
import { setVerboseWriter } from './verbose.js'

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

// Declares `$schema` so the dispatcher exercises the JSON Schema dialect
// path real servers publish. Fixtures without `$schema` silently default to
// draft-07 and mask validator/dialect mismatches.
const SEARCH_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
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

// Tri-mode test matrix for pre-flight input validation. The dispatcher
// distinguishes "soft" signals (uncertainty, policy opinion) from "hard"
// signals (proven payload defect):
//
//   soft = schema cannot be compiled, or args carry a plain key not listed
//          in the published schema. Default = silent + proceed; verbose =
//          vlog trace + proceed; UCP_STRICT_SCHEMA=1 = throw.
//
//   hard = args fail validation against a successfully compiled schema.
//          Always throws SCHEMA_VALIDATION_FAILED regardless of mode —
//          local typo-catching saves a server round-trip.
//
// These tests pin the policy. Tweak with care: each row is a deliberate
// trade-off between agent UX (silent fast path) and operator debuggability
// (verbose) and contract enforcement (strict).
describe('validateOperationInput — dialect resilience and soft signals', () => {
  let cacheDir: string
  let verboseLines: string[]

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-dialect-test-'))
    verboseLines = []
    setVerboseWriter((msg) => {
      verboseLines.push(msg)
    })
  })

  afterEach(async () => {
    setVerboseWriter(null)
    delete process.env.UCP_STRICT_SCHEMA
    await rm(cacheDir, { recursive: true, force: true })
  })

  // ── Helpers ────────────────────────────────────────────────────────────
  // Build a fetch that records tools/call method names so tests can prove
  // the dispatcher actually reached the wire (vs failing closed locally).
  function buildFetch(inputSchema: unknown, calls: string[] = []): typeof globalThis.fetch {
    return vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined
      if (body?.method) calls.push(body.method as string)
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      if (body?.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'search_catalog', inputSchema }] },
        })
      }
      return jsonResponse({ jsonrpc: '2.0', id: body?.id, result: { products: ['ok'] } })
    }) as unknown as typeof globalThis.fetch
  }

  // Declares a dialect Ajv2020 doesn't know — schema content is fine, only
  // meta-schema resolution fails. Stable trigger for the compile-failure
  // branch without depending on a real production schema shape.
  const UNCOMPILABLE_SCHEMA = {
    $schema: 'https://json-schema.org/draft/9999-99/schema',
    type: 'object',
  }

  // ── Happy path ─────────────────────────────────────────────────────────

  it('compiles inputSchemas declaring JSON Schema draft 2020-12', async () => {
    // SEARCH_SCHEMA at module top declares $schema: draft/2020-12. Any
    // regression to a draft-07-only validator surfaces here as a focused
    // failure instead of cascading across unrelated tests.
    const result = await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: { catalog: { query: 'boots' } },
      },
      { cacheDir, agentRange: RANGE, fetch: buildFetch(SEARCH_SCHEMA), profileUrl: PROFILE_URL },
    )
    expect(result).toBeDefined()
    // Happy path emits no validator-related verbose traces (the discover
    // layer emits its own `discover:` lines; we assert on our own prefix).
    expect(verboseLines.filter((l) => l.startsWith('[ucp] validate:'))).toEqual([])
  })

  // ── Soft signal: schema compile failure ────────────────────────────────

  it('default mode: silently skips pre-flight when the schema cannot be compiled', async () => {
    const calls: string[] = []
    const result = await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: { catalog: { query: 'anything' } },
      },
      {
        cacheDir,
        agentRange: RANGE,
        fetch: buildFetch(UNCOMPILABLE_SCHEMA, calls),
        profileUrl: PROFILE_URL,
      },
    )
    // Request reached the server; no local throw.
    expect(calls).toContain('tools/call')
    expect(result).toBeDefined()
  })

  it('verbose mode: emits a vlog trace explaining why validation was skipped', async () => {
    await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: { catalog: { query: 'anything' } },
      },
      {
        cacheDir,
        agentRange: RANGE,
        fetch: buildFetch(UNCOMPILABLE_SCHEMA),
        profileUrl: PROFILE_URL,
      },
    )
    const skipTrace = verboseLines.find((l) => l.includes('validate: skipped'))
    expect(skipTrace).toBeDefined()
    expect(skipTrace).toMatch(/"search_catalog"/)
    expect(skipTrace).toMatch(/cannot compile published schema/)
    expect(skipTrace).toMatch(/server will validate/)
    // Trace attributes the failure to the client's validator, not the server.
    expect(skipTrace).not.toMatch(/MCP_INVALID_RESPONSE/)
    expect(skipTrace).not.toMatch(/business returned an invalid input schema/)
  })

  it('strict mode: throws MCP_INVALID_RESPONSE when the schema cannot be compiled', async () => {
    process.env.UCP_STRICT_SCHEMA = '1'
    let captured: unknown
    await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: { catalog: { query: 'anything' } },
      },
      {
        cacheDir,
        agentRange: RANGE,
        fetch: buildFetch(UNCOMPILABLE_SCHEMA),
        profileUrl: PROFILE_URL,
      },
    ).catch((err) => {
      captured = err
    })
    const err = captured as { code: string; layer: string } | undefined
    expect(err?.code).toBe('MCP_INVALID_RESPONSE')
    expect(err?.layer).toBe('transport')
  })

  // ── Soft signal: unknown plain field ──────────────────────────────────

  it('default mode: silently allows plain keys not listed in the published schema', async () => {
    // address_subdivision/address_postal_code are NOT in SEARCH_SCHEMA's
    // context. Pre-2026-05 client policy threw SCHEMA_VALIDATION_FAILED
    // before dispatch. New policy: defer to the server, which is
    // authoritative on whether it accepts the field.
    const calls: string[] = []
    const result = await callOperation(
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
      {
        cacheDir,
        agentRange: RANGE,
        fetch: buildFetch(SEARCH_SCHEMA, calls),
        profileUrl: PROFILE_URL,
      },
    )
    expect(calls).toContain('tools/call')
    expect(result).toBeDefined()
  })

  it('verbose mode: emits a vlog trace listing the plain keys the schema does not declare', async () => {
    await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: {
          catalog: {
            query: 'boots',
            context: { address_country: 'US', address_subdivision: 'CA' },
          },
        },
      },
      { cacheDir, agentRange: RANGE, fetch: buildFetch(SEARCH_SCHEMA), profileUrl: PROFILE_URL },
    )
    const flagTrace = verboseLines.find((l) => l.includes('not listed in published schema'))
    expect(flagTrace).toBeDefined()
    expect(flagTrace).toMatch(/"search_catalog"/)
    expect(flagTrace).toMatch(/\/catalog\/context\/address_subdivision/)
    expect(flagTrace).toMatch(/server will accept or reject/)
  })

  it('strict mode: throws SCHEMA_VALIDATION_FAILED for plain keys not in the schema', async () => {
    process.env.UCP_STRICT_SCHEMA = '1'
    let captured: unknown
    await callOperation(
      BUSINESS_URL,
      {
        capability: 'dev.ucp.shopping',
        toolName: 'search_catalog',
        input: {
          catalog: {
            query: 'boots',
            context: { address_country: 'US', address_subdivision: 'CA' },
          },
        },
      },
      { cacheDir, agentRange: RANGE, fetch: buildFetch(SEARCH_SCHEMA), profileUrl: PROFILE_URL },
    ).catch((err) => {
      captured = err
    })
    const err = captured as
      | { code: string; layer: string; context: { unknown_fields: string[] } }
      | undefined
    expect(err?.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(err?.layer).toBe('client')
    expect(err?.context.unknown_fields).toContain('/catalog/context/address_subdivision')
  })

  // ── Hard signal: payload mismatch (mode-invariant) ────────────────────

  it('always throws SCHEMA_VALIDATION_FAILED when the payload fails a compiled schema', async () => {
    // Hard signal: schema compiled fine, payload structurally wrong. Local
    // fail-fast saves a server round-trip and gives clear typo feedback.
    // No mode changes this — strict and default both throw here.
    let captured: unknown
    await callOperation(
      BUSINESS_URL,
      // Missing the required `catalog` field.
      { capability: 'dev.ucp.shopping', toolName: 'search_catalog', input: {} },
      { cacheDir, agentRange: RANGE, fetch: buildFetch(SEARCH_SCHEMA), profileUrl: PROFILE_URL },
    ).catch((err) => {
      captured = err
    })
    const err = captured as { code: string; layer: string } | undefined
    expect(err?.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(err?.layer).toBe('client')
  })
})

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
