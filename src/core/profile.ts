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
// Version model (spec "Protocol Version"): exact-version equality. A runtime
// Profile contributes one or more exact AgentProfile renderings; a Business
// contributes its root version plus `supported_versions` keys. Negotiation
// selects the newest installed version in that intersection. Compatibility is
// never inferred from date order, and selection is never retried at an older
// version after the chosen rendering fails.

import { join } from 'node:path'

import { z } from 'incur'

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { omitUndefined } from '../lib/omit-undefined.js'
import { formatZodIssues } from '../lib/zod-format.js'
import type { AgentProfile, Profile } from './agent.js'
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
// which selects the newest exact release shared by the runtime Profile and
// Business offer. A standalone "parse a business document at whatever version
// it claims" helper had no callers, and the error code that existed only for
// it (`PROFILE_VERSION_UNSUPPORTED`) invited the idea that a Business's root
// version alone selects our schema — it does not.

/**
 * Default catalog business URL — the origin whose `/.well-known/ucp` discovery
 * surfaces the global catalog tools. Used as the runtime fallback for catalog
 * ops when a local profile omits `meta.defaults.catalog` and `UCP_DEFAULT_CATALOG`
 * is unset.
 */
export const DEFAULT_CATALOG_URL: string = __DEFAULT_CATALOG_URL__

// `profile init` writes `release(v).agentProfileJson` — the VERBATIM published
// document served by `release(v).defaultAgentProfileUrl`. Never substitute a
// hand-written template: the local file and the URL must start in agreement so
// `ucp doctor` reports only real drift.

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
 * from `supported_versions`. Callers pick `cacheDir`; `fetchCached` names each
 * file with a hash of the canonical full URL. `schema` selects the release to
 * validate against; defaults to the latest release's business schema.
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
  /** Runtime Profile whose exact renderings are eligible for selection. */
  profile: Profile
}

export interface ResolvedBusinessProfile {
  profile: BusinessProfile
  /** The exact AgentProfile rendering selected for this Business. */
  agentProfile: AgentProfile
  /** URL of the document `profile` was parsed from. */
  profileUrl: string
  /** Negotiated protocol version shared by both selected renderings. */
  version: Version
  /** `ucp.version` of the top-level `/.well-known/ucp` rendering. */
  businessVersion: string
  /** Which document supplied `profile`. */
  source: 'well-known' | 'supported_versions'
}

function profileLabel(profile: Profile): string {
  if (profile.source === 'managed') {
    return profile.name === undefined ? 'managed Profile' : `managed Profile '${profile.name}'`
  }
  if (profile.source === 'url') {
    const rendering = Object.values(profile.renderings)[0]
    return rendering === undefined
      ? 'profile URL override'
      : `profile URL override ${rendering.url}`
  }
  if (profile.name !== undefined) return `profile '${profile.name}'`
  const rendering = Object.values(profile.renderings)[0]
  return rendering === undefined ? 'DIY Profile' : `agent profile ${rendering.url}`
}

function incompatibleProfileRemedy(profile: Profile): string {
  // Body provenance determines whether the declaration is editable. Check it
  // before independent URL-override provenance, matching service remedies.
  if (profile.source === 'managed') {
    return "The managed Profile already offers every rendering installed in this ucp-cli build, so no local Profile using this build's installed versions can recover; install a ucp-cli build that supports a Business-offered release."
  }
  if (profile.source === 'url') {
    return 'A URL-only ad-hoc Profile is pinned to this one bundled rendering. The explicit --profile-url/UCP_AGENT_PROFILE_URL override outranks stored meta/profile-name switching. Remove --profile-url/UCP_AGENT_PROFILE_URL or make that URL serve the intended exact authored/bundled rendering; to edit the declaration itself, create a DIY Profile and a Profile URL you control.'
  }
  if (profile.urlOverride) {
    return 'This is still an editable local DIY body. Update profile.json, then upload that authored document to the active --profile-url/UCP_AGENT_PROFILE_URL override. It outranks stored meta/profile-name switching. Remove --profile-url/UCP_AGENT_PROFILE_URL or make that URL serve the intended exact authored/bundled rendering.'
  }
  return 'A DIY Profile is pinned to this one rendering.'
}

