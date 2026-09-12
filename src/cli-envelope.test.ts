// CLI shopping-envelope contract tests.
//
// Service-helper tests pin pass-through from each helper to MCP. This matrix
// pins the separate registration seam from real CLI grammar to those helpers,
// so a correct helper cannot mask a command wired with the wrong body or id placement.

import { describe, expect, it } from 'vitest'

import type { ResolvedSession, ResolveSessionOptions } from './cli/session.js'
import { createUcpCli, type ShoppingHelperDep, type UcpCliDependencies } from './cli.js'
import * as shoppingHelpers from './services/shopping.js'
import { profileFixture, serveCli } from './test-utils.js'

const BUSINESS_URL = 'https://shop.example.com'
const PROFILE_URL = 'https://agent.example.com/.well-known/ucp'
const PROFILE = profileFixture({ url: PROFILE_URL })

const resolveSession = async (options: ResolveSessionOptions = {}): Promise<ResolvedSession> => ({
  profile: PROFILE,
  profileMeta: {},
  ...(options.business !== undefined ? { business: options.business } : {}),
})

type HelperName = keyof typeof shoppingHelpers

interface HelperCall {
  helperName: HelperName
  businessUrl: string
  input: Record<string, unknown>
}

interface ContractRow {
  helperName: HelperName
  toolName: string
  argv: string[]
  expectedInput: Record<string, unknown>
}

// Expected tool names and envelopes are transcribed from the published shopping
// bindings. They are intentionally not inferred from either runtime seam under test.
const CONTRACT_ROWS: ContractRow[] = [
  {
    helperName: 'searchCatalog',
    toolName: 'search_catalog',
    argv: ['catalog', 'search', '--business', BUSINESS_URL, '--input', '{"query":"boots"}'],
    expectedInput: { catalog: { query: 'boots' } },
  },
  {
    helperName: 'lookupCatalog',
    toolName: 'lookup_catalog',
    argv: ['catalog', 'lookup', '--business', BUSINESS_URL, '--input', '{"ids":["p1"]}'],
    expectedInput: { catalog: { ids: ['p1'] } },
  },
  {
    helperName: 'getProduct',
    toolName: 'get_product',
    argv: [
      'catalog',
      'get_product',
      'p1',
      '--business',
      BUSINESS_URL,
      '--input',
      '{"selected":[{"name":"Color","label":"Black"}]}',
    ],
    expectedInput: {
      catalog: { selected: [{ name: 'Color', label: 'Black' }], id: 'p1' },
    },
  },
  {
    helperName: 'createCart',
    toolName: 'create_cart',
    argv: ['cart', 'create', '--business', BUSINESS_URL, '--input', '{"line_items":[]}'],
    expectedInput: { cart: { line_items: [] } },
  },
  {
    helperName: 'getCart',
    toolName: 'get_cart',
    argv: ['cart', 'get', 'cart-1', '--business', BUSINESS_URL],
    expectedInput: { id: 'cart-1' },
  },
  {
    helperName: 'updateCart',
    toolName: 'update_cart',
    argv: ['cart', 'update', 'cart-1', '--business', BUSINESS_URL, '--input', '{"line_items":[]}'],
    expectedInput: { cart: { line_items: [] }, id: 'cart-1' },
  },
  {
    helperName: 'cancelCart',
    toolName: 'cancel_cart',
    argv: ['cart', 'cancel', 'cart-1', '--business', BUSINESS_URL],
    expectedInput: { id: 'cart-1' },
  },
  {
    helperName: 'createCheckout',
    toolName: 'create_checkout',
    argv: ['checkout', 'create', '--business', BUSINESS_URL, '--input', '{"line_items":[]}'],
    expectedInput: { checkout: { line_items: [] } },
  },
  {
    helperName: 'getCheckout',
    toolName: 'get_checkout',
    argv: ['checkout', 'get', 'checkout-1', '--business', BUSINESS_URL],
    expectedInput: { id: 'checkout-1' },
  },
  {
    helperName: 'updateCheckout',
    toolName: 'update_checkout',
    argv: [
      'checkout',
      'update',
      'checkout-1',
      '--business',
      BUSINESS_URL,
      '--input',
      '{"line_items":[]}',
    ],
    expectedInput: { checkout: { line_items: [] }, id: 'checkout-1' },
  },
  {
    helperName: 'completeCheckout',
    toolName: 'complete_checkout',
    argv: [
      'checkout',
      'complete',
      'checkout-1',
      '--business',
      BUSINESS_URL,
      '--input',
      '{"payment":{}}',
    ],
    expectedInput: { checkout: { payment: {} }, id: 'checkout-1' },
  },
  {
    helperName: 'cancelCheckout',
    toolName: 'cancel_checkout',
    argv: ['checkout', 'cancel', 'checkout-1', '--business', BUSINESS_URL],
    expectedInput: { id: 'checkout-1' },
  },
  {
    helperName: 'getOrder',
    toolName: 'get_order',
    argv: ['order', 'get', 'order-1', '--business', BUSINESS_URL],
    expectedInput: { id: 'order-1' },
  },
]

function shoppingHelperStubs(calls: HelperCall[]): UcpCliDependencies {
  const stubs = CONTRACT_ROWS.map(({ helperName }) => {
    const stub: ShoppingHelperDep = async (businessUrl, input) => {
      calls.push({ helperName, businessUrl, input })
      return {}
    }

    return [helperName, stub] as const
  })

  return Object.fromEntries(stubs) as UcpCliDependencies
}

describe('CLI shopping envelopes', () => {
  it('has a contract row for every exported shopping helper', () => {
    const exportedToolNames = Object.values(shoppingHelpers)
      .map((helper) => helper.toolName)
      .sort()
    const rowToolNames = CONTRACT_ROWS.map((row) => row.toolName).sort()

    expect(rowToolNames).toEqual(exportedToolNames)
  })

  it.each(CONTRACT_ROWS)('$toolName invokes $helperName with its binding envelope', async (row) => {
    const calls: HelperCall[] = []
    const cli = createUcpCli({
      resolveSession,
      ...shoppingHelperStubs(calls),
    })

    const { exitCode } = await serveCli(cli, row.argv)

    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.helperName).toBe(row.helperName)
    expect(calls[0]?.businessUrl).toBe(BUSINESS_URL)
    expect(calls[0]?.input).toEqual(row.expectedInput)
  })

  it('projects the positional get_product id out of its direct catalog input schema', async () => {
    const calls: HelperCall[] = []
    const selectedSchema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          label: { type: 'string' },
        },
      },
    }
    const catalogSchema = {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        selected: selectedSchema,
      },
    }
    const cli = createUcpCli({
      resolveSession,
      ...shoppingHelperStubs(calls),
      discover: async () =>
        ({
          business: BUSINESS_URL,
          negotiated: {
            'dev.ucp.shopping': {
              capability: 'dev.ucp.shopping',
              version: '2026-08-25',
              transport: 'mcp',
              endpoint: `${BUSINESS_URL}/mcp`,
              tools: {
                get_product: {
                  name: 'get_product',
                  inputSchema: {
                    type: 'object',
                    required: ['catalog'],
                    properties: { catalog: catalogSchema },
                  },
                },
              },
            },
          },
        }) as never,
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'get_product',
      '--business',
      BUSINESS_URL,
      '--input-schema',
    ])

    expect(exitCode).toBe(0)
    expect(calls).toEqual([])
    expect(JSON.parse(output).result.tool.inputSchema).toEqual({
      type: 'object',
      properties: { selected: selectedSchema },
    })
  })
})
