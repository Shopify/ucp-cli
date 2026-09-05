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
//   <ucpHome>/cache/businesses/<version>/<origin>.json   (supported_versions)
//   <ucpHome>/cache/toolslist/<origin>/<capability-or-hash>.json

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { z } from 'incur'

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { omitUndefined } from '../lib/omit-undefined.js'
import type { Transport } from '../lib/types.js'
import {
  type AgentProfile,
  type AgentServiceEntry,
  agentLabel,
  ENGINE_TRANSPORTS,
  isDevUcpKey,
  isReleaseDefaultProfileUrl,
  resolveAgentProfile,
} from './agent.js'
import { cacheCompute, originToFilename, ucpHomeDir } from './cache.js'
import { mcpRpc } from './mcp-client.js'
import { type BusinessProfile, fetchCompatibleBusinessProfile } from './profile.js'
import type { Version } from './releases.js'
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
 * Which document supplied the negotiated business rendering and at what
 * version.
 *
 * `version` is always the agent profile's exact version (the profile IS the
 * pick) and is deliberately unqualified: it mirrors `ucp.version` on the
 * wire.
 *
 * There is no `businessVersion`. It encoded the same bit `source` already
 * carries — the biconditional (`businessVersion !== version` ⇔ `source ===
 * 'supported_versions'`) holds by construction — and exposing a second date
 * invited exactly the reasoning this rewrite exists to delete
 * (`businessVersion > version ⇒ I'm behind`). Agents branch on the `source`
 * enum; operators get the business's headline version from the `discover:`
 * vlog line, and the failure case carries it in
 * `PROTOCOL_VERSION_INCOMPATIBLE.context`.
 */
export interface NegotiatedProtocol {
  version: Version
  source: 'well-known' | 'supported_versions'
  /**
   * URL of the BUSINESS document `profile` was parsed from. Named in full
   * because everywhere else in this codebase (`DiscoverOptions.profileUrl`,
   * `--profile-url`, `AgentProfile.url`) `profileUrl` means the AGENT's URL,
   * and that collision would ship inside JSON agents script against.
   */
  businessProfileUrl: string
}

/**
 * The composed view returned by `discover()`. Lossless principle:
 * `profile` preserves every field the business published (including
 * alternate-version services entries we didn't pick and services the agent
 * profile does not declare); `negotiated` is the derived dispatch view.
 */
export interface DiscoveredBusiness {
  business: string
  profile: BusinessProfile
  /** Where the negotiated rendering came from (version/source/URL). */
  protocol: NegotiatedProtocol
  /**
   * `agent.capabilities ∩ keys(business.ucp.capabilities)` — a client-side
   * PREDICTION of what the server will negotiate, for pre-call planning.
   * Not "negotiated": the server fetches the same agent profile, computes the
   * real intersection, and reports it in every response's `ucp.capabilities`
   * — that field is the authority and this one must not gate calls. `[]`
   * means the business publishes no capabilities map (or none we declare),
   * never "nothing works".
   */
  expectedCapabilities: readonly string[]
  negotiated: Record<string, NegotiatedCapability>
}

export interface DiscoverOptions {
  /**
   * The resolved, validated agent identity (NOT the local `ActiveProfile`
   * pointer). When omitted, `discover` resolves it from `profileUrl` +
   * `profileName` via `resolveAgentProfile` — the bundled snapshot on the
   * release-default path, the local `profile.json` when self-hosted, no
   * network in either case.
   */
  agent?: AgentProfile
  /**
   * Capabilities to resolve. When omitted, the capabilities negotiated are
   * `keys(agent.services) ∩ keys(business.ucp.services)` — what both sides
   * declare. Pass an explicit list (e.g. `['dev.ucp.shopping']`) to limit
   * work and lock the failure surface; explicitly requesting a service the
   * business offers and the agent profile does not declare is
   * `AGENT_PROFILE_SERVICE_UNDECLARED`.
   */
  capabilities?: string[]
  /** Override the cache root. Defaults to `<ucpHome>/cache`. */
  cacheDir?: string
  /** Skip cache reads for both profile and tools/list. */
  force?: boolean
  /** AbortSignal forwarded to fetch + JSON-RPC. */
  signal?: AbortSignal
  /** Platform profile URL advertised to the business during MCP discovery. */
  profileUrl?: string
  /**
   * LOCAL name of the profile `profileUrl` belongs to. Two jobs: it supplies
   * the `profile.json` that IS our identity when `profileUrl` is self-hosted,
   * and it labels messages — a version mismatch reads `profile 'agent-0408'
   * speaks 2026-04-08` and the remedy is `--profile agent-0408`, where the
   * raw URL (`agentLabel`) names no switchable thing. Ignored when `agent` is
   * injected — that object already carries both.
   */
  profileName?: string
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

