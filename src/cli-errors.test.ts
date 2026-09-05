// CONTRACT: what the CLI actually EMITS on the error path.
//
// Every other error suite asserts on in-memory `UcpError` objects, which
// cannot see this: `cli.ts`'s error middleware emits `{code, message,
// retryable}`, or `{code, message, cta}` when the error carries one —
// `context` is NEVER serialized. So a remedy encoded in `context` (a
// `context.kind` discriminator, `context.supported`) does not exist for the
// primary audience: an agent reading CLI JSON.
//
// The property under test is therefore not "the error has the right fields"
// but: IF A CODE'S REMEDY DEPENDS ON A FIELD, THAT FIELD SURVIVES
// SERIALIZATION. These run the real dispatcher, the real middleware, and the
// real core (mocked transport only) — nothing about the envelope is stubbed.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedSession, ResolveSessionOptions } from './cli/session.js'
import { createUcpCli } from './cli.js'
import { discover } from './core/discover.js'
import { RELEASES } from './core/releases.js'
import { setWarnWriter } from './core/verbose.js'
import { serveCli, userProfile } from './test-utils.js'

const BUSINESS_URL = 'https://shop.example.invalid'
const MCP_ENDPOINT = 'https://shop.example.invalid/ucp/mcp'
const AGENT_PROFILE_URL = 'https://agent.example.invalid/agent.json'

/** Shopify's published 08-25 agent profile — the identity on the default path. */
function publishedAgentProfile(): unknown {
  return JSON.parse(RELEASES['2026-08-25'].agentProfileJson)
}

const CONFORMANT_BUSINESS = {
  ucp: {
    version: '2026-08-25',
    services: {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp', endpoint: MCP_ENDPOINT }],
    },
    payment_handlers: {},
  },
}

interface WireError {
  code?: string
  message?: string
  context?: unknown
  cta?: { description?: string; commands?: { command: string }[] }
  retryable?: boolean
}

interface StubOpts {
  /**
   * The active profile's local `profile.json`. AGENT_PROFILE_URL is
   * self-hosted, so this document IS the identity the CLI negotiates from —
   * it is read from disk, never fetched. Default: the published 08-25
   * profile, i.e. a profile whose local copy matches what it publishes.
   */
  agentProfile?: unknown
  /** Body for `/.well-known/ucp`. */
  business?: unknown
  /** Bodies for `/.well-known/ucp/<version>` leaves. */
  leaves?: Record<string, unknown>
  /** JSON-RPC error envelope returned for `tools/list` instead of a result. */
  rpcError?: { code: number; message: string; data?: unknown }
  /**
   * Other profiles on this machine, as `name -> meta.profile_url`. Feeds the
   * PROTOCOL_VERSION_INCOMPATIBLE switch-profiles hint, which resolves a
   * local profile's version from its hosted URL (release defaults only — see
   * cli/profile-hint.ts).
   */
  localProfiles?: Record<string, string>
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' },
  })
}

function stubFetch(opts: StubOpts): typeof fetch {
  return vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url)
    // Loud on purpose: the request path resolves its identity from local
    // bytes, so a GET here means a pre-flight fetch came back.
    if (u === AGENT_PROFILE_URL) throw new Error(`agent profile URL must not be fetched: ${u}`)
    if (u.endsWith('/.well-known/ucp')) {
      return jsonResponse(opts.business ?? CONFORMANT_BUSINESS)
    }
    const versioned = /\/\.well-known\/ucp\/([^/]+)$/.exec(u)
    if (versioned !== null) {
      const body = opts.leaves?.[versioned[1] as string]
      if (body === undefined) return new Response('not found', { status: 404 })
      return jsonResponse(body)
    }
    const requestBody =
      typeof init.body === 'string' ? (JSON.parse(init.body) as { id?: unknown }) : undefined
    if (opts.rpcError !== undefined) {
      return jsonResponse({ jsonrpc: '2.0', id: requestBody?.id ?? 1, error: opts.rpcError })
    }
    return jsonResponse({
      jsonrpc: '2.0',
      id: requestBody?.id ?? 1,
      result: { tools: [{ name: 'search_catalog', inputSchema: { type: 'object' } }] },
    })
  }) as unknown as typeof globalThis.fetch
}

