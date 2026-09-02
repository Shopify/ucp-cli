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

import { z } from 'incur'

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { omitUndefined } from '../lib/omit-undefined.js'
import { formatZodIssues } from '../lib/zod-format.js'
import { fetchCached, ucpHomeDir } from './cache.js'
import { type BusinessProfile, businessProfileSchema } from './generated/business_profile.zod.js'
import { type PlatformProfile, platformProfileSchema } from './generated/platform_profile.zod.js'
import { acceptsHttpsUrl, parseHttpsUrl } from './url.js'

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

const PROFILE_ERROR_CODES = {
  fetchFailed: ErrorCodes.PROFILE_FETCH_FAILED,
  invalidJson: ErrorCodes.PROFILE_INVALID_JSON,
  schemaInvalid: ErrorCodes.PROFILE_SCHEMA_INVALID,
} as const

/**
 * Fetch and validate a business profile from an explicit document URL: the
 * canonical `<origin>/.well-known/ucp`, or a version-specific document linked
 * from `supported_versions`. Callers pick `cacheDir`; `fetchCached` names the
 * file after the URL's origin, so documents that share an origin need
 * distinct directories.
 */
export async function fetchBusinessProfileFromUrl(
  profileUrl: string,
  options: FetchProfileOptions = {},
): Promise<BusinessProfile> {
  return fetchCached<BusinessProfile>(profileUrl, {
    cacheDir: options.cacheDir ?? defaultBusinessCacheDir(),
    schema: businessProfileSchema,
    errorCodes: PROFILE_ERROR_CODES,
    errorLayer: 'transport',
    ...omitUndefined({
      force: options.force,
      fetch: options.fetch,
      signal: options.signal,
      headers: options.headers,
    }),
  })
}

/**
 * Fetch a business profile from `<businessUrl>/.well-known/ucp`.
 */
export async function fetchBusinessProfile(
  businessUrl: string,
  options: FetchProfileOptions = {},
): Promise<BusinessProfile> {
  const baseUrl = parseHttpsUrl(businessUrl, 'business URL')
  return fetchBusinessProfileFromUrl(new URL('/.well-known/ucp', baseUrl).toString(), options)
}

/**
 * The only two fields version selection needs from `/.well-known/ucp`. The
 * top-level document is parsed against this, not the full profile schema,
 * so a future spec release can reshape the profile without also blocking
 * the `supported_versions` fallback that exists to survive exactly that.
 * Every field is preserved (catchall) for the full validation that follows
 * once a rendering is selected.
 */
const profileEnvelopeSchema = z
  .object({
    ucp: z
      .object({
        version: z.string(),
        supported_versions: z.record(z.string(), z.string()).optional(),
      })
      .catchall(z.unknown()),
  })
  .catchall(z.unknown())

/** `min <= version <= max`. ISO `YYYY-MM-DD` strings compare lexicographically. */
export function isVersionInRange(version: string | undefined, range: AgentRange): boolean {
  if (version === undefined) return false
  return version >= range.min && version <= range.max
}

export interface ResolveProfileOptions extends FetchProfileOptions {
  /** Defaults to `AGENT_PROTOCOL_RANGE` (build-time). */
  agentRange?: AgentRange
}

export interface ResolvedBusinessProfile {
  profile: BusinessProfile
  /** URL of the document `profile` was parsed from. */
  profileUrl: string
  /** `profile.ucp.version`; equals the `supported_versions` key when a fallback was taken. */
  version: string
  /** True when `profile` came from `supported_versions`, not `/.well-known/ucp`. */
  fromSupportedVersions: boolean
}

