// Agent identity, resolved locally with zero network.
//
// `AgentProfile` is one exact, validated wire rendering: one URL, one body,
// and one release. `Profile` is the runtime selection input. A managed
// Profile carries one fresh bundled rendering for every installed release;
// a local DIY Profile and a URL-only ad-hoc Profile each carry one rendering.
// Body provenance (`source`) and URL selection (`urlOverride`) are independent:
// an explicit URL override replaces a DIY rendering's URL without replacing
// its locally authored body. Discovery reads the Business envelope first and
// selects the newest exact version present on both sides.
//
// Every MCP request carries the selected rendering's URL at
// `meta.ucp-agent.profile`. The Business reads that URL and negotiates against
// what it serves. For a named DIY Profile, the local `profile.json` is our
// claim about those bytes; `ucp doctor` is the only live fetcher and checks
// that the local and hosted documents agree.
//
// Version compatibility is exact equality only. No ranges or date-order
// inference are used. The Profile declares renderings, the engine constrains
// transports, and the Business offer selects the rendering.

import { z } from 'incur'
import { ErrorCodes, isUcpError, UcpError } from '../lib/errors.js'
import type { Transport } from '../lib/types.js'
import { formatZodIssues } from '../lib/zod-format.js'
import { refusedRedirect, ucpFetch } from './http-client.js'
import {
  LATEST,
  type PlatformProfile,
  RELEASES,
  release,
  releaseByDefaultAgentProfileUrl,
  type SpecRelease,
  SUPPORTED_VERSIONS,
  type Version,
} from './releases.js'
import { parseHttpsUrl } from './url.js'
import { uwarn, vlog } from './verbose.js'

/**
 * Transports ucp-cli can execute, independent of spec release. The agent
 * profile *declares* transports per service entry; negotiation intersects the
 * declaration with this set. v0.2 adds `'rest'` here (and nowhere else).
 */
export const ENGINE_TRANSPORTS: readonly Transport[] = ['mcp']

/**
 * One declared service entry from the agent profile. Structural mirror of
 * the generated types (which widen through zod intersections); the catchall
 * keeps unknown fields flowing through.
 */
export interface AgentServiceEntry {
  version: string
  transport?: string
  [k: string]: unknown
}

/**
 * Where a runtime rendering's body came from: `managed` is the bundled
 * multi-rendering set, `diy` is one locally authored body, and `url` is one
 * bundled body used for URL-only ad-hoc resolution. This does not say how its
 * URL was selected; {@link Profile.urlOverride} records that independent fact.
 */
export type ProfileSource = 'managed' | 'diy' | 'url'

/**
 * One validated agent identity rendering — the platform side of one exact
 * negotiation. Runtime {@link Profile}s store these by release.
 */
export interface AgentProfile {
  /** Body provenance, not URL provenance. */
  readonly source: ProfileSource
  /**
   * Whether `url` came from explicit `--profile-url` / `UCP_AGENT_PROFILE_URL`.
   * Supplied by the resolution path; never inferred from URL equality.
   */
  readonly urlOverride: boolean
  /** Local Profile name for messages/diagnostics; absent when no directory was selected. */
  name?: string
  /** The identity URL sent on every request; the business reads what it serves. */
  url: string
  /** The exact spec release the profile declares (`ucp.version`). */
  version: Version
  /** Registry entry for `version`: schemas, reverse-domain grammar, defaults. */
  release: SpecRelease
  /** Validated, parsed wire body. */
  body: PlatformProfile
  /**
   * Declared service entries keyed by capability id. Deliberately NOT
   * engine-filtered: error messages must show the full declaration
   * ("profile declares [rest]") — negotiation applies ENGINE_TRANSPORTS.
   */
  services: Readonly<Record<string, readonly AgentServiceEntry[]>>
  /** Declared capability ids (`keys(ucp.capabilities)`), sorted. */
  capabilities: readonly string[]
}

/**
 * Canonical runtime agent profile.
 *
 * The map is readonly, `Partial`, and keyed only by installed
 * {@link Version}s. Managed Profiles populate every key; DIY Profiles
 * intentionally populate exactly one. `Partial` is the honest type and the
 * type-checked form of the same rule: enumerate own keys, then index —
 * `Record` alone would name the closed key domain while quietly promising
 * every Profile source fills it.
 */
export interface Profile {
  /** Body provenance shared by this Profile's rendering set. */
  readonly source: ProfileSource
  /**
   * Whether rendering URL selection came from explicit
   * `--profile-url` / `UCP_AGENT_PROFILE_URL`, independent of `source`.
   */
  readonly urlOverride: boolean
  /** Local Profile name; absent when no profile directory was selected. */
  readonly name?: string
  readonly renderings: Readonly<Partial<Record<Version, AgentProfile>>>
}

