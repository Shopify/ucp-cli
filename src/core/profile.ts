// UCP bilateral profile model.
//
// Platform profiles describe the client side: the agent identity this CLI
// presents to a business. They may omit service endpoints because a platform
// profile can be consumer-only.
//
// Business profiles describe the server side: the commerce surface a business
// publishes at `/.well-known/ucp`. Service endpoints are required before we can
// dispatch.
//
// Version model (spec "Protocol Version"): exact-version equality. The agent
// profile declares ONE `ucp.version`; a business is negotiable iff it offers
// that exact version — as its top-level rendering or as a `supported_versions`
// leaf. Compatibility is never inferred from date order. Every parse below
// selects its schema from the release registry (releases.ts) by the document's
// own `ucp.version`.

import { join } from 'node:path'

import { z } from 'incur'

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { omitUndefined } from '../lib/omit-undefined.js'
import { formatZodIssues } from '../lib/zod-format.js'
import { type AgentProfile, agentLabel } from './agent.js'
import { fetchCached, ucpHomeDir } from './cache.js'
import {
  type BusinessProfile,
  LATEST,
  type PlatformProfile,
  RELEASES,
  release,
  type SpecRelease,
  SUPPORTED_VERSIONS,
  type Version,
} from './releases.js'
import { acceptsHttpsUrl, parseHttpsUrl } from './url.js'
import { vlog } from './verbose.js'

// Canonical home of the profile union types is the release registry; these
// re-exports keep profile-consuming modules on the union. Code that statically
// knows its release imports that release's generated module directly.
export type { BusinessProfile, PlatformProfile } from './releases.js'

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

// Release selection for local/authored documents: read `ucp.version` off the
// envelope and pick that release's schema. Unknown version is a structured
// failure; a body with no readable version falls through to the LATEST schema
// so the caller still gets a precise "what's wrong with the shape" message.
const versionEnvelopeSchema = z
  .object({ ucp: z.object({ version: z.string() }).catchall(z.unknown()) })
  .catchall(z.unknown())

/**
 * Select a release for a locally-held document. Returns the unsupported
 * version rather than throwing: the code depends on WHOSE document it is
 * (`AGENT_PROFILE_*` for ours, `PROFILE_*` for a business's), and a code that
 * is a parameter is a code no reader — and no static check — can resolve at
 * the throw site. See `lib/error-layers.test.ts`.
 */
function releaseFor(input: unknown): { rel: SpecRelease } | { unsupportedVersion: string } {
  const envelope = versionEnvelopeSchema.safeParse(input)
  if (!envelope.success) return { rel: RELEASES[LATEST] }
  const version = envelope.data.ucp.version
  const rel = release(version)
  return rel === undefined ? { unsupportedVersion: version } : { rel }
}

export function parsePlatformProfile(input: unknown, label = 'platform profile'): PlatformProfile {
  const selected = releaseFor(input)
  if ('unsupportedVersion' in selected) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.AGENT_PROFILE_VERSION_UNSUPPORTED,
      message: `${label} declares UCP ${selected.unsupportedVersion}; ucp-cli supports ${SUPPORTED_VERSIONS.join(', ')}`,
      context: { version: selected.unsupportedVersion, supported: [...SUPPORTED_VERSIONS] },
    })
  }
  return parseProfile(selected.rel.platformProfileSchema, input, label)
}

// There is deliberately NO `parseBusinessProfile`. Every business document
// the CLI touches arrives through `fetchCompatibleBusinessProfile` below,
// which selects the release from the AGENT profile's version (exact-version
// equality) and reports a version it cannot serve as
// PROTOCOL_VERSION_INCOMPATIBLE. A standalone "parse a business document at
// whatever version it claims" helper had no callers, and the error code that
// existed only for it (`PROFILE_VERSION_UNSUPPORTED`) invited the idea that a
// business's own version selects our schema — it does not.

/**
 * Default catalog business URL — the origin whose `/.well-known/ucp` discovery
 * surfaces the global catalog tools. Used as the runtime fallback for catalog
 * ops when a local profile omits `meta.defaults.catalog` and `UCP_DEFAULT_CATALOG`
 * is unset.
 */
export const DEFAULT_CATALOG_URL: string = __DEFAULT_CATALOG_URL__

// `profile init` writes `release(v).agentProfileJson` — the VERBATIM published
// snapshot of the document `release(v).defaultAgentProfileUrl` serves. Never
// substitute a hand-written template: on the default path the hosted document
// IS the identity, so any local divergence makes `ucp doctor` report drift on
// every clean install.

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
 * distinct directories. `schema` selects the release to validate against;
 * defaults to the latest release's business schema.
 */