  // Step 0 — agent identity, resolved locally. `resolveAgentProfile` reads
  // the bundled snapshot for a release-default URL and the local
  // `profile.json` for a self-hosted one; neither costs a request. Callers
  // that already hold a resolved AgentProfile inject it.
  const agent =
    options.agent ??
    (await resolveAgentProfile(
      omitUndefined({ url: options.profileUrl, name: options.profileName }),
    ))
  // The URL advertised on the wire (tools/list, tools/call) is the same
  // document we just negotiated against — one identity, both sides.
  const advertisedProfileUrl = options.profileUrl ?? agent.url

  // Step 1 — business profile selection at the agent's exact version.
  const resolved = await fetchCompatibleBusinessProfile(normalizedBusiness.origin, {
    cacheDir: profileCacheDir,
    agent,
    ...omitUndefined({
      fetch: options.fetch,
      signal: options.signal,
      force: options.force,
      headers: options.headers,
    }),
  })
  const { profile } = resolved
  if (resolved.source === 'supported_versions') {
    vlog(
      `discover: /.well-known/ucp is UCP ${resolved.businessVersion}; using supported_versions[${resolved.version}] → ${resolved.profileUrl}`,
    )
  }

  // Step 2 — service negotiation. Bare discover negotiates the DECLARED
  // intersection: business services the agent profile does not declare are
  // not negotiated (no platform side to negotiate with) and stay visible in
  // the lossless `profile` field. Explicit `capabilities` bypass the
  // intersection and may therefore hit AGENT_PROFILE_SERVICE_UNDECLARED.
  const services = profile.ucp.services as Record<string, unknown> | undefined
  const offered = services !== undefined ? Object.keys(services) : []
  // `Object.hasOwn`, not `!== undefined`: service ids are free-form strings in
  // the schema (json-schema-to-zod drops `propertyNames`), so a business could
  // publish `constructor` and a plain index lookup would inherit a truthy
  // value off Object.prototype.
  const declaredByAgent = (s: string) => Object.hasOwn(agent.services, s)
  const requested = options.capabilities ?? offered.filter(declaredByAgent).sort()
  if (options.capabilities === undefined) {
    // Dropping a service the business advertises must never be silent. The
    // adjacent stale-version case already vlogs; without this line "the
    // business offers it but `negotiated` has no entry" is indistinguishable
    // from a bug in this function.
    const skipped = offered.filter((s) => !declaredByAgent(s)).sort()
    if (skipped.length > 0) {
      vlog(
        `discover: not negotiating [${skipped.join(', ')}] — ${agentLabel(agent)} declares no service entry for them; they stay in \`profile\`. Declare them to negotiate them.`,
      )
    }
  }

