// Compose business profile fetch + service negotiation + MCP tools/list into
// a dispatch-ready view.
//
// This is the point where the independent profile, negotiation, MCP transport,
// and cache primitives meet. The returned shape keeps the original business
// profile intact and adds a derived `negotiated` map keyed by capability, then
// tool name, so dispatch can look up a tool without re-walking profile data.
//
// Discovery is fail-fast: any requested capability that cannot be negotiated or
// hydrated fails the whole call. Callers that want partial success should pass
// a narrower capability list and call discovery once per group.
//
// Cache layout:
//   <ucpHome>/cache/businesses/<origin>.json
//   <ucpHome>/cache/toolslist/<origin>/<capability-or-hash>.json

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { z } from 'incur'

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { omitUndefined } from '../lib/omit-undefined.js'
import type { Transport } from '../lib/types.js'
import { cacheCompute, originToFilename, ucpHomeDir } from './cache.js'
import { mcpRpc } from './mcp-client.js'
import {
  AGENT_PROTOCOL_RANGE,
  type AgentRange,
  type BusinessProfile,
  fetchBusinessProfile,
} from './profile.js'
import { parseHttpsUrl } from './url.js'
import { vlog } from './verbose.js'

/**
 * One tool as advertised by a business `tools/list` response. We pin
 * `name` and `inputSchema` (the only fields dispatch needs); other MCP
 * fields (`description`, `annotations`, etc.) flow through unchanged for
 * verbose-mode output.
 */
export interface ToolDescriptor {
  name: string
  description?: string
  inputSchema: unknown
  [k: string]: unknown
}

export interface NegotiatedCapability {
  capability: string
  version: string
  transport: Transport
  endpoint: string
  /** Keyed by tool name for O(1) dispatch lookup. */
  tools: Record<string, ToolDescriptor>
}

/**
 * The composed view returned by `discover()`. Lossless principle:
 * `profile` preserves every field the business published (including
 * alternate-version services entries we didn't pick); `negotiated` is
 * the derived dispatch view.
 */
export interface DiscoveredBusiness {
  business: string
  profile: BusinessProfile
  negotiated: Record<string, NegotiatedCapability>
}

export interface DiscoverOptions {
  /** Defaults to `AGENT_PROTOCOL_RANGE` (build-time). */
  agentRange?: AgentRange
  /**
   * Capabilities to resolve. When omitted, every capability the
   * business advertises in `services` is negotiated. Pass an explicit
   * list (e.g. `['dev.ucp.shopping']`) to limit work and lock the failure
   * surface.
   */
  capabilities?: string[]
  /** Defaults to `['mcp']`. v0.2 will pass `['mcp', 'rest']`. */
  acceptableTransports?: readonly Transport[]
  /** Override the cache root. Defaults to `<ucpHome>/cache`. */
  cacheDir?: string
  /** Skip cache reads for both profile and tools/list. */
  force?: boolean
  /** AbortSignal forwarded to fetch + JSON-RPC. */
  signal?: AbortSignal
  /** Platform profile URL advertised to the business during MCP discovery. */
  profileUrl?: string
  /**
   * Outbound headers (auth, tenancy, etc) attached to every HTTP call made
   * during discovery: the `/.well-known/ucp` GET and any `tools/list` POSTs.
   * Some merchants require auth even on discovery, so the same resolved bag
   * that flows to `tools/call` flows here too.
   */
  headers?: Record<string, string>
  /** Injectable for tests (forwarded to `fetchBusinessProfile` and `mcpRpc`). */
  fetch?: typeof fetch
}

const TOOLS_LIST_TTL_SECONDS = 60 // UCP minimum; see header note.

const toolsListResultSchema = z.object({
  tools: z
    .object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.unknown(),
    })
    .catchall(z.unknown())
    .array(),
})