export async function fetchBusinessProfileFromUrl(
  profileUrl: string,
  options: FetchProfileOptions & { schema?: z.ZodType<BusinessProfile> } = {},
): Promise<BusinessProfile> {
  return fetchCached<BusinessProfile>(profileUrl, {
    cacheDir: options.cacheDir ?? defaultBusinessCacheDir(),
    schema: options.schema ?? RELEASES[LATEST].businessProfileSchema,
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
 * The only fields version selection needs from `/.well-known/ucp`. The
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

export interface ResolveProfileOptions extends FetchProfileOptions {
  /** The fetched, validated agent identity to negotiate for. */
  agent: AgentProfile
}

export interface ResolvedBusinessProfile {
  profile: BusinessProfile
  /** URL of the document `profile` was parsed from. */
  profileUrl: string
  /** Negotiated protocol version — always the agent profile's exact version. */
  version: Version
  /** `ucp.version` of the top-level `/.well-known/ucp` rendering. */
  businessVersion: string
  /** Which document supplied `profile`. */
  source: 'well-known' | 'supported_versions'
}

/**
 * Fetch the business profile rendering that matches the agent profile's exact
 * version, per the spec's "Protocol Version" rules:
 *
 *   1. Fetch `/.well-known/ucp` (envelope parse only). The business offers
 *      `{ucp.version} ∪ keys(supported_versions)`.
 *   2. If the agent's version IS the top-level version, that document is the
 *      profile (validated against the agent release's business schema).
 *   3. Else if the agent's version is a `supported_versions` key, fetch the
 *      linked document (https only). Its `ucp.version` MUST equal the key,
 *      else the platform MUST NOT use it (`PROFILE_VERSION_MISMATCH`,
 *      kind: 'supported_versions'). Version-specific documents are leaves: their own
 *      `supported_versions` (if any) is logged and not followed.
 *   4. Otherwise `PROTOCOL_VERSION_INCOMPATIBLE` — the business does not
 *      offer the version this profile speaks. Not by date order: a business
 *      one release AHEAD of us that publishes a leaf for our version
 *      negotiates fine via rule 3.
 *
 * Cache layout: the top-level document lives at `<cacheDir>/<origin>.json`;
 * a version-specific document lives at `<cacheDir>/<version>/<origin>.json`
 * (origin of the linked URL, which may differ from the business origin).
 */
export async function fetchCompatibleBusinessProfile(
  businessUrl: string,
  options: ResolveProfileOptions,
): Promise<ResolvedBusinessProfile> {
  const { agent, ...fetchOptions } = options
  const cacheDir = fetchOptions.cacheDir ?? defaultBusinessCacheDir()
  const baseUrl = parseHttpsUrl(businessUrl, 'business URL')
  const wellKnownUrl = new URL('/.well-known/ucp', baseUrl).toString()
  const v = agent.version
  const rel = agent.release

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
  const businessVersion = top.ucp.version
  const supported = top.ucp.supported_versions ?? {}
  const offered = [...new Set([businessVersion, ...Object.keys(supported)])].sort()

  if (v === businessVersion) {
    const result = rel.businessProfileSchema.safeParse(top)
    if (!result.success) {
      throw new UcpError({
        layer: 'transport',
        code: ErrorCodes.PROFILE_SCHEMA_INVALID,
        message: `response failed UCP ${v} schema validation at ${wellKnownUrl}: ${formatZodIssues(result.error.issues)}`,
      })
    }
    return {
      profile: result.data,
      profileUrl: wellKnownUrl,
      version: v,
      businessVersion,
      source: 'well-known',
    }
  }

  const versionedUrl = supported[v]
  if (versionedUrl === undefined) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROTOCOL_VERSION_INCOMPATIBLE,
      // Both sets are in the MESSAGE, not just `context`: choosing between
      // "upgrade the CLI" and "switch profile" needs `offered` AND
      // `supported`, and cli.ts never serializes `context` to the wire.
      message: `${baseUrl.origin} offers UCP ${offered.join(', ')}; ${agentLabel(agent)} uses ${v}. ucp-cli supports ${SUPPORTED_VERSIONS.join(', ')}`,
      context: {
        business: baseUrl.origin,
        businessVersion,
        /** Versions the BUSINESS offers. */
        offered,
        /** Versions THIS BUILD ships schemas for — the other half of the choice. */
        supported: [...SUPPORTED_VERSIONS],
        agentVersion: v,
        agentProfileUrl: agent.url,
        ...(agent.name !== undefined ? { profileName: agent.name } : {}),
      },
    })
  }

  if (!acceptsHttpsUrl(versionedUrl)) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROFILE_SCHEMA_INVALID,
      message: `business profile supported_versions["${v}"] is not an https URL: ${versionedUrl}`,
      context: { version: v, url: versionedUrl },
    })
  }

  // Envelope-first here too: the MUST-verify is a version check, so it has to
  // run BEFORE the release schema gets a vote. Parsing first would report a
  // mislabelled leaf as PROFILE_SCHEMA_INVALID (we'd be validating a 04-08
  // document against the 08-25 schema) and hide the actual defect.
  const leaf = await fetchCached(versionedUrl, {
    ...omitUndefined({
      force: fetchOptions.force,
      fetch: fetchOptions.fetch,
      signal: fetchOptions.signal,
      headers: fetchOptions.headers,
    }),
    cacheDir: join(cacheDir, v),
    schema: profileEnvelopeSchema,
    errorCodes: PROFILE_ERROR_CODES,
    errorLayer: 'transport',
  })
  if (leaf.ucp.version !== v) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROFILE_VERSION_MISMATCH,
      message: `business profile at ${versionedUrl} declares UCP ${leaf.ucp.version} but was linked as supported_versions["${v}"] — the spec forbids using it`,
      // `kind` names the mechanism in `protocol.source`'s vocabulary, so the
      // two merchant-defect cases read as coordinates in one system.
      context: {
        kind: 'supported_versions',
        expected: v,
        actual: leaf.ucp.version,
        url: versionedUrl,
      },
    })
  }
  const parsedLeaf = rel.businessProfileSchema.safeParse(leaf)
  if (!parsedLeaf.success) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROFILE_SCHEMA_INVALID,
      message: `response failed UCP ${v} schema validation at ${versionedUrl}: ${formatZodIssues(parsedLeaf.error.issues)}`,
    })
  }
  // Version-specific documents are leaves; a nested supported_versions map is
  // tolerated (catchall) but never followed.
  if ((leaf.ucp as Record<string, unknown>).supported_versions !== undefined) {
    vlog(
      `profile: ${versionedUrl} carries its own supported_versions; version-specific documents are leaves — ignoring it`,
    )
  }

  return {
    profile: parsedLeaf.data,
    profileUrl: versionedUrl,
    version: v,
    businessVersion,
    source: 'supported_versions',
  }
}