/**
 * Fetch the business profile rendering this agent can negotiate against,
 * per the spec's "Protocol Version" rules:
 *
 *   1. Fetch `/.well-known/ucp`. If its `ucp.version` is inside `agentRange`,
 *      that document is the profile.
 *   2. Otherwise pick the most recent `supported_versions` key inside the
 *      range and fetch the linked document. Its `ucp.version` MUST equal the
 *      key, else the platform MUST NOT use it. Version-specific documents are
 *      leaves: their own `supported_versions` (if any) is not followed.
 *   3. If neither yields a version in range, PROTOCOL_VERSION_INCOMPATIBLE.
 *
 * Version selection deliberately precedes transport negotiation: a top-level
 * document whose version is in range is used even if a lower-version rendering
 * would have offered a nicer transport mix. That is the spec's ordering, and
 * keeps "what did we negotiate against" a function of version alone.
 *
 * Cache layout: the top-level document lives at `<cacheDir>/<origin>.json`;
 * a version-specific document lives at `<cacheDir>/<version>/<origin>.json`
 * (origin of the linked URL, which may differ from the business origin).
 */
export async function fetchCompatibleBusinessProfile(
  businessUrl: string,
  options: ResolveProfileOptions = {},
): Promise<ResolvedBusinessProfile> {
  const { agentRange = AGENT_PROTOCOL_RANGE, ...fetchOptions } = options
  const cacheDir = fetchOptions.cacheDir ?? defaultBusinessCacheDir()
  const baseUrl = parseHttpsUrl(businessUrl, 'business URL')
  const wellKnownUrl = new URL('/.well-known/ucp', baseUrl).toString()

  const top = await fetchCached(wellKnownUrl, {
    cacheDir,
    schema: profileEnvelopeSchema,
    errorCodes: PROFILE_ERROR_CODES,
    errorLayer: 'transport',
    ...omitUndefined({
      force: fetchOptions.force,
      fetch: fetchOptions.fetch,
      signal: fetchOptions.signal,
      headers: fetchOptions.headers,
    }),
  })
  if (isVersionInRange(top.ucp.version, agentRange)) {
    const result = businessProfileSchema.safeParse(top)
    if (!result.success) {
      throw new UcpError({
        layer: 'transport',
        code: ErrorCodes.PROFILE_SCHEMA_INVALID,
        message: `response failed schema validation at ${wellKnownUrl}: ${formatZodIssues(result.error.issues)}`,
      })
    }
    return {
      profile: result.data,
      profileUrl: wellKnownUrl,
      version: top.ucp.version,
      fromSupportedVersions: false,
    }
  }

  const supported = top.ucp.supported_versions
  const offered = Object.keys(supported ?? {}).sort()
  const candidate = offered
    .filter((v) => v !== top.ucp.version && isVersionInRange(v, agentRange))
    .sort()
    .at(-1)
  if (candidate === undefined || supported === undefined) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROTOCOL_VERSION_INCOMPATIBLE,
      message: `business profile is UCP ${top.ucp.version}, outside agent range [${agentRange.min}..${agentRange.max}]; supported_versions offers ${offered.length > 0 ? offered.join(', ') : 'none'}`,
      context: { agentRange, version: top.ucp.version, supportedVersions: offered },
    })
  }

  const versionedUrl = supported[candidate] as string
  if (!acceptsHttpsUrl(versionedUrl)) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROFILE_SCHEMA_INVALID,
      message: `business profile supported_versions["${candidate}"] is not an https URL: ${versionedUrl}`,
      context: { version: candidate, url: versionedUrl },
    })
  }

  const leaf = await fetchBusinessProfileFromUrl(versionedUrl, {
    ...fetchOptions,
    cacheDir: join(cacheDir, candidate),
  })
  if (leaf.ucp.version !== candidate) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROFILE_VERSION_MISMATCH,
      message: `business profile at ${versionedUrl} declares UCP ${leaf.ucp.version} but was linked as supported_versions["${candidate}"]`,
      context: { expected: candidate, actual: leaf.ucp.version, url: versionedUrl },
    })
  }

  return {
    profile: leaf,
    profileUrl: versionedUrl,
    version: candidate,
    fromSupportedVersions: true,
  }
}