  const negotiated: Record<string, NegotiatedCapability> = {}
  for (const capability of requested) {
    const negotiation = negotiateService({ profile, capability, agent })
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
      profileUrl: advertisedProfileUrl,
      ...omitUndefined({
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

  // Capability intersection is a prediction — the server computes the real
  // one from the same hosted profile and reports it in every response's
  // `ucp.capabilities`.
  const businessCapabilities = profile.ucp.capabilities as Record<string, unknown> | undefined
  const expectedCapabilities =
    businessCapabilities === undefined
      ? []
      : agent.capabilities.filter((c) => businessCapabilities[c] !== undefined)

  return {
    business: normalizedBusiness.origin,
    profile,
    protocol: {
      version: resolved.version,
      source: resolved.source,
      businessProfileUrl: resolved.profileUrl,
    },
    expectedCapabilities,
    negotiated,
  }
}

interface HydrateOptions {
  capability: string
  cacheKey: string
  negotiation: { version: string; transport: Transport; endpoint: string }
  cacheDir: string
  force?: boolean
  fetch?: typeof fetch
  signal?: AbortSignal
  /** Agent profile URL advertised in `meta.ucp-agent` — always present: the identity travels with every call. */
  profileUrl: string
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
        params: profileParams(opts.profileUrl),
        ...omitUndefined({
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

// ─── Step 2 — profile-driven service negotiation ─────────────────────────
//
// The agent profile supplies the PLATFORM side of the intersection; the
// business rendering supplies the business side. Both sides are exact-version:
// an entry negotiates iff some DECLARED (version, transport) pair EQUALS some
// OFFERED (version, transport) pair and that transport is one ucp-cli can
// actually execute. Compatibility is NEVER inferred from date order.
//
// Pattern: the profile declares, the engine constrains, the intersection is
// effective.
//
// ONE algorithm for every namespace. `dev.ucp.*` and `com.acme.*` differ only
// where `isDevUcpKey` is consulted for DIAGNOSTICS — whether an off-version
// entry is stale noise (the protocol's own services repeat the rendering's
// `ucp.version`, so anything else is a leftover) or a legitimate independent
// version line (third-party components version on their own clock). No
// structural branch: third-party services negotiate correctly precisely
// because the agent profile declares their versions and transports.
//
// What this is NOT:
//
//   • Protocol-version selection. That's Step 1
//     (`fetchCompatibleBusinessProfile` in profile.ts): the rendering passed
//     in here already matches `agent.version` exactly — it came from
//     `/.well-known/ucp` or from that version's `supported_versions` leaf.
//
//   • Endpoint validation. `services[cap][n]` already passed
//     `businessProfileSchema`, which rejects mcp/rest entries without
//     `endpoint` via the per-transport anyOf branches. The TypeScript
//     output type still types `endpoint?: string` because the branches
//     widen back at the type level — callers who need the URL extract it
//     at the use site (see the SERVICE_ENDPOINT_MISSING backstop above).
//
// Tie-break: when several mutual entries share the highest version, the
// agent profile's declaration order for that service decides (first declared
// transport wins). Array.prototype.sort is stable, so entries that tie on
// (version, transport) keep the business profile's own order.

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
  /** The winning BUSINESS entry — dispatch reads `endpoint` off it. */
  entry: ServiceEntry
}

export interface NegotiateOptions {
  /** The business rendering selected in Step 1 (already at `agent.version`). */
  profile: BusinessProfile
  capability: string
  /** The fetched agent identity — the platform side of the intersection. */
  agent: AgentProfile
}

export function negotiateService(options: NegotiateOptions): NegotiatedService {
  const { profile, capability, agent } = options
  const who = agentLabel(agent)

  // Both sides, then classify. Order matters and is NOT symmetric:
  //
  //   agent declares | business offers | result
  //   ---------------|-----------------|------------------------------------
  //   no             | yes             | AGENT_PROFILE_SERVICE_UNDECLARED
  //   yes            | no              | CAPABILITY_NOT_OFFERED
  //   no             | no              | CAPABILITY_NOT_OFFERED
  //   yes            | yes             | negotiate
  //
  // The business side is checked FIRST because "add it to your profile" is
  // only true advice when adding it would help: for `--capability
  // com.typo.svc` (an id neither side has) it would send the user to edit a
  // document that cannot make the call succeed. A typo is not a profile
  // problem.
  //
  // `declared` is only undefined when the caller named the capability
  // explicitly (`--capability`, operation dispatch): bare discover requests
  // `keys(agent.services) ∩ keys(business.ucp.services)`, so an undeclared
  // service is simply not negotiated (it stays in the lossless `profile`
  // field of the output, and discover vlogs the exclusion).
  const declared = Object.hasOwn(agent.services, capability)
    ? agent.services[capability]
    : undefined
  const services = profile.ucp.services as Record<string, ServiceEntry[]> | undefined
  const bizEntries =
    services !== undefined && Object.hasOwn(services, capability) ? services[capability] : undefined
  // `services` is schema-required, but the optional chaining is cheap defense
  // in case the codegen widens it back to optional.
  const offeredIds = services ? Object.keys(services).sort() : []
  // A fine-grained capability id (`dev.ucp.shopping.cart`) is not a service
  // id: capabilities are feature flags the server negotiates, services are
  // dispatch endpoints. Worth saying explicitly in either branch below.
  const isCapabilityId = agent.capabilities.includes(capability)

  if (bizEntries === undefined || bizEntries.length === 0) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.CAPABILITY_NOT_OFFERED,
      message: isCapabilityId
        ? `business does not advertise capability "${capability}"; note ${who} declares it as a capability, not a service — only services (e.g. dev.ucp.shopping) carry an endpoint to negotiate`
        : `business does not advertise capability "${capability}"`,
      context: { capability, offered: offeredIds },
    })
  }

  if (declared === undefined) {
    // The business DOES offer it — so the profile is genuinely the fix, and
    // naming both sides lets an agent tell "add it to my profile" from "I
    // typo'd the id" without another round-trip. Both sets go in the message
    // as well as `context`: cli.ts serializes only {code, message, cta}.
    const declaredIds = Object.keys(agent.services).sort()
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.AGENT_PROFILE_SERVICE_UNDECLARED,
      message: isCapabilityId
        ? `${who} declares ${capability} as a capability, not a service, but the business offers it as one; declare it under ucp.services to negotiate it (declared services: [${declaredIds.join(', ')}])`
        : `${who} does not declare ${capability}, which the business offers; add it to the profile to negotiate it (declared: [${declaredIds.join(', ')}]; business offers: [${offeredIds.join(', ')}])`,
      context: {
        capability,
        /** Service ids OUR profile declares. */
        declared: declaredIds,
        /** Service ids the BUSINESS offers. */
        offered: offeredIds,
        profileUrl: agent.url,
        ...(agent.name !== undefined ? { profile: agent.name } : {}),
      },
      cta: {
        description:
          'The hosted agent profile is the platform side of every negotiation. Declare the service there, and upload the corrected document to your profile URL, before requesting it.',
        commands: [
          { command: 'ucp profile show', description: 'print the active profile document' },
        ],
      },
    })
  }

