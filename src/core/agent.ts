// Agent identity: which document ucp-cli negotiates AS, resolved with zero
// network.
//
// ONE contract, and it does not depend on who owns the URL. Every request
// carries `meta.ucp-agent.profile` — a URL, never a body — the business GETs
// it, and negotiates against whatever it serves. Locally,
// `~/.ucp/profiles/<name>/profile.json` is the claim about what that URL
// serves, and it is the document ucp-cli negotiates from. The two must agree;
// `ucp doctor` is what compares them, and is the only fetcher
// ({@link fetchAgentProfileLive}).
//
// Reading disk rather than the wire at request time is deliberate. The
// merchant may hold the document in cache, so a pre-flight GET would let a
// blip on the URL hard-block a request that would have succeeded. What the
// round trip would buy — a sharper `expectedCapabilities` — is ADVISORY (the
// authority is `ucp.capabilities` in the response), and a URL that has
// drifted from the local file is an authoring bug with a check of its own.
//
// `RELEASES[v].agentProfileTemplate` is the published document for release v,
// shipped verbatim. It is what `profile init` writes to disk, and the
// identity of last resort for a caller that supplies a URL and no profile
// name — never something that overrides a `profile.json` that exists.
//
// Version model: a platform profile declares exactly ONE `ucp.version` and
// the business validates that exact version (no ranges, no date-order
// compatibility inference). The profile therefore selects the release; the
// engine only constrains what it can physically execute (ENGINE_TRANSPORTS).
// Pattern throughout: the profile declares, the engine constrains, the
// intersection is effective.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'incur'
import { ErrorCodes, isUcpError, UcpError } from '../lib/errors.js'
import type { Transport } from '../lib/types.js'
import { formatZodIssues } from '../lib/zod-format.js'
import { refusedRedirect, ucpFetch } from './http-client.js'
import { type ProfileStoreOptions, profileDir } from './profile-store.js'
import {
  LATEST,
  type PlatformProfile,
  RELEASES,
  release,
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
 * The fetched, validated agent identity — the platform side of every
 * negotiation. This is an argument passed alongside the business profile,
 * NOT stored on the session (`ActiveProfile` stays a pointer).
 */
export interface AgentProfile {
  /** Local profile name, for messages/diagnostics. Absent when only a URL is known. */
  name?: string
  /** The identity URL sent on every request; the business reads what it serves. */
  url: string
  /** The exact spec release the profile declares (`ucp.version`). */
  version: Version
  /** Registry entry for `version`: schemas, reverse-domain grammar, defaults. */
  release: SpecRelease
  /** Fetched, parsed body. */
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

/** `dev.ucp.*` names the protocol's own services/capabilities — the ones the snapshot rule binds to `ucp.version`. */
export function isDevUcpKey(key: string): boolean {
  return key === 'dev.ucp' || key.startsWith('dev.ucp.')
}

/** The release whose published default profile lives at `url`, if any. */
function releaseByDefaultProfileUrl(url: string): SpecRelease | undefined {
  return Object.values(RELEASES).find((rel) => rel.defaultAgentProfileUrl === url)
}

/**
 * How an agent identity is named in agent-facing messages. One format for
 * every layer (Step 1 version selection, Step 2 negotiation) so operators see
 * the same string wherever the profile is implicated.
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
  /** Local profile name for messages. */
  name?: string
}

/**
 * Validate an agent-profile body into an {@link AgentProfile}. Pure — no I/O,
 * and deliberately indifferent to where the bytes came from: the bundled
 * snapshot, the local `profile.json`, and a doctor GET are the same JSON
 * shape, so one validator serves all three ({@link resolveAgentProfile} and
 * {@link fetchAgentProfileLive} compose acquisition on top; tests inject
 * fixture bodies here directly).
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
  // Fatal, unconditionally: this is the document ucp-cli sends as its
  // identity, it comes from a file the reader can edit, and an off-version
  // `dev.ucp.*` entry silently drops that capability at negotiation time. The
  // published templates ucp-cli ships all satisfy the rule (asserted in
  // agent.test.ts), so the no-profile-name fallback cannot trip it.
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
    ...(input.name !== undefined ? { name: input.name } : {}),
    url: input.url,
    version: rel.version,
    release: rel,
    body,
    services,
    capabilities: Object.keys(capabilityEntries).sort(),
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

export interface ResolveAgentProfileOptions {
  /**
   * The URL that goes on the wire in `meta.ucp-agent.profile`. Defaults to
   * the latest release's published default — the identity a local profile
   * with no `meta.profile_url` presents.
   */
  url?: string
  /**
   * Local profile name. Selects the `profile.json` that IS our declaration,
   * and names the profile in messages (`profile 'x'` instead of a raw URL).
   */
  name?: string
  /** Override the profile store home. `ucp doctor` and tests; the CLI uses `$UCP_HOME`. */
  homeDir?: string
}

