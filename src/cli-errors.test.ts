// CONTRACT: what the CLI actually EMITS on the error path.
//
// Every other error suite asserts on in-memory `UcpError` objects, which
// cannot see this: the emitted error is one FLAT object — `code` and
// `message` always, plus `retryable` and `cta` as independently optional
// fields that can both appear — and `context`/`http_status` are NEVER
// serialized. So a remedy encoded in `context` (a `context.kind`
// discriminator, `context.supported`) does not exist for the primary
// audience: an agent reading CLI JSON.
//
// The property under test is therefore not "the error has the right fields"
// but: IF A CODE'S REMEDY DEPENDS ON A FIELD, THAT FIELD SURVIVES
// SERIALIZATION. These run the real dispatcher, the real middleware, and the
// real core (mocked transport only) — nothing about the envelope is stubbed.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedSession, ResolveSessionOptions } from './cli/session.js'
import { createUcpCli } from './cli.js'
import {
  createAdHocProfile,
  createDiyProfile,
  createManagedProfile,
  type ProfileSource,
} from './core/agent.js'
import { discover } from './core/discover.js'
import type { ProfileKind } from './core/legacy-profile.js'
import { RELEASES, type Version } from './core/releases.js'
import { setWarnWriter } from './core/verbose.js'
import { serveCli, userProfile } from './test-utils.js'

const BUSINESS_URL = 'https://shop.example.invalid'
const MCP_ENDPOINT = 'https://shop.example.invalid/ucp/mcp'
const AGENT_PROFILE_URL = 'https://agent.example.invalid/agent.json'