/** `dev.ucp.*` names the protocol's own services/capabilities — the ones the snapshot rule binds to `ucp.version`. */
export function isDevUcpKey(key: string): boolean {
  return key === 'dev.ucp' || key.startsWith('dev.ucp.')
}

/**
 * How one selected AgentProfile rendering is named in Step 2 negotiation
 * messages. Step 1 labels the whole runtime Profile and includes its source.
 */
export function agentLabel(agent: Pick<AgentProfile, 'name' | 'url'>): string {
  return agent.name === undefined ? `agent profile ${agent.url}` : `profile '${agent.name}'`
}

// Envelope-first parse, same trick as the business path: read `ucp.version`
// off a minimal shape so release selection works even when the full profile
// schema would reject the body for that release.
const versionEnvelopeSchema = z
  .object({ ucp: z.object({ version: z.string() }).catchall(z.unknown()) })
  .catchall(z.unknown())

export interface LoadAgentProfileInput {
  /** Raw JSON body — bundled snapshot, local `profile.json`, or a doctor GET. */
  body: unknown
  /** URL this document is (or will be) served from: identity + messages. */
  url: string
  /** Body provenance supplied by the acquisition path, never inferred from the document. */
  source: ProfileSource
  /** Explicit URL-override provenance, never inferred from URL equality. */
  urlOverride: boolean
  /** Local profile name for messages. */
  name?: string
}

/**
 * Validate an agent-profile body into an {@link AgentProfile}. Pure — no I/O.
 * Bundled snapshots, local `profile.json`, and Doctor GETs share one JSON
 * validator, while the acquisition path must supply `source` and
 * `urlOverride` explicitly so downstream remedies never reverse-engineer
 * either fact from those bytes or their URL. The runtime factories and
 * {@link fetchAgentProfileLive} all pass acquired bodies through this same
 * validator; tests inject fixture bodies here directly.
 *
 * Failure modes (all `layer: 'client'` — our own document, the agent acts).
 * Every code here is `AGENT_PROFILE_*`: the business's document has its own
 * `PROFILE_*` codes and no code may mean both.
 *   - `AGENT_PROFILE_SCHEMA_INVALID`      envelope or release-schema parse failure
 *   - `AGENT_PROFILE_VERSION_UNSUPPORTED` a release ucp-cli does not support
 *   - `AGENT_PROFILE_VERSION_MISMATCH`    a `dev.ucp.*` entry at a version ≠
 *     the profile's own `ucp.version` (snapshot rule).
 *
 * Declared transports outside {@link ENGINE_TRANSPORTS} warn and are left in
 * place — negotiation ignores them (declare/constrain/intersect), and the
 * messages stay honest about what the profile actually says.
 */
