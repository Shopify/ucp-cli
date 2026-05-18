// `dev.ucp.shopping` service binding.
//
// All thirteen helpers route through the generic `serviceOp` factory in
// core/operation.ts. This file owns one thing: the mapping from the UCP
// shopping service's published tool names to typed CLI/library helpers.
//
// Per spec/source/services/shopping/mcp.openrpc.json, every tool's params
// are { meta, …body } where:
//   - `meta.ucp-agent` is dispatcher-injected (protocol-owned)
//   - `meta.idempotency-key` is dispatcher-injected when caller doesn't supply one
//   - the body shape varies per sub-domain (see headers below)
//
// Sub-domain wire shapes — pinned here as documentation; tests in
// shopping.test.ts validate them against mocked tools/list schemas.
//
// New UCP services (payments, identity, …) get their own file in this
// directory, parallel to this one. The dispatcher stays generic.

import { serviceOp } from '../core/operation.js'

// Service-level capability id. Surface helpers (catalog/cart/checkout/order)
// all dispatch through the same MCP endpoint advertised under this service;
// fine-grained capabilities (`dev.ucp.shopping.cart`,
// `dev.ucp.shopping.catalog.lookup`, …) are feature flags surfaced via
// tools/list, not separate transport endpoints.
const SHOPPING = 'dev.ucp.shopping'

const op = (toolName: string, opName: string) => serviceOp(SHOPPING, toolName, opName)

// ─── catalog ─────────────────────────────────────────────────────────────────
// Body nests under /catalog. Three tools across two fine-grained capabilities:
// search behind dev.ucp.shopping.catalog.search; lookup AND get_product share
// dev.ucp.shopping.catalog.lookup. CLI surfaces stay distinct because batch vs.
// single-detail vs. free-text are meaningfully different UX, but the
// dispatcher treats them as ordinary tool calls.
//   search_catalog → { meta, catalog }
//   lookup_catalog → { meta, catalog }
//   get_product    → { meta, catalog }

export const searchCatalog = op('search_catalog', 'catalog')
export const lookupCatalog = op('lookup_catalog', 'catalog')
export const getProduct = op('get_product', 'catalog')

// ─── cart ────────────────────────────────────────────────────────────────────
// `id` lives at the top level (unlike catalog), body under /cart. Discount /
// fulfillment / buyer_consent extension fields ride on the cart object — a
// business advertising those capabilities just expands the accepted shape of
// /cart, no new dispatch path.
//   create_cart → { meta, cart }
//   get_cart    → { meta, id }
//   update_cart → { meta, id, cart }
//   cancel_cart → { meta, id }   (idempotency-key required)

export const createCart = op('create_cart', 'cart')
export const getCart = op('get_cart', 'cart')
export const updateCart = op('update_cart', 'cart')
export const cancelCart = op('cancel_cart', 'cart')

// ─── checkout ────────────────────────────────────────────────────────────────
// Same envelope conventions as cart — `id` at top level, body under /checkout.
// complete_checkout places an order; cancel_checkout aborts. Both require
// idempotency-key per spec (auto-injected by the dispatcher).
//   create_checkout   → { meta, checkout }
//   get_checkout      → { meta, id }
//   update_checkout   → { meta, id, checkout }
//   complete_checkout → { meta, id }             (idempotency-key required)
//   cancel_checkout   → { meta, id }             (idempotency-key required)

export const createCheckout = op('create_checkout', 'checkout')
export const getCheckout = op('get_checkout', 'checkout')
export const updateCheckout = op('update_checkout', 'checkout')
export const completeCheckout = op('complete_checkout', 'checkout')
export const cancelCheckout = op('cancel_checkout', 'checkout')

// ─── order ───────────────────────────────────────────────────────────────────
// Single read op for post-purchase state inspection. There is no create_order
// — orders are placed via complete_checkout. Cancel/refund/fulfillment-status
// flows live in extension capabilities, not here.
//   get_order → { meta, id }

export const getOrder = op('get_order', 'order')
