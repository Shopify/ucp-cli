// Permalink builder tests (UCP 2026-08-25 specification/permalink).
//
// Pins the URL grammar (compact item path + pointer query), item-token
// encoding, budget classification, endpoint resolution from a business
// rendering, and the client-side refusal policy for secrets, payment data,
// server-owned fields, and buyer prefill.

import { describe, expect, it } from 'vitest'

import {
  buildPermalink,
  encodeItemToken,
  PERMALINK_CAPABILITY,
  resolvePermalinkEndpoint,
  unrecognizedPermalinkFields,
} from './permalink.js'

const ENDPOINT = 'https://merchant.example/buy'
const GID = 'gid://shopify/ProductVariant/42103178002526'
// base64url("gid://shopify/ProductVariant/42103178002526"), unpadded.
const GID_TOKEN = '~Z2lkOi8vc2hvcGlmeS9Qcm9kdWN0VmFyaWFudC80MjEwMzE3ODAwMjUyNg'

const line = (id: string, quantity = 1) => ({ item: { id }, quantity })

describe('encodeItemToken', () => {
  it('passes ids matching ^[A-Za-z0-9._-]+$ through raw', () => {
    expect(encodeItemToken('sku_123')).toBe('sku_123')
    expect(encodeItemToken('42103178002526')).toBe('42103178002526')
    expect(encodeItemToken('a.b-c_d')).toBe('a.b-c_d')
  })

  it('encodes anything else as ~ + unpadded base64url of the UTF-8 id', () => {
    expect(encodeItemToken(GID)).toBe(GID_TOKEN)
    const token = encodeItemToken('café/1')
    expect(token.startsWith('~')).toBe(true)
    expect(token).not.toMatch(/[=+/]/)
    expect(Buffer.from(token.slice(1), 'base64url').toString('utf8')).toBe('café/1')
  })
})

describe('buildPermalink — URL grammar', () => {
  it('single item: endpoint + compact path, no query', () => {
    const built = buildPermalink({ endpoint: ENDPOINT, body: { line_items: [line('sku_123')] } })
    expect(built.url).toBe('https://merchant.example/buy/sku_123:1')
    expect(built.items).toEqual([{ id: 'sku_123', quantity: 1, token: 'sku_123' }])
    expect(built.fields).toEqual([])
    expect(built.buyer_prefill).toBe(false)
  })

  it('reproduces the spec campaign example (items, continue_to, discount, attribution)', () => {
    const built = buildPermalink({
      endpoint: ENDPOINT,
      continueTo: '/collections/spring',
      body: {
        line_items: [line('sku_123', 1), line('sku_456', 2)],
        discounts: { codes: ['SPRING10'] },
        attribution: { utm_source: 'email' },
      },
    })
    expect(built.url).toBe(
      'https://merchant.example/buy/sku_123:1,sku_456:2?continue_to=/collections/spring&discounts/codes/0=SPRING10&attribution/utm_source=email',
    )
    expect(built.fields).toEqual(['continue_to', 'discounts/codes/0', 'attribution/utm_source'])
  })

  it('reproduces the spec buyer-directed example once prefill is allowed', () => {
    const built = buildPermalink({
      endpoint: ENDPOINT,
      allowBuyerPrefill: true,
      body: {
        line_items: [line('sku_kit', 3)],
        discounts: { codes: ['VIP20'] },
        buyer: { email: 'alice@foo.com' },
        context: { postal_code: '94105', payment: [{ handler: 'com.example.wallet' }] },
        attribution: { ref: 'creator_42' },
      },
    })
    expect(built.url).toBe(
      'https://merchant.example/buy/sku_kit:3?discounts/codes/0=VIP20&buyer/email=alice%40foo.com&context/postal_code=94105&context/payment/0/handler=com.example.wallet&attribution/ref=creator_42',
    )
    expect(built.buyer_prefill).toBe(true)
  })

  it('encodes Shopify GIDs as ~base64url tokens in the item path', () => {
    const built = buildPermalink({
      endpoint: 'https://rothys.com/buy',
      body: { line_items: [line(GID, 2)] },
    })
    expect(built.url).toBe(`https://rothys.com/buy/${GID_TOKEN}:2`)
  })

  it('sends non-id line item fields as line_items/N/* query paths', () => {
    const built = buildPermalink({
      endpoint: ENDPOINT,
      body: { line_items: [{ item: { id: 'sku_1' }, quantity: 1, selling_plan: 'sp_9' }] },
    })
    expect(built.url).toBe('https://merchant.example/buy/sku_1:1?line_items/0/selling_plan=sp_9')
  })

  it('JSON-Pointer-escapes keys containing / or ~ and percent-encodes values', () => {
    const built = buildPermalink({
      endpoint: ENDPOINT,
      body: { line_items: [line('a')], 'com.example.x': { 'a/b~c': 'hello world&more' } },
    })
    expect(built.url).toBe(
      'https://merchant.example/buy/a:1?com.example.x/a~1b~0c=hello%20world%26more',
    )
    expect(built.fields).toEqual(['com.example.x/a/b~c'])
  })

  it('classifies the URL against the spec budgets (512 qr, 1024 sms, 2048 email)', () => {
    const short = buildPermalink({ endpoint: ENDPOINT, body: { line_items: [line('a')] } })
    expect(short.fits).toEqual(['qr', 'sms', 'email'])
    expect(short.octets).toBe(Buffer.byteLength(short.url))

    const pad = (octets: number) =>
      buildPermalink({
        endpoint: ENDPOINT,
        body: { line_items: [line('a')], attribution: { ref: 'x'.repeat(octets) } },
      })
    expect(pad(600).fits).toEqual(['sms', 'email'])
    expect(pad(1500).fits).toEqual(['email'])
  })

  it('refuses a URL over 2048 octets (Shopify opens it without a cart)', () => {
    expect(() =>
      buildPermalink({
        endpoint: ENDPOINT,
        body: { line_items: [line('a')], attribution: { ref: 'x'.repeat(2100) } },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(/over the 2048-octet maximum/),
      }),
    )
  })
})

