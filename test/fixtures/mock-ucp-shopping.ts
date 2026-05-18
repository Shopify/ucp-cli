// Full mock UCP shopping business for eval/integration tests.
//
// Serves the complete purchase journey:
//   search_catalog → create_cart → create_checkout → update_checkout → complete_checkout
//
// complete_checkout always returns a checkout with status requires_escalation
// (requires_buyer_review message) so the eval harness can assert the escalation
// hook fires. Per UCP spec, this is a normal success response — requires_escalation
// is a checkout STATUS VALUE on the checkout object, not an error envelope.
// The product, cart, and checkout IDs are stable constants so tests can use them.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MockBusiness } from './mock-business.js'
import { startMockBusiness } from './mock-business.js'

export const MOCK_VARIANT_ID = 'gid://mock/ProductVariant/var_1'
export const MOCK_CART_ID = 'gid://mock/Cart/cart_1'
export const MOCK_CHECKOUT_ID = 'gid://mock/Checkout/chk_1'
export const MOCK_ESCALATION_URL = 'https://mock.example.com/review/chk_1'

// Minimal JSON schemas that mirror the real shopping service schemas.
// Enough to satisfy AJV validation in the dispatcher.
const SEARCH_CATALOG_SCHEMA = {
  type: 'object',
  properties: {
    catalog: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        pagination: { type: 'object', properties: { limit: { type: 'integer' } } },
      },
    },
  },
}

const LINE_ITEMS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['item', 'quantity'],
    properties: {
      id: { type: 'string' },
      item: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      quantity: { type: 'integer' },
    },
  },
}

const CREATE_CART_SCHEMA = {
  type: 'object',
  required: ['cart'],
  properties: {
    cart: {
      type: 'object',
      required: ['line_items'],
      properties: { line_items: LINE_ITEMS_SCHEMA },
    },
    meta: { type: 'object' },
  },
}

const CREATE_CHECKOUT_SCHEMA = {
  type: 'object',
  required: ['checkout'],
  properties: {
    checkout: {
      type: 'object',
      required: ['line_items'],
      properties: {
        // Cart conversion is a checkout body field contributed by the cart
        // capability; MCP adds the outer `checkout` wrapper as the method param.
        cart_id: { type: 'string' },
        line_items: LINE_ITEMS_SCHEMA,
        buyer: { type: 'object' },
      },
    },
    meta: { type: 'object' },
  },
}

const FULFILLMENT_DESTINATION_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    first_name: { type: 'string' },
    last_name: { type: 'string' },
    phone_number: { type: 'string' },
    street_address: { type: 'string' },
    extended_address: { type: 'string' },
    address_locality: { type: 'string' },
    address_region: { type: 'string' },
    postal_code: { type: 'string' },
    address_country: { type: 'string' },
  },
}

const UPDATE_CHECKOUT_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
    // Per UCP spec: line_items is required on update (ucp_request: {update: "required"}).
    // UCP is full-replace — the client must resend the complete checkout state each call.
    checkout: {
      type: 'object',
      required: ['line_items'],
      properties: {
        line_items: LINE_ITEMS_SCHEMA,
        fulfillment: {
          type: 'object',
          properties: {
            methods: {
              type: 'array',
              items: {
                type: 'object',
                required: ['line_item_ids'],
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string' },
                  line_item_ids: { type: 'array', items: { type: 'string' } },
                  selected_destination_id: { type: 'string' },
                  destinations: {
                    type: 'array',
                    items: FULFILLMENT_DESTINATION_SCHEMA,
                  },
                  groups: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        selected_option_id: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        buyer: { type: 'object' },
        payment_method: { type: 'object' },
      },
    },
    meta: { type: 'object' },
  },
}

const COMPLETE_CHECKOUT_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
    meta: { type: 'object' },
  },
}

const GET_CHECKOUT_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
  },
}

