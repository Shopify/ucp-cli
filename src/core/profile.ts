// UCP bilateral profile model.
//
// Platform profiles describe the client side: the agent identity this CLI
// presents to a business. They may omit service endpoints because a platform
// profile can be consumer-only.
//
// Business profiles describe the server side: the commerce surface a business
// publishes at `/.well-known/ucp`. Service endpoints are required before we can
// dispatch. Runtime always knows which side it is parsing, so callers validate
// against the generated branch-specific schemas instead of a broad union.

import { join } from 'node:path'

import type { z } from 'incur'

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { omitUndefined } from '../lib/omit-undefined.js'
import { formatZodIssues } from '../lib/zod-format.js'
import { fetchCached, ucpHomeDir } from './cache.js'
import { type BusinessProfile, businessProfileSchema } from './generated/business_profile.zod.js'
import { type PlatformProfile, platformProfileSchema } from './generated/platform_profile.zod.js'
import { parseHttpsUrl } from './url.js'

export type { BusinessProfile, PlatformProfile }

function parseProfile<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.SCHEMA_VALIDATION_FAILED,
      message: `${label} failed schema validation: ${formatZodIssues(result.error.issues)}`,
    })
  }
  return result.data
}

export function parsePlatformProfile(input: unknown, label = 'platform profile'): PlatformProfile {
  return parseProfile(platformProfileSchema, input, label)
}

export function parseBusinessProfile(input: unknown, label = 'business profile'): BusinessProfile {
  return parseProfile(businessProfileSchema, input, label)
}

/**
 * Temporary profile URL advertised for local profiles until managed upload is
 * wired. This is not a synthetic profile identity; `profile init` is still
 * required to create the local profile files.
 */
export const DEFAULT_PROFILE_URL: string = __DEFAULT_PROFILE_URL__

/**
 * Default catalog business URL — the origin whose `/.well-known/ucp` discovery
 * surfaces the global catalog tools. Used as the runtime fallback for catalog
 * ops when a local profile omits `meta.defaults.catalog` and `UCP_DEFAULT_CATALOG`
 * is unset.
 */
export const DEFAULT_CATALOG_URL: string = __DEFAULT_CATALOG_URL__

/**
 * Local agent profile body template. Used by `profile init` for fresh on-disk
 * profiles. The capability keys here are the source of truth for the
 * response-filter allowlist (see `DEFAULT_AGENT_CAPABILITY_IDS`). Returns a
 * fresh object so callers can mutate safely.
 */