describe('buildPermalink — input validation', () => {
  it.each([
    [{}, /at least one line item/],
    [{ line_items: [] }, /at least one line item/],
    [{ line_items: [{ quantity: 1 }] }, /line_items\/0\/item\/id/],
    [{ line_items: [{ item: { id: '' }, quantity: 1 }] }, /line_items\/0\/item\/id/],
    [{ line_items: [{ item: { id: 42103178002526 }, quantity: 1 }] }, /--set-string/],
    [{ line_items: [{ item: { id: 'a' } }] }, /line_items\/0\/quantity must be a positive integer/],
    [{ line_items: [line('a', 0)] }, /positive integer/],
    [{ line_items: [line('a', 1.5)] }, /positive integer/],
    [{ line_items: [line('a')], context: { postal_code: null } }, /context\/postal_code is null/],
    [{ line_items: [line('a')], context: { postal_code: '' } }, /context\/postal_code is empty/],
    // Control characters make Shopify reject the whole link (no cart).
    [{ line_items: [line('a')], attribution: { utm_content: 'a\nb' } }, /control character/],
    [{ line_items: [line('a')], discounts: { codes: ['WELCOME\t10'] } }, /control character/],
    [{ line_items: [line('a')], context: { 'postal\u0000code': '1' } }, /control character/],
    [{ line_items: [line('a\u0007')] }, /line_items\/0\/item\/id contains a control character/],
    // Shopify resolves only ProductVariant GIDs.
    [{ line_items: [line('gid://shopify/Product/7474412290142')] }, /Shopify Product id/],
    [{ line_items: [line('a')], '': 'x' }, /empty field name/],
    [{ line_items: [line('a')], context: { '': 'x' } }, /context\/ has an empty field name/],
    // `--set` JSON-parses values: 1.50 → 1.5, long codes lose digits.
    [{ line_items: [line('a')], discounts: { codes: [1.5] } }, /--set-string/],
    [{ line_items: [line('a')], discounts: { codes: [12345678901234567000] } }, /--set-string/],
    [{ line_items: [line('a')], continue_to: '/collections/flats' }, /--continue-to/],
  ])('%j → INVALID_INPUT', (body, message) => {
    expect(() => buildPermalink({ endpoint: ENDPOINT, body })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringMatching(message) }),
    )
  })

  it.each([
    'collections/flats',
    '//evil.example/x',
    'https://evil.example',
    '/a\\b',
    '/a b',
    '/collections/flats?filter.v.option.size=8',
    '/a#top',
    '/a\u0000b',
  ])(
    'rejects --continue-to %j (same-origin path, no query or fragment)',
    (continueTo) => {
      expect(() =>
        buildPermalink({ endpoint: ENDPOINT, continueTo, body: { line_items: [line('a')] } }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    },
  )
})