/** The 08-25 release template written by profile init. */
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
   * The active Profile's singleton body. Default: the published 08-25
   * document, representing a local body that matches what its URL serves.
   */
  agentProfile?: unknown
  /** Body for `/.well-known/ucp`. */
  business?: unknown
  /** Bodies for `/.well-known/ucp/<version>` leaves. */
  leaves?: Record<string, unknown>
  /** JSON-RPC error envelope returned for `tools/list` instead of a result. */
  rpcError?: { code: number; message: string; data?: unknown }
  /** Body provenance of the active Profile. Defaults to a DIY singleton. */
  profileSource?: ProfileSource
  /** Explicit URL-override provenance for a DIY body. Defaults false. */
  urlOverride?: boolean
  /**
   * Other Profiles on this machine. DIY candidates use their body version;
   * managed aliases offer every installed rendering.
   */
  localProfiles?: Record<string, { version: Version; profileUrl?: string; kind?: ProfileKind }>
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
  ): Promise<{ wire: WireError; exitCode: number; profileListCalls: number }> {
    const fetch = stubFetch(opts)
    const session = async (o: ResolveSessionOptions = {}): Promise<ResolvedSession> => {
      const name = o.profile ?? 'agent'
      const profile =
        opts.profileSource === 'managed'
          ? createManagedProfile(name)
          : opts.profileSource === 'url'
            ? createAdHocProfile(AGENT_PROFILE_URL, name)
            : createDiyProfile({
                name,
                url: AGENT_PROFILE_URL,
                urlOverride: opts.urlOverride ?? false,
                body: opts.agentProfile ?? publishedAgentProfile(),
              })
      return {
        profile,
        profileMeta: {},
        ...(o.business !== undefined ? { business: o.business } : {}),
      }
    }
    const localProfiles = opts.localProfiles ?? {}
    let profileListCalls = 0
    const cli = createUcpCli({
      resolveSession: session,
      profile: {
        listProfiles: async () => {
          profileListCalls += 1
          return Object.keys(localProfiles).sort()
        },
        readUserProfile: async (name: string) => {
          const candidate = localProfiles[name]
          if (candidate === undefined) throw new Error(`no such profile: ${name}`)
          return userProfile(name, {
            body: JSON.parse(RELEASES[candidate.version].agentProfileJson),
            meta: candidate.profileUrl === undefined ? {} : { profile_url: candidate.profileUrl },
            kind: candidate.kind ?? 'diy',
          })
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
    return { wire: JSON.parse(output) as WireError, exitCode, profileListCalls }
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

  it('preserves the actual-name Profile repair CTA for local store schema failures', async () => {
    const name = 'actual-name'
    const dir = join(home, 'profiles', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'profile.json'), JSON.stringify({ ucp: { version: '2026-08-25' } }))
    await writeFile(
      join(dir, 'meta.json'),
      JSON.stringify({ profile_url: 'https://owned.example/profile.json' }),
    )

    const { output, exitCode } = await serveCli(createUcpCli(), ['profile', 'show', name])
    const wire = JSON.parse(output) as WireError

    expect(exitCode).toBe(1)
    expect(wire.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(wire.cta?.description).toMatch(/rewrite.*local DIY.*document.*identity/i)
    expect(wire.cta?.commands?.map((command) => command.command)).toEqual([
      'ucp profile init --name actual-name --force',
    ])
    expect(JSON.stringify(wire.cta)).not.toContain('--input-schema')
    expect(JSON.stringify(wire.cta)).not.toContain('<name>')

    // The exact emitted command is executable and repairs the bad document
    // without silently abandoning the custom identity URL in valid meta.json.
    const repaired = await serveCli(createUcpCli(), ['profile', 'init', '--name', name, '--force'])
    expect(repaired.exitCode).toBe(0)
    expect(JSON.parse(repaired.output)).toMatchObject({ name, created: true })
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8'))).toMatchObject({
      profile_url: 'https://owned.example/profile.json',
      kind: 'diy',
    })
  })

  it('does not promise URL preservation when meta.json itself is invalid', async () => {
    const name = 'broken-meta'
    const dir = join(home, 'profiles', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'profile.json'), RELEASES['2026-08-25'].agentProfileJson)
    await writeFile(join(dir, 'meta.json'), '{ not json')

    const { output, exitCode } = await serveCli(createUcpCli(), ['profile', 'show', name])
    const wire = JSON.parse(output) as WireError

    expect(exitCode).toBe(1)
    expect(wire.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(wire.cta?.description).toMatch(/cannot preserve.*custom profile_url/i)
    expect(wire.cta?.description).toContain('--profile-url')
    expect(wire.cta?.description).not.toMatch(/custom profile_url is preserved/i)
    expect(wire.cta?.commands?.map((command) => command.command)).toEqual([
      `ucp profile init --name ${name} --force`,
    ])
  })

  it('emits a working actual-name PROFILE_NOT_FOUND CTA on the commerce read path', async () => {
    const name = 'missing-commerce-profile'

    const { output, exitCode } = await serveCli(createUcpCli(), [
      'discover',
      BUSINESS_URL,
      '--profile',
      name,
    ])
    const wire = JSON.parse(output) as WireError

    expect(exitCode).toBe(1)
    expect(wire.code).toBe('PROFILE_NOT_FOUND')
    expect(wire.cta?.commands?.map((command) => command.command)).toEqual([
      `ucp profile init --name ${name} --force`,
    ])
    expect(JSON.stringify(wire.cta)).not.toContain('<name>')

    const repaired = await serveCli(createUcpCli(), ['profile', 'init', '--name', name, '--force'])
    expect(repaired.exitCode).toBe(0)
    expect(JSON.parse(repaired.output)).toMatchObject({ name, created: true })
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
    // ...and WHICH identity was presented, by its switchable local name. The
    // runtime Profile carries that name, so the label is `profile 'agent'`
    // rather than a raw URL the reader cannot pass to `--profile`.
    expect(wire.message).toContain("profile 'agent' offers 2026-08-25")
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
      // Version comes from each local document, not its URL. The first two
      // deliberately point at URLs associated with the opposite release;
      // `mine` proves a URL the user owns participates on the same terms.
      localProfiles: {
        'agent-0408': {
          version: '2026-04-08',
          profileUrl: RELEASES['2026-08-25'].defaultAgentProfileUrl,
        },
        'agent-0825': {
          version: '2026-08-25',
          profileUrl: RELEASES['2026-04-08'].defaultAgentProfileUrl,
        },
        mine: { version: '2026-04-08', profileUrl: 'https://agent.example.invalid/mine.json' },
      },
    })

    expect(wire.code).toBe('PROTOCOL_VERSION_INCOMPATIBLE')
    expect(wire.cta?.description).toContain("'agent-0408' speaks 2026-04-08")
    expect(wire.cta?.description).not.toContain('agent-0825')
    expect(wire.cta?.description).toContain("'mine' speaks 2026-04-08")
    expect(wire.cta?.description).toContain(
      'Shopify managed Profile offers every installed rendering',
    )
    expect(wire.cta?.description).toContain('without an explicit --profile')
    expect(wire.cta?.description).toContain('UCP_PROFILE unset')
    expect(wire.cta?.commands?.map((c) => c.command)).toStrictEqual([
      'ucp profile use --managed',
      'ucp discover --profile agent-0408',
      'ucp discover --profile mine',
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
        legacy: { version: '2026-04-08' },
        'agent-0408': { version: '2026-04-08' },
      },
    })

    expect(wire.cta?.commands?.map((c) => c.command)).toStrictEqual([
      'ucp profile use --managed',
      'ucp discover --profile agent-0408',
      'ucp discover --profile legacy',
    ])
  })

  it('offers the virtual managed Profile when a DIY singleton misses another installed release', async () => {
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
    })

    expect(wire.cta?.commands?.map((c) => c.command)).toEqual(['ucp profile use --managed'])
    expect(wire.cta?.description).toContain('newest mutual UCP 2026-04-08')
  })

  it('treats a managed local alias as every installed rendering, not its retained body', async () => {
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
        legacy: { version: '2026-08-25', kind: 'managed' },
      },
    })

    expect(wire.cta?.description).toContain("'legacy' is managed")
    expect(wire.cta?.description).toContain('selects newest mutual UCP 2026-04-08')
    expect(wire.cta?.description).not.toContain("'legacy' speaks 2026-08-25")
    expect(wire.cta?.commands?.map((c) => c.command)).toContain('ucp discover --profile legacy')
  })

  it('a managed runtime failure does not scan or suggest local aliases', async () => {
    const { wire, profileListCalls } = await runDiscover({
      profileSource: 'managed',
      business: {
        ucp: {
          version: '2026-12-01',
          services: {},
          payment_handlers: {},
        },
      },
      localProfiles: {
        legacy: { version: '2026-08-25', kind: 'managed' },
      },
    })

    expect(wire.code).toBe('PROTOCOL_VERSION_INCOMPATIBLE')
    expect(wire.message).toContain('managed Profile already offers every rendering installed')
    expect(wire.message).toContain('no local Profile')
    expect(wire.cta).toBeUndefined()
    expect(profileListCalls).toBe(0)
  })

  it('a scalar URL override suppresses impossible --profile retries', async () => {
    const { wire, profileListCalls } = await runDiscover({
      profileSource: 'url',
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
        'agent-0408': { version: '2026-04-08' },
        legacy: { version: '2026-08-25', kind: 'managed' },
      },
    })

    expect(wire.code).toBe('PROTOCOL_VERSION_INCOMPATIBLE')
    expect(wire.message).toContain('--profile-url/UCP_AGENT_PROFILE_URL')
    expect(wire.message).toContain('outranks stored meta/profile-name switching')
    expect(wire.message).toContain('intended exact authored/bundled rendering')
    expect(wire.cta).toBeUndefined()
    expect(JSON.stringify(wire)).not.toContain('ucp discover --profile')
    expect(profileListCalls).toBe(0)
  })

  it('a DIY body under a URL override suppresses every Profile-switch hint', async () => {
    const { wire, profileListCalls } = await runDiscover({
      profileSource: 'diy',
      urlOverride: true,
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
        'agent-0408': { version: '2026-04-08' },
        legacy: { version: '2026-08-25', kind: 'managed' },
      },
    })

    expect(wire.code).toBe('PROTOCOL_VERSION_INCOMPATIBLE')
    expect(wire.message).toContain("profile 'agent' offers 2026-08-25")
    expect(wire.message).toContain('--profile-url/UCP_AGENT_PROFILE_URL')
    expect(wire.message).toContain('outranks stored meta/profile-name switching')
    expect(wire.message).toContain('intended exact authored/bundled rendering')
    expect(wire.cta).toBeUndefined()
    expect(JSON.stringify(wire)).not.toContain('ucp discover --profile')
    expect(JSON.stringify(wire)).not.toContain('ucp profile use --managed')
    expect(profileListCalls).toBe(0)
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
      localProfiles: { 'agent-0408': { version: '2026-04-08' } },
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
  // `context.reason` is the in-process discriminator and never serializes,
  // so the sub-case has to be readable in `message`/`cta` instead.
  // 'not_json' is the important one — a 200 serving an HTML error page is a
  // common hosting failure and is not "unreachable" in any useful sense.

  it('AGENT_PROFILE_UNREACHABLE reaches the request path when the BUSINESS reports it', async () => {
    // The request path does not pre-flight its own URL; this code comes from
    // the merchant answering -32001 with
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
    expect(wire.message).toContain('local profile')
    expect(wire.cta?.commands?.map((c) => c.command)).toContain('ucp profile show')
  })

  it('AGENT_PROFILE_SERVICE_UNDECLARED keeps DIY edit/publish guidance under a URL override', async () => {
    const { wire } = await runDiscover({
      profileSource: 'diy',
      urlOverride: true,
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
    expect(wire.message).toContain('local profile.json')
    expect(wire.message).toContain('active --profile-url/UCP_AGENT_PROFILE_URL override')
    expect(wire.message).toContain(AGENT_PROFILE_URL)
    expect(wire.message).toContain('unset the override')
    expect(wire.cta?.commands?.map((c) => c.command)).toContain('ucp profile show')
    expect(JSON.stringify(wire)).not.toContain('meta.json')
  })

  it('AGENT_PROFILE_SERVICE_UNDECLARED gives managed-specific DIY guidance', async () => {
    const { wire } = await runDiscover({
      profileSource: 'managed',
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
    expect(wire.message).toContain('selected managed rendering is bundled')
    expect(wire.message).toContain('explicit DIY Profile')
    expect(wire.cta?.commands?.map((c) => c.command)).toEqual(['ucp profile init --help'])
    expect(JSON.stringify(wire)).not.toContain('ucp profile show')
    expect(JSON.stringify(wire)).not.toContain('profile.json')
  })

  it('AGENT_PROFILE_SERVICE_UNDECLARED tells a URL override to change or leave the override', async () => {
    const { wire } = await runDiscover({
      profileSource: 'url',
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
    expect(wire.message).toContain('--profile-url/UCP_AGENT_PROFILE_URL')
    expect(wire.message).toContain('create a DIY Profile')
    expect(JSON.stringify(wire)).not.toContain('meta.profile_url')
    expect(JSON.stringify(wire)).not.toContain('profile.json')
  })
})