export async function discover(
  businessUrl: string,
  options: DiscoverOptions = {},
): Promise<DiscoveredBusiness> {
  const normalizedBusiness = parseHttpsUrl(businessUrl, 'business URL')
  const cacheRoot = options.cacheDir ?? join(ucpHomeDir(), 'cache')
  const profileCacheDir = join(cacheRoot, 'businesses')
  const toolsListCacheRoot = join(cacheRoot, 'toolslist', originToFilename(normalizedBusiness))

  const profile = await fetchBusinessProfile(normalizedBusiness.origin, {
    cacheDir: profileCacheDir,
    ...omitUndefined({
      fetch: options.fetch,
      signal: options.signal,
      force: options.force,
      headers: options.headers,
    }),
  })

  const services = profile.ucp.services as Record<string, unknown> | undefined
  const requested =
    options.capabilities ?? (services !== undefined ? Object.keys(services).sort() : [])

  const negotiated: Record<string, NegotiatedCapability> = {}
  for (const capability of requested) {
    const negotiation = negotiateService({
      profile,
      capability,
      agentRange: options.agentRange ?? AGENT_PROTOCOL_RANGE,
      ...omitUndefined({ acceptableTransports: options.acceptableTransports }),
    })
    const endpoint = negotiation.entry.endpoint
    if (typeof endpoint !== 'string') {
      // The codegenned business_profile schema types `endpoint` as
      // `optional()` because `json-schema-to-zod` flattens the canonical
      // per-transport anyOf branches (negotiate.ts header explains the
      // footgun). So a business can publish an mcp entry with no endpoint
      // and still parse — this branch is the runtime backstop, not
      // paranoia. Surface as a structured transport-layer error so the
      // dispatcher's catch path classifies it correctly per PROTOCOL §4.2.
      throw new UcpError({
        layer: 'transport',
        code: ErrorCodes.SERVICE_ENDPOINT_MISSING,
        message: `business advertises capability "${capability}" with transport "${negotiation.transport}" but no endpoint`,
        context: { capability, transport: negotiation.transport, entry: negotiation.entry },
      })
    }

    negotiated[capability] = await hydrateCapability({
      capability,
      negotiation: { ...negotiation, endpoint },
      cacheDir: toolsListCacheRoot,
      cacheKey: capabilityToCacheKey(capability),
      ...omitUndefined({
        profileUrl: options.profileUrl,
        force: options.force,
        fetch: options.fetch,
        signal: options.signal,
        headers: options.headers,
      }),
    })
    const tools = Object.keys(negotiated[capability].tools).sort()
    vlog(
      `discover: negotiated ${capability}@${negotiation.version} (${negotiation.transport}) → ${endpoint} [${tools.length} tools: ${tools.join(', ')}]`,
    )
  }

  return { business: normalizedBusiness.origin, profile, negotiated }
}

interface HydrateOptions {
  capability: string
  cacheKey: string
  negotiation: { version: string; transport: Transport; endpoint: string }
  cacheDir: string
  force?: boolean
  fetch?: typeof fetch
  signal?: AbortSignal
  profileUrl?: string
  headers?: Record<string, string>
}

async function hydrateCapability(opts: HydrateOptions): Promise<NegotiatedCapability> {
  const result = await cacheCompute({
    cacheDir: opts.cacheDir,
    cacheKey: opts.cacheKey,
    ttlSeconds: TOOLS_LIST_TTL_SECONDS,
    schema: toolsListResultSchema,
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    compute: () =>
      mcpRpc<z.infer<typeof toolsListResultSchema>>({
        endpoint: opts.negotiation.endpoint,
        method: 'tools/list',
        ...omitUndefined({
          params: opts.profileUrl !== undefined ? profileParams(opts.profileUrl) : undefined,
          fetch: opts.fetch,
          signal: opts.signal,
          headers: opts.headers,
        }),
      }),
  })

  const tools: Record<string, ToolDescriptor> = {}
  for (const tool of result.tools) {
    tools[tool.name] = tool as ToolDescriptor
  }

  return {
    capability: opts.capability,
    version: opts.negotiation.version,
    transport: opts.negotiation.transport,
    endpoint: opts.negotiation.endpoint,
    tools,
  }
}

function capabilityToCacheKey(capability: string): string {
  if (/^[a-z0-9._-]+$/.test(capability)) return capability
  return createHash('sha256').update(capability).digest('hex')
}

function profileParams(profileUrl: string): {
  arguments: { meta: { 'ucp-agent': { profile: string } } }
} {
  return {
    arguments: {
      meta: {
        'ucp-agent': { profile: profileUrl },
      },
    },
  }
}