/**
 * Resolve the identity every negotiation runs against. **No network, ever.**
 *
 * A named profile is answered by its own `profile.json`, at every URL. That
 * file is the one thing the reader controls, so an edit to it either takes
 * effect or gets reported by `ucp doctor` — it is never silently discarded.
 *
 * Without a name there is no local document to read — a `discover({profileUrl})`
 * call that passes neither `profileName` nor `agent`, which no CLI path does
 * (every command resolves a named profile first). The published template then
 * stands in: for the release that URL belongs to, or {@link LATEST} when the
 * URL is not one ucp-cli publishes a template for.
 */
export async function resolveAgentProfile(
  options: ResolveAgentProfileOptions = {},
): Promise<AgentProfile> {
  const { name } = options
  const url = parseHttpsUrl(
    options.url ?? RELEASES[LATEST].defaultAgentProfileUrl,
    'agent profile URL',
  ).toString()

  if (name !== undefined) {
    const store: ProfileStoreOptions =
      options.homeDir === undefined ? {} : { homeDir: options.homeDir }
    const path = join(profileDir(name, store), 'profile.json')
    return validated(await readLocalProfileBody(name, path), url, name, path)
  }

  const rel = releaseByDefaultProfileUrl(url)
  if (rel === undefined) {
    // Nothing local says what this URL serves. Warn rather than fail: the URL
    // on the wire is still right and the merchant negotiates against what it
    // serves; only our own prediction is generic.
    uwarn(
      `no local profile was named for ${url}, so ucp-cli declares the published UCP ${LATEST} document. Pass the profile name (or a resolved agent profile) to declare the document that URL serves.`,
    )
  }
  // structuredClone for the same reason `profile init` clones it: the template
  // is one shared object per release and must not become reachable from a
  // returned profile.
  const template = (rel ?? RELEASES[LATEST]).agentProfileTemplate
  return validated(structuredClone(template), url, undefined, 'published release template')
}

/**
 * The local `profile.json`, raw. Deliberately NOT `readUserProfile`:
 * {@link loadAgentProfile} must see the same bytes the URL serves (zod would
 * fill defaults first), and our own document belongs under
 * `AGENT_PROFILE_SCHEMA_INVALID`, not the generic `SCHEMA_VALIDATION_FAILED`
 * the store reports for authoring reads.
 */
async function readLocalProfileBody(name: string, path: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.PROFILE_NOT_FOUND,
      message: `profile "${name}" has no readable profile.json at ${path}; that file is the document ucp-cli declares on every request`,
      cause: err as Error,
      cta: {
        description:
          'Re-create the local document, then make sure the profile URL serves the same thing.',
        commands: [
          {
            command: `ucp profile init --name ${name} --force`,
            description: 'rewrite profile.json from the published release document',
          },
        ],
      },
    })
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.AGENT_PROFILE_SCHEMA_INVALID,
      message: `profile "${name}": ${path} is not valid JSON`,
      context: { path },
      cause: err as Error,
    })
  }
}

/** Shared tail of every path: validate the body, trace where it came from. */
function validated(
  body: unknown,
  url: string,
  name: string | undefined,
  source: string,
): AgentProfile {
  const agent = loadAgentProfile({ body, url, ...(name !== undefined ? { name } : {}) })
  vlog(
    `agent-profile: ${agent.name ?? url} uses UCP ${agent.version} (${source}); services [${Object.keys(agent.services).sort().join(', ')}]`,
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
 * only** — the request path resolves its identity locally
 * ({@link resolveAgentProfile}), so this is the one place that learns whether
 * the URL we advertise actually works. Everything doctor's `protocol` check
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
    agent: validated(body, url, options.name, 'live GET'),
    cacheControl: response.headers.get('cache-control'),
  }
}