export function loadAgentProfile(input: LoadAgentProfileInput): AgentProfile {
  const label =
    input.name === undefined
      ? `agent profile at ${input.url}`
      : `profile "${input.name}" (${input.url})`

  const envelope = versionEnvelopeSchema.safeParse(input.body)
  if (!envelope.success) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.AGENT_PROFILE_SCHEMA_INVALID,
      message: `${label} is not a UCP profile document (missing ucp.version): ${formatZodIssues(envelope.error.issues)}`,
      context: { url: input.url },
    })
  }

  const version = envelope.data.ucp.version
  const rel = release(version)
  if (rel === undefined) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.AGENT_PROFILE_VERSION_UNSUPPORTED,
      message: `${input.url} declares UCP ${version}; ucp-cli supports ${SUPPORTED_VERSIONS.join(', ')}`,
      context: { url: input.url, version, supported: [...SUPPORTED_VERSIONS] },
      cta: {
        description: 'Switch to (or init) a profile at a supported version, or upgrade ucp-cli.',
        commands: [{ command: 'ucp profile list', description: 'see local profiles' }],
      },
    })
  }

  const parsed = rel.platformProfileSchema.safeParse(input.body)
  if (!parsed.success) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.AGENT_PROFILE_SCHEMA_INVALID,
      message: `${label} failed UCP ${version} schema validation: ${formatZodIssues(parsed.error.issues)}`,
      context: { url: input.url, version },
    })
  }
  const body = parsed.data

  const services = normalizeEntries(body.ucp.services)
  const capabilityEntries = normalizeEntries(body.ucp.capabilities)

  // Snapshot rule, applied to ourselves exactly as to a business rendering:
  // every dev.ucp.* entry in a profile repeats that profile's ucp.version.
  // Third-party entries (com.acme.*) carry their own version lines and are
  // exempt — that independence is the point of the reverse-DNS registry.
  //
  // Fatal, unconditionally: this is the document ucp-cli models as its
  // identity, and an off-version `dev.ucp.*` entry silently drops that
  // capability at negotiation time. The published templates ucp-cli ships all
  // satisfy the rule (asserted in agent.test.ts), so managed and scalar-URL
  // factories cannot trip it; DIY authors can repair their own document.
  for (const [registry, entries] of [
    ['services', services],
    ['capabilities', capabilityEntries],
  ] as const) {
    for (const [key, list] of Object.entries(entries)) {
      if (!isDevUcpKey(key)) continue
      const off = list.filter((e) => e.version !== version)
      if (off.length === 0) continue
      const detail = `${label} uses UCP ${version} but declares ${key} at [${off.map((e) => e.version).join(', ')}] — dev.ucp.* entries must match the profile's own version`
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.AGENT_PROFILE_VERSION_MISMATCH,
        message: detail,
        context: {
          url: input.url,
          registry,
          key,
          versions: off.map((e) => e.version),
        },
        cta: {
          description:
            "Align every dev.ucp.* entry with the profile's `ucp.version`. This document is what ucp-cli declares, and the business reads the copy at the profile URL — so the corrected version has to end up in both places.",
          commands: [
            { command: 'ucp profile show', description: 'print the active profile document' },
            { command: 'ucp doctor', description: 'compare the local document against the URL' },
          ],
        },
      })
    }
  }

  // Engine-transport check: warn (unconditionally — a declared capability the
  // engine will ignore must not be a silent no-op) but keep the entries.
  for (const [key, list] of Object.entries(services)) {
    const foreign = [
      ...new Set(
        list
          .map((e) => e.transport)
          .filter(
            (t): t is string =>
              typeof t === 'string' && !(ENGINE_TRANSPORTS as readonly string[]).includes(t),
          ),
      ),
    ]
    if (foreign.length > 0) {
      uwarn(
        `${label} declares ${key} over [${foreign.join(', ')}]; ucp-cli supports [${ENGINE_TRANSPORTS.join(', ')}] — those entries are ignored`,
      )
    }
  }

  return {
    source: input.source,
    urlOverride: input.urlOverride,
    ...(input.name !== undefined ? { name: input.name } : {}),
    url: input.url,
    version: rel.version,
    release: rel,
    body,
    services,
    capabilities: Object.keys(capabilityEntries).sort(),
  }
}

/**
 * Build the managed Profile from every release installed in this binary.
 *
 * `name` is the local profile directory this Profile was resolved from, if
 * any — an upgraded legacy profile is still `profiles/<name>/`, and that name
 * is what selects `headers.json` and what messages call this identity. It
 * changes no rendering: managed renderings are always the bundled templates
 * at their own published URLs.
 */
export function createManagedProfile(name?: string): Profile {
  const entries = Object.values(RELEASES).map((rel) => {
    // Parse the generated JSON for every factory call: no returned body can
    // mutate the release template or another managed Profile instance.
    const agent = loadAgentProfile({
      body: JSON.parse(rel.agentProfileJson) as unknown,
      url: parseHttpsUrl(rel.defaultAgentProfileUrl, 'agent profile URL').toString(),
      source: 'managed',
      urlOverride: false,
      ...(name !== undefined ? { name } : {}),
    })
    return [agent.version, agent] as const
  })
  return {
    source: 'managed',
    urlOverride: false,
    ...(name !== undefined ? { name } : {}),
    renderings: Object.freeze(Object.fromEntries(entries)),
  }
}

export interface CreateDiyProfileInput {
  /** The one locally authored wire body. */
  body: unknown
  /** Hosted identity URL. Defaults to the body release's published URL. */
  url?: string
  /** True only when the URL came from `--profile-url` / `UCP_AGENT_PROFILE_URL`. */
  urlOverride?: boolean
  /** Local profile name. */
  name: string
}

/** Build a named singleton DIY Profile from one exact body and URL. */
export function createDiyProfile(input: CreateDiyProfileInput): Profile {
  const envelope = versionEnvelopeSchema.safeParse(input.body)
  const bodyRelease = envelope.success ? release(envelope.data.ucp.version) : undefined
  const url = parseHttpsUrl(
    input.url ?? bodyRelease?.defaultAgentProfileUrl ?? RELEASES[LATEST].defaultAgentProfileUrl,
    'agent profile URL',
  ).toString()
  const agent = loadAgentProfile({
    body: input.body,
    url,
    source: 'diy',
    urlOverride: input.urlOverride ?? false,
    name: input.name,
  })
  return singletonProfile(agent, input.name)
}

