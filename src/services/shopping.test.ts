// Shopping service helper tests.
//
// Every helper in shopping.ts is a 1-line `serviceOp` invocation bound to
// the `dev.ucp.shopping` capability. The dispatcher (core/operation.ts) owns
// wire-envelope behavior — meta.ucp-agent injection, idempotency-key
// injection, schema validation, OPERATION_NOT_OFFERED routing — and
// operation.test.ts pins it. The unique signal per helper is just: did the
// factory get the right tool-name string?
//
// One table-driven block covers all 13 helpers:
//   1. happy path — tools/list discovers the tool, tools/call sends user
//      input through verbatim under the right `name`
//   2. OPERATION_NOT_OFFERED — when tools/list omits the expected tool
//
// Schemas (CART_BODY, META, etc.) are kept as documentation of the spec wire
// contract; AJV validates the dispatcher's outgoing args against them, so a
// regression where the helper transforms input would fail schema validation
// before tools/call.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRange } from '../core/profile.js'
import {
  cancelCart,
  cancelCheckout,
  completeCheckout,
  createCart,
  createCheckout,
  getCart,
  getCheckout,
  getOrder,
  getProduct,
  lookupCatalog,
  searchCatalog,
  updateCart,
  updateCheckout,
} from './shopping.js'

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

// ─── Schema fixtures (documentation of spec wire contracts) ─────────────────
//
// META: ucp-agent always required. Idempotency-required ops use META_REQ.
// `additionalProperties: false` at top level catches a regression that hoists
// or nests fields wrongly. Inner shapes stay loose so extension fields ride
// freely.

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
const META_REQ = { ...META, required: ['ucp-agent', 'idempotency-key'] }

const CART_BODY = { type: 'object' }
const CHECKOUT_BODY = { type: 'object' }
const CATALOG_BODY = { type: 'object' }

function topLevel(props: Record<string, object>, required = Object.keys(props)) {
  return { type: 'object', required, additionalProperties: false, properties: props }
}

// ─── Helper manifest ────────────────────────────────────────────────────────
//
// Each row binds (helper fn, tool-name, sample input, schema). The schema
// pins the spec wire shape; the input must satisfy it, exercising real AJV
// validation in the dispatcher.

interface Row {
  fn: typeof searchCatalog
  tool: string
  input: Record<string, unknown>
  schema: object
}

const ROWS: Row[] = [
  // catalog
  {
    fn: searchCatalog,
    tool: 'search_catalog',
    input: { catalog: { query: 'boots' } },
    schema: topLevel({ meta: META, catalog: CATALOG_BODY }),
  },
  {
    fn: lookupCatalog,
    tool: 'lookup_catalog',
    input: { catalog: { ids: ['gid://shopify/Product/1'] } },
    schema: topLevel({ meta: META, catalog: CATALOG_BODY }),
  },
  {
    fn: getProduct,
    tool: 'get_product',
    input: { catalog: { id: 'gid://shopify/Product/1' } },
    schema: topLevel({ meta: META, catalog: CATALOG_BODY }),
  },
  // cart
  {
    fn: createCart,
    tool: 'create_cart',
    input: { cart: { line_items: [] } },
    schema: topLevel({ meta: META, cart: CART_BODY }),
  },
  {
    fn: getCart,
    tool: 'get_cart',
    input: { id: 'cart_x' },
    schema: topLevel({ meta: META, id: { type: 'string' } }),
  },
  {
    fn: updateCart,
    tool: 'update_cart',
    input: { id: 'cart_x', cart: { line_items: [] } },
    schema: topLevel({ meta: META, id: { type: 'string' }, cart: CART_BODY }),
  },
  {
    fn: cancelCart,
    tool: 'cancel_cart',
    input: { id: 'cart_x' },
    schema: topLevel({ meta: META_REQ, id: { type: 'string' } }),
  },
  // checkout
  {
    fn: createCheckout,
    tool: 'create_checkout',
    input: { checkout: { cart_id: 'cart_x', line_items: [] } },
    schema: topLevel({ meta: META, checkout: CHECKOUT_BODY }),
  },
  {
    fn: getCheckout,
    tool: 'get_checkout',
    input: { id: 'co_x' },
    schema: topLevel({ meta: META, id: { type: 'string' } }),
  },
  {
    fn: updateCheckout,
    tool: 'update_checkout',
    input: { id: 'co_x', checkout: {} },
    schema: topLevel({ meta: META, id: { type: 'string' }, checkout: CHECKOUT_BODY }),
  },
  {
    fn: completeCheckout,
    tool: 'complete_checkout',
    input: { id: 'co_x' },
    schema: topLevel({ meta: META_REQ, id: { type: 'string' } }),
  },
  {
    fn: cancelCheckout,
    tool: 'cancel_checkout',
    input: { id: 'co_x' },
    schema: topLevel({ meta: META_REQ, id: { type: 'string' } }),
  },
  // order
  {
    fn: getOrder,
    tool: 'get_order',
    input: { id: 'ord_x' },
    schema: topLevel({ meta: META, id: { type: 'string' } }),
  },
]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
  })
}

function makeFetch(toolName: string, schema: object, resultBody: unknown = { ok: true }) {
  const calls: Record<string, unknown>[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url)
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    if (body !== undefined) calls.push(body)
    if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
    if (body?.method === 'tools/list') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body?.id,
        result: { tools: [{ name: toolName, inputSchema: schema }] },
      })
    }
    return jsonResponse({ jsonrpc: '2.0', id: body?.id, result: resultBody })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

describe.each(ROWS)('$tool', ({ fn, tool, input, schema }) => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-shopping-test-'))
  })
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('dispatches via the expected tool name with user input passed through', async () => {
    const { fetch, calls } = makeFetch(tool, schema)
    await fn(BUSINESS_URL, input, { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL })

    const toolsCall = calls.find((c) => c.method === 'tools/call')
    expect(toolsCall).toBeDefined()
    const params = toolsCall?.params as { name: string; arguments: Record<string, unknown> }
    expect(params.name).toBe(tool)
    expect(params.arguments).toMatchObject(input)
    expect(params.arguments).toMatchObject({
      meta: { 'ucp-agent': { profile: PROFILE_URL } },
    })
  })

  it('throws OPERATION_NOT_OFFERED when tools/list omits the expected tool', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url)
      if (u.endsWith('/.well-known/ucp')) return jsonResponse(PROFILE)
      const body =
        typeof init.body === 'string' ? (JSON.parse(init.body) as { id?: unknown }) : undefined
      return jsonResponse({
        jsonrpc: '2.0',
        id: body?.id,
        result: { tools: [{ name: 'unrelated_tool', inputSchema: { type: 'object' } }] },
      })
    }) as unknown as typeof globalThis.fetch

    await expect(
      fn(BUSINESS_URL, input, { cacheDir, agentRange: RANGE, fetch, profileUrl: PROFILE_URL }),
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_OFFERED', layer: 'transport' })
  })
})