// MCP tools/list response bodies keyed by capability. The dispatcher fetches
// tools/list once per capability per discovery TTL. All shopping tools live
// under dev.ucp.shopping so one call covers all ops.
const TOOLS_LIST = [
  {
    name: 'search_catalog',
    description: 'Search products and variants by keyword, filters, or pagination.',
    inputSchema: SEARCH_CATALOG_SCHEMA,
  },
  {
    name: 'create_cart',
    description: 'Create a new shopping cart with one or more line items.',
    inputSchema: CREATE_CART_SCHEMA,
  },
  {
    name: 'create_checkout',
    description:
      'Create a checkout from direct line_items, or convert an existing cart with checkout.cart_id plus checkout.line_items.',
    inputSchema: CREATE_CHECKOUT_SCHEMA,
  },
  {
    name: 'get_checkout',
    description: 'Fetch current checkout state including delivery_options and cost.',
    inputSchema: GET_CHECKOUT_SCHEMA,
  },
  {
    name: 'update_checkout',
    description:
      'Update checkout with fulfillment destinations, selected options, and payment method.',
    inputSchema: UPDATE_CHECKOUT_SCHEMA,
  },
  {
    name: 'complete_checkout',
    description:
      'Place the order. May return requires_buyer_review escalation if the business requires manual review.',
    inputSchema: COMPLETE_CHECKOUT_SCHEMA,
  },
]