/**
 * Build the URL-pinned ad-hoc Profile used when an explicit profile URL is
 * the identity. Known published URLs select their own release; any other URL
 * gets one latest-release rendering. The URL remains exactly the caller's.
 *
 * `name` is optional and purely local: it names the profile directory whose
 * `headers.json` applies and how messages address this identity. A scalar URL
 * still pins one rendering — a name never spreads it across releases.
 */
export function createAdHocProfile(url: string, name?: string): Profile {
  const normalizedUrl = parseHttpsUrl(url, 'agent profile URL').toString()
  const publishedRelease = releaseByDefaultAgentProfileUrl(normalizedUrl)
  const rel = publishedRelease ?? RELEASES[LATEST]
  if (publishedRelease === undefined) {
    uwarn(
      `${normalizedUrl} is not a known release-default Profile URL; ucp-cli is using the bundled UCP ${LATEST} body for planning and negotiation at that URL. Run \`ucp doctor\` to check what the URL actually serves.`,
    )
  }
  const agent = loadAgentProfile({
    body: JSON.parse(rel.agentProfileJson) as unknown,
    url: normalizedUrl,
    source: 'url',
    urlOverride: true,
    ...(name !== undefined ? { name } : {}),
  })
  return singletonProfile(agent, name)
}

function singletonProfile(agent: AgentProfile, name?: string): Profile {
  return {
    source: agent.source,
    urlOverride: agent.urlOverride,
    ...(name !== undefined ? { name } : {}),
    // A singleton Profile is pinned: never synthesize adjacent release
    // renderings from one scalar URL or body.
    renderings: Object.freeze({ [agent.version]: agent }),
  }
}

function normalizeEntries(registry: unknown): Record<string, AgentServiceEntry[]> {
  if (typeof registry !== 'object' || registry === null) return {}
  const out: Record<string, AgentServiceEntry[]> = {}
  for (const [key, value] of Object.entries(registry as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    out[key] = value.filter(
      (e): e is AgentServiceEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { version?: unknown }).version === 'string',
    )
  }
  return out
}

/** Validate and trace a live acquisition through the shared profile-body loader. */
function validated(
  body: unknown,
  url: string,
  name: string | undefined,
  acquisition: string,
  source: ProfileSource,
  urlOverride: boolean,
): AgentProfile {
  const agent = loadAgentProfile({
    body,
    url,
    source,
    urlOverride,
    ...(name !== undefined ? { name } : {}),
  })
  vlog(
    `agent-profile: ${agent.name ?? url} uses UCP ${agent.version} (${acquisition}); services [${Object.keys(agent.services).sort().join(', ')}]`,
  )
  return agent
}

// ─── doctor's live probe ─────────────────────────────────────────────────

export interface FetchAgentProfileOptions {
  /** URL of the hosted agent profile (the identity URL sent on the wire). */
  url: string
  /** Local profile name for messages. */
  name?: string
  /** Injectable fetch (tests). */
  fetch?: typeof fetch
  /** AbortSignal composed with the 30 s timeout. */
  signal?: AbortSignal
  /** Body provenance to retain on the observed rendering. Defaults to URL-only. */
  source?: ProfileSource
  /** Explicit URL-override provenance to retain. Defaults false. */
  urlOverride?: boolean
}

/** A live read of the hosted document, plus the hosting facts doctor judges. */
export interface LiveAgentProfile {
  /** The document as served, validated exactly like a local one. */
  agent: AgentProfile
  /** Raw `Cache-Control` response header, `null` when absent. */
  cacheControl: string | null
}

const FETCH_TIMEOUT_MS = 30_000

/**
 * Why the hosted agent profile could not be used as our identity. Carried as
 * `AGENT_PROFILE_UNREACHABLE`'s `context.reason` and named in the message,
 * because the sub-cases have different remedies and a caller must be able to
 * branch on them without regexing prose. `'not_json'` is the important one: a
 * 200 serving an HTML error page is the most common hosting failure and is
 * not really "unreachable".
 *
 * `'business_reported'` is the only one that still arises on the request
 * path, and it is not ours to predict: it is the merchant telling us, over
 * JSON-RPC, that IT could not fetch our URL (see core/mcp-client.ts).
 */