describe('buildPermalink — refusal policy', () => {
  const refuse = (extra: Record<string, unknown>, message: RegExp, allowBuyerPrefill = false) =>
    expect(() =>
      buildPermalink({
        endpoint: ENDPOINT,
        allowBuyerPrefill,
        body: { line_items: [line('a')], ...extra },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringMatching(message) }),
    )

  it('refuses payment blocks, even empty ones', () => {
    refuse({ payment: { instruments: [{ credential: { token: 'tok_1' } }] } }, /payment/)
    refuse({ payment: { instruments: [] } }, /payment instruments and credentials/)
  })

  it('accepts Shopify ProductVariant GIDs and safe integers', () => {
    const built = buildPermalink({
      endpoint: ENDPOINT,
      body: {
        line_items: [line('gid://shopify/ProductVariant/42103178002526')],
        context: { eligibility: [1000] },
      },
    })
    expect(built.fields).toEqual(['context/eligibility/0'])
  })

  it('allows only a handler preference under context/payment', () => {
    refuse({ context: { payment: [{ handler: 'h', token: 't' }] } }, /context\/payment\/0\/token/)
    refuse({ context: { payment: [{ instrument: 'i' }] } }, /only context\/payment\/<n>\/handler/)
  })

  it('refuses server-owned fields (a pasted cart response)', () => {
    refuse({ id: 'cart_1' }, /server-owned/)
    refuse({ totals: [{ type: 'total', amount: 100 }] }, /server-owned/)
    refuse({ status: 'ready' }, /server-owned/)
    refuse({ continue_url: 'https://x' }, /server-owned/)
    expect(() =>
      buildPermalink({
        endpoint: ENDPOINT,
        body: { line_items: [{ id: 'line_1', item: { id: 'a' }, quantity: 1 }] },
      }),
    ).toThrowError(expect.objectContaining({ message: expect.stringMatching(/line_items\/0\/id/) }))
  })

  it('refuses credential-looking segments anywhere in the path', () => {
    refuse({ context: { access_token: 'x' } }, /access_token.*credential/)
    refuse({ 'com.example.auth': { api_key: 'x' } }, /api_key/)
    refuse({ attribution: { Password: 'x' } }, /Password/)
  })

  it('refuses buyer prefill unless opted in, and flags it when allowed', () => {
    refuse({ buyer: { email: 'alice@foo.com' } }, /--allow-buyer-prefill/)
    refuse({ buyer: {} }, /--allow-buyer-prefill/)
    const built = buildPermalink({
      endpoint: ENDPOINT,
      allowBuyerPrefill: true,
      body: { line_items: [line('a')], buyer: { first_name: 'Alice' } },
    })
    expect(built.buyer_prefill).toBe(true)
  })

  it('rejects a library-supplied endpoint that breaks the spec pattern', () => {
    for (const endpoint of [
      'http://merchant.example/buy',
      'https://merchant.example/buy/',
      'https://merchant.example/buy?x=1',
      'https://user@merchant.example/buy',
    ]) {
      expect(() => buildPermalink({ endpoint, body: { line_items: [line('a')] } })).toThrowError(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      )
    }
  })
})