  const declaredVersions = new Set(declared.map((e) => e.version))
  // (version, transport) pairs the profile declares AND ucp-cli can run.
  // Declared entries the engine cannot execute stay visible in `declared`
  // (messages must quote the profile honestly) but never match.
  const speakable = new Set<string>()
  for (const entry of declared) {
    if (typeof entry.transport !== 'string') continue
    if (!(ENGINE_TRANSPORTS as readonly string[]).includes(entry.transport)) continue
    speakable.add(pairKey(entry.version, entry.transport))
  }

  const mutual = bizEntries.filter(
    (e): e is ServiceEntry & { transport: Transport } =>
      typeof e.transport === 'string' && speakable.has(pairKey(e.version, e.transport)),
  )

  // Stale-entry diagnostic, `dev.ucp.*` only. Shopify storefront profiles
  // still carry `embedded@2026-04-08` under an 2026-08-25 rendering; that is
  // a platform defect filed separately, and it must not read as a negotiation
  // failure here (it isn't one — see S3). Third-party services are exempt:
  // their off-version entries are legitimate independent version lines.
  const stale = bizEntries.filter((e) => !declaredVersions.has(e.version))
  if (stale.length > 0 && isDevUcpKey(capability)) {
    vlog(
      `negotiate: ignoring ${capability} entries at [${uniqueSorted(stale.map((e) => e.version)).join(', ')}]; ${who} uses UCP ${agent.version}`,
    )
  }