// Per-tool tools/call response factories. Return the inner UCP payload as a
// plain object; the mock MCP handler wraps it in content[0].text.
function handleToolCall(
  name: string,
  _args: Record<string, unknown>,
  _businessUrl: string,
): object {
  switch (name) {
    case 'search_catalog':
      return {
        products: [
          {
            id: 'gid://mock/Product/prod_1',
            title: 'Forest Park Trail Map (Adventure Map)',
            description: 'Waterproof topo map of Forest Park trails.',
            variants: [
              {
                id: MOCK_VARIANT_ID,
                title: 'Default Title',
                price: { amount: '24.95', currency_code: 'USD' },
                available: true,
              },
            ],
          },
        ],
        pagination: { has_next_page: false },
      }

    case 'create_cart':
      // Flat response — UCP cart schema has id/line_items/etc at top level, no cart wrapper.
      return {
        id: MOCK_CART_ID,
        line_items: [
          {
            id: 'gid://mock/CartLine/li_1',
            quantity: 1,
            item: { id: MOCK_VARIANT_ID, title: 'Forest Park Trail Map' },
            cost: { total_amount: { amount: '24.95', currency_code: 'USD' } },
          },
        ],
        currency: 'USD',
        totals: [
          { type: 'subtotal', amount: 2495, display_text: 'Subtotal' },
          { type: 'total', amount: 2495, display_text: 'Total' },
        ],
      }

    case 'create_checkout':
      // Flat response — UCP checkout schema has id/line_items/etc at top level.
      return {
        id: MOCK_CHECKOUT_ID,
        line_items: [
          {
            id: 'gid://mock/CheckoutLine/li_1',
            quantity: 1,
            item: { id: MOCK_VARIANT_ID, title: 'Forest Park Trail Map' },
          },
        ],
        fulfillment: {
          methods: [
            {
              id: 'shipping',
              type: 'shipping',
              line_item_ids: ['gid://mock/CheckoutLine/li_1'],
              destinations: [],
              groups: [
                {
                  id: 'gid://mock/FulfillmentGroup/fg_1',
                  line_item_ids: ['gid://mock/CheckoutLine/li_1'],
                  options: [
                    {
                      id: 'standard-free',
                      title: 'Standard Shipping',
                      description: '3-5 business days',
                      totals: [{ type: 'total', amount: 0 }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        status: 'incomplete',
      }

    case 'get_checkout':
      return {
        id: MOCK_CHECKOUT_ID,
        line_items: [
          { id: 'gid://mock/CheckoutLine/li_1', quantity: 1, item: { id: MOCK_VARIANT_ID } },
        ],
        fulfillment: {
          methods: [
            {
              id: 'shipping',
              type: 'shipping',
              line_item_ids: ['gid://mock/CheckoutLine/li_1'],
              selected_destination_id: 'dest_1',
              destinations: [
                {
                  id: 'dest_1',
                  first_name: 'Test',
                  last_name: 'Agent',
                  street_address: '123 Main St',
                  address_locality: 'Portland',
                  address_region: 'OR',
                  postal_code: '97201',
                  address_country: 'US',
                },
              ],
              groups: [
                {
                  id: 'gid://mock/FulfillmentGroup/fg_1',
                  line_item_ids: ['gid://mock/CheckoutLine/li_1'],
                  selected_option_id: 'standard-free',
                  options: [
                    {
                      id: 'standard-free',
                      title: 'Standard Shipping',
                      totals: [{ type: 'total', amount: 0 }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        status: 'ready_for_complete',
      }

    case 'update_checkout':
      return {
        id: MOCK_CHECKOUT_ID,
        line_items: [
          { id: 'gid://mock/CheckoutLine/li_1', quantity: 1, item: { id: MOCK_VARIANT_ID } },
        ],
        fulfillment: {
          methods: [
            {
              id: 'shipping',
              type: 'shipping',
              line_item_ids: ['gid://mock/CheckoutLine/li_1'],
              selected_destination_id: 'dest_1',
              destinations: [
                {
                  id: 'dest_1',
                  first_name: 'Test',
                  last_name: 'Agent',
                  street_address: '123 Main St',
                  address_locality: 'Portland',
                  address_region: 'OR',
                  postal_code: '97201',
                  address_country: 'US',
                },
              ],
              groups: [
                {
                  id: 'gid://mock/FulfillmentGroup/fg_1',
                  line_item_ids: ['gid://mock/CheckoutLine/li_1'],
                  selected_option_id: 'standard-free',
                },
              ],
            },
          ],
        },
        status: 'ready_for_complete',
      }

    case 'complete_checkout':
      // Always returns requires_escalation so eval can assert hook behavior.
      // Per UCP spec, requires_escalation is a checkout status value — the
      // flat checkout response has status/continue_url/messages at top level.
      return {
        id: MOCK_CHECKOUT_ID,
        status: 'requires_escalation',
        continue_url: MOCK_ESCALATION_URL,
        messages: [
          {
            type: 'error',
            code: 'buyer_review_required',
            severity: 'requires_buyer_review',
            content: 'Order requires buyer review before completion.',
          },
        ],
      }

    default:
      return { error: `unknown tool: ${name}` }
  }
}

// JSON-RPC 2.0 envelope helpers.
function jsonRpc(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function mcpContent(id: unknown, payload: object, isError = false): string {
  return jsonRpc(id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError,
  })
}

// Read the full request body from a Node.js IncomingMessage.
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

// MCP JSON-RPC handler: dispatches tools/list and tools/call.
async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  businessUrl: string,
): Promise<void> {
  const body = JSON.parse(await readBody(req)) as {
    jsonrpc: string
    id: unknown
    method: string
    params?: { name?: string; arguments?: Record<string, unknown> }
  }
  const { id, method, params } = body

  res.setHeader('content-type', 'application/json')

  if (method === 'tools/list') {
    res.end(jsonRpc(id, { tools: TOOLS_LIST }))
    return
  }

  if (method === 'tools/call') {
    const name = params?.name ?? ''
    const args = params?.arguments ?? {}
    const payload = handleToolCall(name, args, businessUrl)
    // All tools return isError:false — requires_escalation is a checkout status
    // value within the content, not an MCP-level error.
    res.end(mcpContent(id, payload))
    return
  }

  // Unknown method → JSON-RPC method-not-found error.
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }),
  )
}

export interface MockUcpShopping extends MockBusiness {
  /** The URL the MCP endpoint is served at (the `endpoint` in the UCP profile). */
  mcpEndpoint: string
}

/**
 * Start a fully-wired mock UCP shopping business. Returns a handle with:
 * - `url`: the business origin (used as `--business` arg)
 * - `mcpEndpoint`: the MCP endpoint URL (embedded in the UCP profile)
 * - `close()`: tear down the HTTP server
 *
 * The server serves `/.well-known/ucp` and `POST /mcp` only.
 * All other routes return the mock-business 404.
 */
export async function startMockUcpShopping(): Promise<MockUcpShopping> {
  const mock = await startMockBusiness()
  const { url } = mock

  // Profile served at /.well-known/ucp — must pass parsePlatformProfile zod validation.
  const profile = {
    ucp: {
      version: '2026-04-08',
      status: 'success',
      services: {
        'dev.ucp.shopping': [
          {
            version: '2026-01-23',
            spec: 'https://ucp.dev/specification/overview/',
            schema: 'https://ucp.dev/services/shopping/openrpc.json',
            transport: 'mcp',
            endpoint: `${url}/mcp`,
          },
        ],
      },
      payment_handlers: {},
    },
    signing_keys: [],
  }

  mock.setRoute('GET', '/.well-known/ucp', (_req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(profile))
  })

  mock.setRoute('POST', '/mcp', (req, res) => {
    return handleMcp(req, res, url)
  })

  return { ...mock, mcpEndpoint: `${url}/mcp` }
}
