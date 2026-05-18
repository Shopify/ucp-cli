// Package-local view artifacts under skills/ucp/views/*.jmespath.
//
// These are kick-the-tires templates shipped alongside the skill. The CLI can
// load them by alias (`--view :compact`) or users can reference them directly
// via `--view @<path>`. The tests here pin two things:
//
//   1. Every shipped view compiles. A typo in a package-local file would silently
//      break the documented examples for every user; the test makes a parse
//      error fail loudly at CI time instead.
//   2. Each view produces the documented envelope shape against a realistic
//      response fixture for its target tool. Because applyView operates at
//      envelope level (the view's output IS the new envelope), each package-local
//      view re-emits `{ucp: {version, status}, result: {...}}` — keeping the
//      protocol confirmation while dropping dispatch identity noise.
//
// Fixtures mirror the wire shapes documented in dev.shopify.catalog.md and
// the cart spec (line_items + totals[type=...] array), with `ucp` already
// hoisted as a sibling of `result` (per cli.ts:hoistUcp).
//
// If the wire shape evolves and a view goes stale, this test is the canary.
// Update the fixture + view together — never one without the other.
//
// We exercise the actual `resolveView` + `applyView` pair, not raw
// `compile()`, so the `@file` load path is also pinned end-to-end.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { applyView, resolveView } from './view.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const VIEWS = resolve(HERE, '../../skills/ucp/views')

const UCP = { version: '2026-04-08', status: 'ok' }

describe('skills/ucp/views/*.jmespath — package-local view artifacts', () => {
  describe('catalog.compact.jmespath', () => {
    it('extracts per-product title/price/buy + first-variant id (single merchant)', async () => {
      const view = await resolveView({ raw: `@${VIEWS}/catalog.compact.jmespath` })
      const envelope = {
        ucp: UCP,
        result: {
          products: [
            {
              id: 'gid://shopify/Product/101',
              title: 'Classic Blue Oxford Shirt',
              price_range: {
                min: { amount: 7500, currency: 'USD' },
                max: { amount: 7500, currency: 'USD' },
              },
              variants: [
                {
                  id: 'gid://shopify/ProductVariant/201',
                  checkout_url: 'https://example.myshopify.com/cart/201:1',
                },
              ],
            },
          ],
        },
      }
      const out = applyView(envelope, view)
      expect(out).toEqual({
        ucp: UCP,
        result: [
          {
            title: 'Classic Blue Oxford Shirt',
            price: 7500,
            currency: 'USD',
            variant: 'gid://shopify/ProductVariant/201',
            buy: 'https://example.myshopify.com/cart/201:1',
          },
        ],
      })
    })

    it('keeps compact display-only by omitting seller routing/display fields', async () => {
      // `:compact` is intentionally a small kick-the-tires view. Agents that
      // need a follow-up cart/checkout step should use `:summary` or a custom
      // projection that keeps `variants[M].seller.domain`.
      const view = await resolveView({ raw: `@${VIEWS}/catalog.compact.jmespath` })
      const envelope = {
        ucp: UCP,
        result: {
          products: [
            {
              title: 'Birdbath',
              price_range: { min: { amount: 4500, currency: 'USD' } },
              variants: [
                {
                  id: 'v1',
                  checkout_url: 'https://bird-bath-store.example.com/checkouts/abc',
                  seller: {
                    domain: 'bird-bath-store.myshopify.com',
                    url: 'https://bird-bath-store.example.com',
                  },
                },
              ],
            },
          ],
        },
      }
      const out = applyView(envelope, view) as { result: Array<Record<string, unknown>> }
      expect(out.result[0]).not.toHaveProperty('seller_domain')
      expect(out.result[0]).not.toHaveProperty('seller_url')
    })
  })

  describe('catalog.summary.jmespath', () => {
    it('counts products and computes a price range', async () => {
      const view = await resolveView({ raw: `@${VIEWS}/catalog.summary.jmespath` })
      const envelope = {
        ucp: UCP,
        result: {
          products: [
            {
              price_range: {
                min: { amount: 7500, currency: 'USD' },
                max: { amount: 9000, currency: 'USD' },
              },
              variants: [{ seller: { url: 'https://a.example.com' } }],
            },
            {
              price_range: {
                min: { amount: 3000, currency: 'USD' },
                max: { amount: 3500, currency: 'USD' },
              },
              variants: [{ seller: { url: 'https://b.example.com' } }],
            },
          ],
        },
      }
      const out = applyView(envelope, view)
      expect(out).toEqual({
        ucp: UCP,
        result: {
          count: 2,
          sellers: ['https://a.example.com', 'https://b.example.com'],
          price_min: 3000,
          price_max: 9000,
        },
      })
    })

    it('compacts missing seller.url (single-merchant responses come back as empty list)', async () => {
      const view = await resolveView({ raw: `@${VIEWS}/catalog.summary.jmespath` })
      const envelope = {
        ucp: UCP,
        result: {
          products: [
            {
              price_range: { min: { amount: 100 }, max: { amount: 200 } },
              variants: [{ id: 'v1' }],
            },
          ],
        },
      }
      const out = applyView(envelope, view) as { result: { sellers: unknown[] } }
      // [?@] filters out null/undefined; with no seller.url on any variant
      // the sellers list is empty — NOT `[null]` (would surprise --format md).
      expect(out.result.sellers).toEqual([])
    })
  })

  describe('cart.summary.jmespath', () => {
    it('extracts cart identity + totals by type from the flat cart envelope', async () => {
      const view = await resolveView({ raw: `@${VIEWS}/cart.summary.jmespath` })
      const envelope = {
        ucp: UCP,
        result: {
          id: 'gid://shopify/Cart/abc123',
          currency: 'USD',
          line_items: [
            { item: { id: 'gid://shopify/ProductVariant/201' }, quantity: 2 },
            { item: { id: 'gid://shopify/ProductVariant/202' }, quantity: 1 },
          ],
          totals: [
            { type: 'subtotal', amount: 17500 },
            { type: 'fulfillment', amount: 1200 },
            { type: 'tax', amount: 1450 },
            { type: 'total', amount: 20150 },
          ],
          continue_url: 'https://example.myshopify.com/cart/c/abc123',
          expires_at: '2026-05-13T12:00:00Z',
        },
      }
      const out = applyView(envelope, view)
      expect(out).toEqual({
        ucp: UCP,
        result: {
          id: 'gid://shopify/Cart/abc123',
          items: 2,
          currency: 'USD',
          subtotal: 17500,
          fulfillment: 1200,
          shipping: null,
          total: 20150,
          continue_url: 'https://example.myshopify.com/cart/c/abc123',
          expires_at: '2026-05-13T12:00:00Z',
        },
      })
    })

    it('returns null for missing estimate totals (cart may omit estimate lines)', async () => {
      // Cart response with only subtotal: the estimate filters yield empty arrays,
      // and `| [0].amount` on an empty list is null (jmespath semantics).
      // Pin this so a future jmespath bump doesn't start throwing here.
      const view = await resolveView({ raw: `@${VIEWS}/cart.summary.jmespath` })
      const envelope = {
        ucp: UCP,
        result: {
          id: 'cart_x',
          currency: 'USD',
          line_items: [{ item: { id: 'v1' }, quantity: 1 }],
          totals: [{ type: 'subtotal', amount: 5000 }],
        },
      }
      const out = applyView(envelope, view) as {
        result: {
          fulfillment: unknown
          shipping: unknown
          total: unknown
        }
      }
      expect(out.result.fulfillment).toBeNull()
      expect(out.result.shipping).toBeNull()
      expect(out.result.total).toBeNull()
    })
  })
})