export function localAgentProfileBody(): PlatformProfile {
  return {
    ucp: {
      version: __PROTOCOL_MAX__,
      status: 'success',
      services: {
        'dev.ucp.shopping': [
          {
            version: '2026-01-23',
            spec: 'https://ucp.dev/2026-04-08/specification/overview',
            transport: 'mcp',
            schema: 'https://ucp.dev/2026-04-08/services/shopping/mcp.openrpc.json',
          },
        ],
      },
      capabilities: {
        'dev.ucp.shopping.checkout': [
          {
            version: __PROTOCOL_MAX__,
            spec: 'https://ucp.dev/2026-04-08/specification/checkout',
            schema: 'https://ucp.dev/2026-04-08/schemas/shopping/checkout.json',
          },
        ],
        'dev.ucp.shopping.cart': [
          {
            version: __PROTOCOL_MAX__,
            spec: 'https://ucp.dev/2026-04-08/specification/cart',
            schema: 'https://ucp.dev/2026-04-08/schemas/shopping/cart.json',
          },
        ],
        'dev.ucp.shopping.fulfillment': [
          {
            version: __PROTOCOL_MAX__,
            spec: 'https://ucp.dev/2026-04-08/specification/fulfillment',
            schema: 'https://ucp.dev/2026-04-08/schemas/shopping/fulfillment.json',
            extends: ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.cart'],
          },
        ],
        'dev.ucp.shopping.discount': [
          {
            version: __PROTOCOL_MAX__,
            spec: 'https://ucp.dev/2026-04-08/specification/discount',
            schema: 'https://ucp.dev/2026-04-08/schemas/shopping/discount.json',
            extends: ['dev.ucp.shopping.checkout', 'dev.ucp.shopping.cart'],
          },
        ],
        'dev.ucp.shopping.catalog.search': [
          {
            version: __PROTOCOL_MAX__,
            spec: 'https://ucp.dev/2026-04-08/specification/catalog',
            schema: 'https://ucp.dev/2026-04-08/schemas/shopping/catalog_search.json',
          },
        ],
        'dev.ucp.shopping.catalog.lookup': [
          {
            version: __PROTOCOL_MAX__,
            spec: 'https://ucp.dev/2026-04-08/specification/catalog',
            schema: 'https://ucp.dev/2026-04-08/schemas/shopping/catalog_lookup.json',
          },
        ],
        'dev.ucp.shopping.order': [
          {
            version: __PROTOCOL_MAX__,
            spec: 'https://ucp.dev/2026-04-08/specs/shopping/order',
            schema: 'https://ucp.dev/2026-04-08/schemas/shopping/order.json',
          },
        ],
        'dev.shopify.catalog': [
          {
            version: __PROTOCOL_MAX__,
            spec: 'https://shopify.dev/docs/agents/catalog/storefront-catalog-extension',
            schema: 'https://shopify.dev/ucp/schemas/2026-04-08/shopify_catalog.json',
            extends: ['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.catalog.lookup'],
          },
        ],
        'dev.shopify.catalog.global': [
          {
            version: __PROTOCOL_MAX__,
            spec: 'https://shopify.dev/docs/agents/catalog/global-catalog-extension',
            schema: 'https://shopify.dev/ucp/schemas/2026-04-08/shopify_catalog_global.json',
            extends: ['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.catalog.lookup'],
          },
        ],
      },
      payment_handlers: {},
    },
    signing_keys: [],
  }
}

/**
 * The capability keys advertised by `localAgentProfileBody()`. Materialized
 * once so it can be used as the build-time-frozen response-filter allowlist
 * without re-walking the template on every dispatch.
 */
export const DEFAULT_AGENT_CAPABILITY_IDS: readonly string[] = Object.freeze(
  Object.keys(localAgentProfileBody().ucp.capabilities ?? {}),
)

/** Version range this CLI can negotiate. ISO `YYYY-MM-DD` strings. */
export interface AgentRange {
  min: string
  max: string
}

/**
 * Build-time negotiation range from package.json.
 */
export const AGENT_PROTOCOL_RANGE: AgentRange = {
  min: __PROTOCOL_MIN__,
  max: __PROTOCOL_MAX__,
}

export interface FetchProfileOptions {
  /** Override the cache directory. Defaults to `<ucpHomeDir>/cache/businesses`. */
  cacheDir?: string
  /** AbortSignal forwarded to the underlying fetch. */
  signal?: AbortSignal
  /** Injectable fetch (for tests). */
  fetch?: typeof fetch
  /** Skip the cache read. Cache is still written on success. */
  force?: boolean
  /** Outbound headers (auth, tenancy, etc); forwarded to `fetchCached`. */
  headers?: Record<string, string>
}

function defaultBusinessCacheDir(): string {
  return join(ucpHomeDir(), 'cache', 'businesses')
}

/**
 * Fetch a business profile from `<businessUrl>/.well-known/ucp`.
 */
export async function fetchBusinessProfile(
  businessUrl: string,
  options: FetchProfileOptions = {},
): Promise<BusinessProfile> {
  const baseUrl = parseHttpsUrl(businessUrl, 'business URL')
  const wellKnownUrl = new URL('/.well-known/ucp', baseUrl).toString()
  return fetchCached<BusinessProfile>(wellKnownUrl, {
    cacheDir: options.cacheDir ?? defaultBusinessCacheDir(),
    schema: businessProfileSchema,
    errorCodes: {
      fetchFailed: ErrorCodes.PROFILE_FETCH_FAILED,
      invalidJson: ErrorCodes.PROFILE_INVALID_JSON,
      schemaInvalid: ErrorCodes.PROFILE_SCHEMA_INVALID,
    },
    errorLayer: 'transport',
    ...omitUndefined({
      force: options.force,
      fetch: options.fetch,
      signal: options.signal,
      headers: options.headers,
    }),
  })
}