describe('resolvePermalinkEndpoint', () => {
  const ROTHYS_CAPABILITIES = {
    'dev.ucp.shopping.cart': [{ version: '2026-08-25' }],
    [PERMALINK_CAPABILITY]: [
      {
        version: '2026-08-25',
        spec: 'https://ucp.dev/2026-08-25/specification/permalink/',
        schema: 'https://ucp.dev/2026-08-25/schemas/shopping/permalink.json',
        config: { endpoint: 'https://rothys.com/buy' },
      },
    ],
  }

  it('reads config.endpoint at the rendering version (live rothys.com shape)', () => {
    expect(
      resolvePermalinkEndpoint({
        capabilities: ROTHYS_CAPABILITIES,
        version: '2026-08-25',
        business: 'https://rothys.com',
      }),
    ).toEqual({ endpoint: 'https://rothys.com/buy', version: '2026-08-25' })
  })

  it('CAPABILITY_NOT_OFFERED when absent or only at another version', () => {
    for (const capabilities of [
      undefined,
      {},
      { [PERMALINK_CAPABILITY]: [] },
      ROTHYS_CAPABILITIES, // asked at 2026-04-08 below
    ]) {
      expect(() =>
        resolvePermalinkEndpoint({ capabilities, version: '2026-04-08', business: 'https://b' }),
      ).toThrowError(
        expect.objectContaining({ code: 'CAPABILITY_NOT_OFFERED', layer: 'transport' }),
      )
    }
  })

  it('PROFILE_SCHEMA_INVALID when the business advertises a malformed endpoint', () => {
    for (const config of [
      undefined,
      {},
      { endpoint: 'http://rothys.com/buy' },
      { endpoint: 'https://rothys.com/buy/' },
    ]) {
      expect(() =>
        resolvePermalinkEndpoint({
          capabilities: { [PERMALINK_CAPABILITY]: [{ version: '2026-08-25', config }] },
          version: '2026-08-25',
          business: 'https://rothys.com',
        }),
      ).toThrowError(expect.objectContaining({ code: 'PROFILE_SCHEMA_INVALID' }))
    }
  })
})

describe('unrecognizedPermalinkFields', () => {
  // Trimmed from rothys.com's live create_cart inputSchema.
  const CREATE_CART = {
    type: 'object',
    properties: {
      meta: { type: 'object' },
      cart: {
        type: 'object',
        properties: {
          line_items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                item: { type: 'object', properties: { id: { type: 'string' } } },
                quantity: { type: 'integer' },
              },
            },
          },
          context: { type: 'object' },
          buyer: { type: 'object' },
          discounts: { type: 'object', properties: { codes: { type: 'array' } } },
          attribution: { type: 'object' },
          fulfillment: { type: 'object' },
        },
      },
    },
  }
  const check = (body: Record<string, unknown>, schema: unknown = CREATE_CART) =>
    unrecognizedPermalinkFields({ createCartInputSchema: schema, body })

  it('returns [] for a body using only listed fields', () => {
    expect(
      check({
        line_items: [{ item: { id: 'a' }, quantity: 1 }],
        discounts: { codes: ['W10'] },
        attribution: { utm_source: 'x' },
      }),
    ).toEqual([])
  })

  it('names misspelled fields as permalink query paths, top-level and nested', () => {
    expect(
      check({
        line_items: [{ item: { id: 'a' }, quantity: 1, qty: 2 }],
        discount_codes: ['W10'],
        discounts: { code: 'W10' },
      }),
    ).toEqual(['line_items/0/qty', 'discount_codes', 'discounts/code'])
  })

  it('flags reverse-DNS extension keys the schema does not list (the business drops them)', () => {
    expect(
      check({
        line_items: [{ item: { id: 'a' }, quantity: 1 }],
        'com.example.loyalty': { tier: 'gold' },
      }),
    ).toEqual(['com.example.loyalty'])
  })

  it('skips context/payment/<n>/handler, which the permalink capability defines', () => {
    const schema = structuredClone(CREATE_CART)
    schema.properties.cart.properties.context = {
      type: 'object',
      properties: { postal_code: { type: 'string' } },
    } as typeof schema.properties.cart.properties.context
    expect(
      check(
        {
          line_items: [{ item: { id: 'a' }, quantity: 1 }],
          context: { postal_code: '10001', payment: [{ handler: 'shop_pay' }] },
        },
        schema,
      ),
    ).toEqual([])
  })

  it('spells paths like BuiltPermalink.fields (unescaped segments)', () => {
    expect(
      check({ line_items: [{ item: { id: 'a' }, quantity: 1 }], 'a/b~c': 'x' }),
    ).toEqual(['a/b~c'])
  })

  it('returns undefined when the schema has no inspectable cart.properties', () => {
    expect(check({ line_items: [] }, { type: 'object' })).toBeUndefined()
    expect(check({ line_items: [] }, { properties: { cart: { type: 'object' } } })).toBeUndefined()
    expect(check({ line_items: [] }, null)).toBeUndefined()
  })
})