// ─── Pure version × transport intersection ───────────────────────────────
//
// Given a parsed business profile, a target capability, and the agent's
// `[protocolMin, protocolMax]` range, pick the highest mutually-supported
// (version, transport) tuple. No I/O, no caching, no logging.
//
// What this is NOT:
//
//   • Profile-level `supported_versions` handling. That's pre-flight: if
//     the business profile is rendered at a version we can't parse,
//     `supported_versions[<our pick>]` lets us re-fetch a different
//     rendering. That's handled before we get here.
//
//   • Endpoint validation. `services[cap][n]` already passed
//     `businessProfileSchema`, which rejects mcp/rest entries without
//     `endpoint` via the per-transport anyOf branches. The TypeScript
//     output type still types `endpoint?: string` because the branches
//     widen back at the type level — callers who need the URL extract it
//     at the use site (see the SERVICE_ENDPOINT_MISSING backstop above).
//
// Tie-break: when multiple entries share the highest negotiable version,
// transports are ranked by their order in `acceptableTransports`. v0.1
// only ships MCP, so the default is `['mcp']` — single-transport policy
// is enforced by omission, not by branching.

// Minimal structural shape we read at this layer. The codegenned
// inferred type widens through intersection() into something TS can't
// narrow at access points; mirror just the fields we touch and let the
// catchall keep extras flowing through.
export interface ServiceEntry {
  version: string
  transport?: string
  endpoint?: string
  [k: string]: unknown
}

export interface NegotiatedService {
  capability: string
  version: string
  transport: Transport
  entry: ServiceEntry
}

export interface NegotiateOptions {
  profile: BusinessProfile
  capability: string
  agentRange: AgentRange
  /** Default `['mcp']`; v0.2 will pass `['mcp', 'rest']`. */
  acceptableTransports?: readonly Transport[]
}

/** Default transport policy. Callers can override when another transport is acceptable. */
export const DEFAULT_ACCEPTABLE_TRANSPORTS: readonly Transport[] = ['mcp']

export function negotiateService(options: NegotiateOptions): NegotiatedService {
  const {
    profile,
    capability,
    agentRange,
    acceptableTransports = DEFAULT_ACCEPTABLE_TRANSPORTS,
  } = options
  const services = profile.ucp.services as Record<string, ServiceEntry[]> | undefined
  const entries = services?.[capability]
  if (entries === undefined || entries.length === 0) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.CAPABILITY_NOT_OFFERED,
      message: `business does not advertise capability "${capability}"`,
      // `services` is schema-required, but the optional chaining above
      // is cheap defense in case the codegen widens it back to optional.
      context: { capability, offered: services ? Object.keys(services).sort() : [] },
    })
  }

  const inRange = entries.filter((e) => isVersionInRange(e.version, agentRange))
  if (inRange.length === 0) {
    const offered = entries.map((e) => e.version).sort()
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROTOCOL_VERSION_INCOMPATIBLE,
      message: `no business ${capability} entry within agent range [${agentRange.min}..${agentRange.max}]; business offered ${offered.join(', ')}`,
      context: { capability, agentRange, offered },
    })
  }

  const candidate = inRange
    .filter(
      (e): e is ServiceEntry & { transport: Transport } =>
        typeof e.transport === 'string' &&
        (acceptableTransports as readonly string[]).includes(e.transport),
    )
    .sort((a, b) => {
      // Highest version first. ISO date strings sort lexicographically.
      if (a.version !== b.version) return a.version < b.version ? 1 : -1
      // Tie: caller's transport preference order wins. Array.sort is
      // stable since ES2019, so equal (version, transport) pairs retain
      // profile order — predictable when a single
      // version may carry multiple transports.
      return acceptableTransports.indexOf(a.transport) - acceptableTransports.indexOf(b.transport)
    })[0]

  if (candidate === undefined) {
    const offeredTransports = Array.from(
      new Set(inRange.map((e) => e.transport).filter((t): t is string => typeof t === 'string')),
    ).sort()
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.NO_COMPATIBLE_TRANSPORT,
      message: `business offers ${capability} within version range but no acceptable transport (acceptable: [${[...acceptableTransports].join(', ')}]; business: [${offeredTransports.join(', ') || 'none'}])`,
      context: { capability, acceptableTransports, offeredTransports },
    })
  }

  return {
    capability,
    version: candidate.version,
    transport: candidate.transport,
    entry: candidate,
  }
}

function isVersionInRange(version: string | undefined, range: AgentRange): boolean {
  if (version === undefined) return false
  return version >= range.min && version <= range.max
}