describe('emitted CLI error JSON', () => {
  let cacheDir: string
  let home: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'ucp-cli-wire-errors-'))
    home = await mkdtemp(join(tmpdir(), 'ucp-cli-wire-errors-home-'))
    vi.stubEnv('UCP_HOME', home)
    // loadAgentProfile can uwarn; keep it off the suite's stderr.
    setWarnWriter(() => {})
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(cacheDir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    setWarnWriter(null)
  })

  /** Run `ucp discover` against the real core with a stubbed transport. */
  async function runDiscover(
    opts: StubOpts & { capability?: string },
  ): Promise<{ wire: WireError; exitCode: number }> {
    // The identity comes off disk, so the fixture is a real profile tree.
    const dir = join(home, 'profiles', 'agent')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'profile.json'),
      JSON.stringify(opts.agentProfile ?? publishedAgentProfile()),
    )
    const fetch = stubFetch(opts)
    const session = async (o: ResolveSessionOptions = {}): Promise<ResolvedSession> => ({
      profile: { name: o.profile ?? 'agent', profileUrl: AGENT_PROFILE_URL },
      ...(o.business !== undefined ? { business: o.business } : {}),
    })
    const localProfiles = opts.localProfiles ?? {}
    const cli = createUcpCli({
      resolveSession: session,
      profile: {
        listProfiles: async () => Object.keys(localProfiles).sort(),
        readUserProfile: async (name: string) => {
          const profile_url = localProfiles[name]
          if (profile_url === undefined) throw new Error(`no such profile: ${name}`)
          return userProfile(name, { meta: { profile_url } })
        },
      },
      discover: (businessUrl, options = {}) =>
        discover(businessUrl, {
          ...options,
          cacheDir,
          fetch,
          ...(opts.capability !== undefined ? { capabilities: [opts.capability] } : {}),
        }),
    })
    const { output, exitCode } = await serveCli(cli, ['discover', BUSINESS_URL])
    return { wire: JSON.parse(output) as WireError, exitCode }
  }

  // ── The constraint these tests exist to pin ────────────────────────────

  it('never serializes `context` — the reason remedies must live in code/message/cta', async () => {
    const { wire } = await runDiscover({
      business: {
        ucp: {
          version: '2026-12-01',
          services: {
            'dev.ucp.shopping': [
              { version: '2026-12-01', transport: 'mcp', endpoint: MCP_ENDPOINT },
            ],
          },
          payment_handlers: {},
        },
      },
    })
    expect(wire.code).toBe('PROTOCOL_VERSION_INCOMPATIBLE')
    expect(wire.context).toBeUndefined()
  })

  // ── PROTOCOL_VERSION_INCOMPATIBLE ──────────────────────────────────────
  //
  // Remedy depends on BOTH sets: "upgrade the CLI" if the business is ahead of
  // our window, "switch profile" if it offers something else in our window.

  it('PROTOCOL_VERSION_INCOMPATIBLE carries the business offer AND our window', async () => {
    const { wire, exitCode } = await runDiscover({
      business: {
        ucp: {
          version: '2026-12-01',
          services: {
            'dev.ucp.shopping': [
              { version: '2026-12-01', transport: 'mcp', endpoint: MCP_ENDPOINT },
            ],
          },
          payment_handlers: {},
        },
      },
    })

    expect(exitCode).toBe(1)
    expect(wire.code).toBe('PROTOCOL_VERSION_INCOMPATIBLE')
    // theirs
    expect(wire.message).toContain('offers UCP 2026-12-01')
    // ours
    expect(wire.message).toContain('ucp-cli supports 2026-04-08, 2026-08-25')
    // ...and WHICH identity was presented, by its switchable local name.
    // `DiscoverOptions.profileName` now carries it from the session, so the
    // label is `profile 'agent'` rather than the raw URL — a URL names
    // nothing the reader can pass to `--profile`.
    expect(wire.message).toContain("profile 'agent' uses 2026-08-25")
  })

  // ── the switch-profiles hint (design §S6) ──────────────────────────────
  //
  // "Upgrade the CLI" and "switch profiles" are different remedies, and only
  // the CLI layer can tell which applies — core knows the version sets, not
  // what profiles exist on this machine. The hint rides a `cta` because
  // `context` is not serialized.

  it('offers --profile <name> when another local profile speaks a version the business offers', async () => {
    const { wire } = await runDiscover({
      // Active profile is 08-25; business speaks only 04-08.
      business: {
        ucp: {
          version: '2026-04-08',
          services: {
            'dev.ucp.shopping': [
              { version: '2026-04-08', transport: 'mcp', endpoint: MCP_ENDPOINT },
            ],
          },
          payment_handlers: {},
        },
      },
      // Two other local profiles: one at 04-08 (offered) and one at 08-25
      // (not offered). Only the first is a remedy.
      localProfiles: {
        'agent-0408': RELEASES['2026-04-08'].defaultAgentProfileUrl,
        'agent-0825': RELEASES['2026-08-25'].defaultAgentProfileUrl,
        // Self-hosted: omitted by profile-hint (see cli/profile-hint.ts) —
        // suggesting a switch to a profile whose local copy may disagree with
        // what it publishes is a hint that lands where merchants cannot see.
        mine: 'https://agent.example.invalid/mine.json',
      },
    })

    expect(wire.code).toBe('PROTOCOL_VERSION_INCOMPATIBLE')
    expect(wire.cta?.description).toContain("'agent-0408' speaks 2026-04-08")
    expect(wire.cta?.description).not.toContain('agent-0825')
    expect(wire.cta?.description).not.toContain('mine')
    expect(wire.cta?.commands?.map((c) => c.command)).toStrictEqual([
      'ucp discover --profile agent-0408',
    ])
  })

  it('names EVERY matching profile — which one to use depends on what else it declares', async () => {
    const { wire } = await runDiscover({
      business: {
        ucp: {
          version: '2026-04-08',
          services: {
            'dev.ucp.shopping': [
              { version: '2026-04-08', transport: 'mcp', endpoint: MCP_ENDPOINT },
            ],
          },
          payment_handlers: {},
        },
      },
      localProfiles: {
        legacy: RELEASES['2026-04-08'].defaultAgentProfileUrl,
        'agent-0408': RELEASES['2026-04-08'].defaultAgentProfileUrl,
      },
    })

    expect(wire.cta?.commands?.map((c) => c.command)).toStrictEqual([
      'ucp discover --profile agent-0408',
      'ucp discover --profile legacy',
    ])
  })

  it('emits no hint when no local profile speaks an offered version', async () => {
    const { wire } = await runDiscover({
      business: {
        ucp: {
          version: '2026-12-01',
          services: {
            'dev.ucp.shopping': [
              { version: '2026-12-01', transport: 'mcp', endpoint: MCP_ENDPOINT },
            ],
          },
          payment_handlers: {},
        },
      },
      localProfiles: { 'agent-0408': RELEASES['2026-04-08'].defaultAgentProfileUrl },
    })

    // The business is outside the window entirely; "switch profiles" is not a
    // remedy and an empty CTA would be worse than none. The message still
    // carries the only available one (upgrade).
    expect(wire.code).toBe('PROTOCOL_VERSION_INCOMPATIBLE')
    expect(wire.cta).toBeUndefined()
  })

  // ── AGENT_PROFILE_VERSION_UNSUPPORTED ──────────────────────────────────

  it('AGENT_PROFILE_VERSION_UNSUPPORTED names the URL, its version, and our window', async () => {
    const body = publishedAgentProfile() as { ucp: Record<string, unknown> }
    body.ucp.version = '2025-01-01'
    body.ucp.services = {}
    body.ucp.capabilities = {}
    const { wire, exitCode } = await runDiscover({ agentProfile: body })

    expect(exitCode).toBe(1)
    expect(wire.code).toBe('AGENT_PROFILE_VERSION_UNSUPPORTED')
    expect(wire.message).toContain(AGENT_PROFILE_URL)
    expect(wire.message).toContain('declares UCP 2025-01-01')
    expect(wire.message).toContain('ucp-cli supports 2026-04-08, 2026-08-25')
    // The recovery path survives too.
    expect(wire.cta?.commands?.map((c) => c.command)).toContain('ucp profile list')
  })

  // ── AGENT_PROFILE_UNREACHABLE ──────────────────────────────────────────
  //
  // `context.reason` is the discriminator; it must be readable on the wire.
  // 'not_json' is the important one — a 200 serving an HTML error page is the
  // common self-hosting failure and is not "unreachable" in any useful sense.

  it('AGENT_PROFILE_UNREACHABLE now reaches the wire only when the BUSINESS reports it', async () => {
    // The CLI no longer pre-flights its own URL, so the one request-time
    // source of this code is the merchant answering -32001 with
    // `data.code: profile_unreachable` — it fetched the URL we sent and
    // could not read it. The remedy (fix hosting / run doctor) has to survive
    // serialization, because `context.reason` never does.
    const { wire, exitCode } = await runDiscover({
      rpcError: {
        code: -32001,
        message: 'UCP discovery failed',
        data: { code: 'profile_unreachable' },
      },
    })

    expect(exitCode).toBe(1)
    expect(wire.code).toBe('AGENT_PROFILE_UNREACHABLE')
    expect(wire.message).toContain(AGENT_PROFILE_URL)
    expect(wire.message).toContain('business reported profile_unreachable')
    expect(wire.cta?.commands?.map((c) => c.command)).toContain('ucp doctor')
  })

  // ── PROFILE_VERSION_MISMATCH (merchant defect) ─────────────────────────

  it('PROFILE_VERSION_MISMATCH stays a merchant-side code and names both versions', async () => {
    const leafUrl = `${BUSINESS_URL}/.well-known/ucp/2026-04-08`
    const { wire, exitCode } = await runDiscover({
      agentProfile: JSON.parse(RELEASES['2026-04-08'].agentProfileJson),
      business: {
        ucp: {
          ...CONFORMANT_BUSINESS.ucp,
          supported_versions: { '2026-04-08': leafUrl },
        },
      },
      // Linked as 2026-04-08, declares 2026-08-25 — the spec forbids using it.
      leaves: { '2026-04-08': CONFORMANT_BUSINESS },
    })

    expect(exitCode).toBe(1)
    expect(wire.code).toBe('PROFILE_VERSION_MISMATCH')
    // Not the agent-side code: grouping by `code` must never mix "fix your
    // profile" with "the merchant published a broken document".
    expect(wire.code).not.toBe('AGENT_PROFILE_VERSION_MISMATCH')
    expect(wire.message).toContain(leafUrl)
    expect(wire.message).toContain('declares UCP 2026-08-25')
    expect(wire.message).toContain('supported_versions["2026-04-08"]')
  })

  // ── AGENT_PROFILE_SERVICE_UNDECLARED ───────────────────────────────────
  //
  // The remedy ("add it to your profile" vs "you typo'd the id") depends on
  // seeing both sides, and `context` does not reach the wire.

  it('AGENT_PROFILE_SERVICE_UNDECLARED carries declared AND offered in the message', async () => {
    const { wire } = await runDiscover({
      capability: 'com.other.x',
      business: {
        ucp: {
          version: '2026-08-25',
          services: {
            'com.other.x': [{ version: '2026-08-25', transport: 'mcp', endpoint: MCP_ENDPOINT }],
          },
          payment_handlers: {},
        },
      },
    })

    expect(wire.code).toBe('AGENT_PROFILE_SERVICE_UNDECLARED')
    expect(wire.message).toContain('declared: [dev.ucp.shopping]')
    expect(wire.message).toContain('business offers: [com.other.x]')
    expect(wire.cta?.commands?.map((c) => c.command)).toContain('ucp profile show')
  })
})