/**
 * Fetch the newest exact Business/Agent rendering pair, per the spec's
 * "Protocol Version" rules:
 *
 *   1. Fetch `/.well-known/ucp` and parse only its envelope. The Business
 *      offers `{ucp.version} ∪ keys(supported_versions)`.
 *   2. Intersect that set with the runtime Profile's rendering keys and pick
 *      the newest installed release.
 *   3. If selected version is the root, validate that document. Otherwise
 *      fetch the selected `supported_versions` leaf (https only), verify that
 *      its `ucp.version` equals its key, then validate it. Leaves are not
 *      traversed.
 *   4. If the intersection is empty, fail `PROTOCOL_VERSION_INCOMPATIBLE`.
 *
 * Once step 2 selects a version there is no fallback: a bad leaf, service,
 * endpoint, or tools response fails the call rather than silently retrying an
 * older protocol rendering.
 *
 * Cache layout: the top-level document lives at `<cacheDir>/<url-sha256>.json`;
 * a version-specific document lives at
 * `<cacheDir>/<version>/<url-sha256>.json`.
 */
export async function fetchCompatibleBusinessProfile(
  businessUrl: string,
  options: ResolveProfileOptions,
): Promise<ResolvedBusinessProfile> {
  const { profile: runtimeProfile, ...fetchOptions } = options
  const cacheDir = fetchOptions.cacheDir ?? defaultBusinessCacheDir()
  const baseUrl = parseHttpsUrl(businessUrl, 'business URL')
  const wellKnownUrl = new URL('/.well-known/ucp', baseUrl).toString()

  // Envelope first. Profile kind does not get a vote until the Business's
  // complete offered-version set is known.
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
  const offeredSet = new Set(offered)
  const profileVersions = SUPPORTED_VERSIONS.filter((version) =>
    Object.hasOwn(runtimeProfile.renderings, version),
  )
  const v = profileVersions.filter((version) => offeredSet.has(version)).at(-1)

  if (v === undefined) {
    const soleVersion = profileVersions.length === 1 ? profileVersions[0] : undefined
    const soleAgent = soleVersion === undefined ? undefined : runtimeProfile.renderings[soleVersion]
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROTOCOL_VERSION_INCOMPATIBLE,
      message: `${baseUrl.origin} offers UCP ${offered.join(', ')}; ${profileLabel(runtimeProfile)} offers ${profileVersions.join(', ') || 'no installed renderings'}. ucp-cli supports ${SUPPORTED_VERSIONS.join(', ')}. ${incompatibleProfileRemedy(runtimeProfile)}`,
      context: {
        business: baseUrl.origin,
        businessVersion,
        offered,
        supported: [...SUPPORTED_VERSIONS],
        profileVersions,
        profileSource: runtimeProfile.source,
        profileUrlOverride: runtimeProfile.urlOverride,
        ...(soleAgent !== undefined
          ? { agentVersion: soleAgent.version, agentProfileUrl: soleAgent.url }
          : {}),
        ...(runtimeProfile.name !== undefined ? { profileName: runtimeProfile.name } : {}),
      },
    })
  }

  // `v` survived the own-key filter above, so this lookup is total by
  // construction; the guard is an internal-invariant check in the same key
  // as the supported_versions one below, not a compatibility fallback.
  const agent = runtimeProfile.renderings[v]
  if (agent === undefined) {
    throw new Error(`selected UCP ${v} but the runtime profile has no rendering for it`)
  }
  const rel = agent.release

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
      agentProfile: agent,
      profileUrl: wellKnownUrl,
      version: v,
      businessVersion,
      source: 'well-known',
    }
  }

  // `v` came from a supported_versions key because it is not the root.
  // Keep the guard as an internal-invariant check, not a compatibility
  // fallback: once selected, another rendering must never be attempted.
  const versionedUrl = supported[v]
  if (versionedUrl === undefined) {
    throw new Error(`selected UCP ${v} but Business supplied no supported_versions URL`)
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
    agentProfile: agent,
    profileUrl: versionedUrl,
    version: v,
    businessVersion,
    source: 'supported_versions',
  }
}