export type AgentProfileUnreachableReason =
  | 'network'
  | 'http_status'
  | 'not_json'
  | 'redirect'
  | 'business_reported'

/**
 * The hop behind an `AGENT_PROFILE_UNREACHABLE` carrying
 * `reason: 'redirect'`, or `undefined` for any other error. Lives beside the
 * throw site that encodes it so `ucp doctor` can state the status and the
 * target in its own words instead of re-deriving them from the message.
 *
 * The hop itself is not copied into this error: it is already on the wrapped
 * refusal, so {@link refusedRedirect} decodes it from the `cause` rather than
 * a second, unvalidated copy that could disagree with the first.
 */
export function agentProfileRedirect(err: unknown) {
  if (!isUcpError(err) || err.code !== ErrorCodes.AGENT_PROFILE_UNREACHABLE) return undefined
  const context = err.context as { reason?: unknown } | undefined
  if (context?.reason !== 'redirect') return undefined
  return refusedRedirect(err.cause)
}

/**
 * GET the hosted agent profile and validate what it serves. **`ucp doctor`
 * only** — the request path materializes its identity locally through
 * {@link createManagedProfile}, {@link createDiyProfile}, or
 * {@link createAdHocProfile}, so this is the one place that learns whether the
 * URL we advertise actually works. Everything doctor's `protocol` check
 * needs comes from here: reachability, HTTP status, JSON-ness, schema
 * validity, the declared version, and the `Cache-Control` the merchant's
 * fetch of the same URL will see.
 *
 * Unreachable / non-2xx / non-JSON / redirect → `AGENT_PROFILE_UNREACHABLE`
 * with a `reason`; {@link agentProfileRedirect} decodes the redirect. There
 * is no cache and no memo to bypass: every call reads the wire, which is the
 * point of a drift detector.
 *
 * Business-scoped auth headers are deliberately NOT accepted here — this GET
 * goes to the agent's own host, and forwarding per-business credentials to it
 * would leak them.
 */
export async function fetchAgentProfileLive(
  options: FetchAgentProfileOptions,
): Promise<LiveAgentProfile> {
  const url = parseHttpsUrl(options.url, 'agent profile URL').toString()
  const who = options.name === undefined ? `agent profile` : `profile '${options.name}'`
  // `reason` is repeated in the message, not just `context`: cli.ts's error
  // middleware serializes only {code, message, retryable|cta}, so anything an
  // agent must branch on has to survive in one of those three fields.
  const unreachable = (
    reason: AgentProfileUnreachableReason,
    detail: string,
    extra?: { http_status?: number; cause?: Error },
  ): UcpError =>
    new UcpError({
      layer: 'client',
      code: ErrorCodes.AGENT_PROFILE_UNREACHABLE,
      message: `${who} is hosted at ${url} but could not be read (${reason}: ${detail}); the business fetches this same URL to negotiate with you.`,
      context: { url, reason, ...(options.name !== undefined ? { profile: options.name } : {}) },
      cta: {
        description:
          'The URL you advertise must be reachable — it is the only thing the business has to go on. Fix hosting, or point the profile at a reachable URL.',
        commands: [
          {
            command: 'ucp profile show',
            description: 'print the local document this URL should serve',
          },
        ],
      },
      ...(extra?.http_status !== undefined ? { http_status: extra.http_status } : {}),
      ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
    })

  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, options.signal])

  let response: Response
  try {
    response = await ucpFetch(url, {
      framing: { Accept: 'application/json' },
      signal,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      traceLabel: 'agent-profile',
    })
  } catch (err) {
    // A refused redirect is our own hosting misconfiguration, not a network
    // fault, and it keeps the `client` layer every AGENT_PROFILE_* code
    // carries — the seam src/lib/error-layers.test.ts exists to hold. The
    // refusal's own message is the detail: it already names the Location and
    // the fixes.
    const redirect = refusedRedirect(err)
    if (redirect !== undefined) {
      throw unreachable('redirect', (err as Error).message, {
        cause: err as Error,
        http_status: redirect.status,
      })
    }
    throw unreachable('network', (err as Error).message, { cause: err as Error })
  }
  if (!response.ok)
    throw unreachable('http_status', `HTTP ${response.status}`, { http_status: response.status })

  let body: unknown
  try {
    body = await response.json()
  } catch (err) {
    throw unreachable('not_json', 'response body is not JSON', { cause: err as Error })
  }

  return {
    agent: validated(
      body,
      url,
      options.name,
      'live GET',
      options.source ?? 'url',
      options.urlOverride ?? false,
    ),
    cacheControl: response.headers.get('cache-control'),
  }
}