  if (mutual.length === 0) {
    // Cascade, most-specific first. Each rung answers a different "who acts?".
    const atDeclaredVersion = bizEntries.filter((e) => declaredVersions.has(e.version))
    if (atDeclaredVersion.length > 0) {
      // Version agreed; transport did not. Report at the highest agreed
      // version — the one negotiation would have picked.
      const version = uniqueSorted(atDeclaredVersion.map((e) => e.version)).at(-1) as string
      const offeredTransports = uniqueSorted(
        atDeclaredVersion.filter((e) => e.version === version).map((e) => e.transport ?? 'none'),
      )
      throw new UcpError({
        layer: 'transport',
        code: ErrorCodes.NO_COMPATIBLE_TRANSPORT,
        message: `at UCP ${version}, ${capability} is offered over [${offeredTransports.join(', ')}]; ${who} declares [${uniqueSorted(declaredTransports(declared)).join(', ')}]; ucp-cli supports [${ENGINE_TRANSPORTS.join(', ')}]`,
        context: {
          capability,
          version,
          offeredTransports,
          declaredTransports: uniqueSorted(declaredTransports(declared)),
          engineTransports: [...ENGINE_TRANSPORTS],
        },
      })
    }

    // A `dev.ucp.*` service in a rendering at version V must carry an entry
    // at V (spec: every entry under a service repeats that service version).
    // The profile declares V and the rendering IS V (Step 1 selected it by
    // exact equality) — so an empty intersection here is the merchant's
    // document contradicting itself. Nothing to fix client-side; surface it
    // as the merchant defect it is.
    const renderedVersion = profile.ucp.version
    if (isDevUcpKey(capability) && declaredVersions.has(renderedVersion)) {
      throw new UcpError({
        layer: 'transport',
        code: ErrorCodes.PROFILE_VERSION_MISMATCH,
        message: `business profile is UCP ${renderedVersion} but advertises ${capability} only at [${uniqueSorted(bizEntries.map((e) => e.version)).join(', ')}] — a dev.ucp.* service must carry an entry at the rendering's own version`,
        context: {
          kind: 'service-entries',
          capability,
          expected: renderedVersion,
          offered: uniqueSorted(bizEntries.map((e) => e.version)),
        },
      })
    }

    // Two independent version lines that do not meet. Typical for
    // third-party components (`com.acme.svc`): both documents are internally
    // consistent, they just disagree. The agent updates its profile (or
    // accepts unavailability).
    //
    // Except when the profile is a release default. Then "update your
    // profile" names a remedy the reader cannot perform: the document is
    // platform-published and read-only, and reaching this rung means IT is
    // the defective side (its `dev.ucp.*` entry sits off its own
    // `ucp.version`; the loader already warned). Keep the behavior — a
    // pre-flight fatal would break every business including ones where the
    // defect is irrelevant — and name the actual situation instead.
    const platformPublished = isReleaseDefaultProfileUrl(agent.url)
    const declaredList = uniqueSorted([...declaredVersions]).join(', ')
    const offeredList = uniqueSorted(bizEntries.map((e) => e.version)).join(', ')
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.SERVICE_VERSION_INCOMPATIBLE,
      message: platformPublished
        ? `${capability}: the published agent profile at ${agent.url} declares [${declaredList}] while the business offers [${offeredList}] — that profile is a defect in a platform-published document, not something you can edit. Host a corrected copy at a URL you own (\`ucp profile init --profile-url <your-url>\`, fix the ${capability} entry, upload it to that URL) or accept unavailability.`
        : `${capability}: ${who} declares [${declaredList}], business offers [${offeredList}]`,
      context: {
        capability,
        declaredVersions: uniqueSorted([...declaredVersions]),
        offeredVersions: uniqueSorted(bizEntries.map((e) => e.version)),
        profileUrl: agent.url,
        /** True when the agent profile is platform-published (read-only to the user). */
        agentProfilePublished: platformPublished,
        ...(agent.name !== undefined ? { profile: agent.name } : {}),
      },
    })
  }

  // Highest mutual version wins; ties go to the profile's declaration order.
  // For `dev.ucp.*` the declared set is `{agent.version} × {mcp}` by
  // construction (the snapshot rule, validated at profile load), so "highest"
  // is a no-op there — it only bites for third-party services whose profile
  // declares several versions and whose business offers more than one of them.
  const rank = transportRanker(declared)
  const candidate = [...mutual].sort((a, b) => {
    if (a.version !== b.version) return a.version < b.version ? 1 : -1
    return rank(a.transport) - rank(b.transport)
  })[0] as ServiceEntry & { transport: Transport }

  return {
    capability,
    version: candidate.version,
    transport: candidate.transport,
    entry: candidate,
  }
}

function pairKey(version: string, transport: string): string {
  return `${version}\u0000${transport}`
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function declaredTransports(declared: readonly AgentServiceEntry[]): string[] {
  return declared.map((e) => e.transport).filter((t): t is string => typeof t === 'string')
}

/** Rank by first appearance in the profile's declaration for this service. */
function transportRanker(declared: readonly AgentServiceEntry[]): (transport: string) => number {
  const order = new Map<string, number>()
  declared.forEach((entry, index) => {
    if (typeof entry.transport !== 'string') return
    if (!order.has(entry.transport)) order.set(entry.transport, index)
  })
  return (transport: string) => order.get(transport) ?? Number.MAX_SAFE_INTEGER
}
