// Agent identity: loading and fetching OUR hosted profile.
//
// Everything here is `AGENT_PROFILE_*` and `layer: 'client'` — this module
// only ever looks at our own document. The business's document has its own
// `PROFILE_*` codes (profile.ts) and no code may mean both; the code→layer
// invariant is asserted separately in `lib/error-layers.test.ts`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fetchAgentProfileLive,
  isReleaseDefaultProfileUrl,
  loadAgentProfile,
  resolveAgentProfile,
} from './agent.js'
import { LATEST, RELEASES } from './releases.js'
import { setWarnWriter } from './verbose.js'

const SELF_HOSTED = 'https://agent.example.invalid/agent.json'
const DEFAULT_0825 = RELEASES['2026-08-25'].defaultAgentProfileUrl

/** The published 08-25 snapshot, mutable copy. */
function publishedBody(): { ucp: Record<string, unknown>; [k: string]: unknown } {
  return JSON.parse(RELEASES['2026-08-25'].agentProfileJson) as {
    ucp: Record<string, unknown>
  }
}

function captureWarnings(): string[] {
  const lines: string[] = []
  setWarnWriter((msg) => {
    lines.push(msg)
  })
  return lines
}

afterEach(() => {
  setWarnWriter(null)
})

describe('loadAgentProfile — failure codes are all AGENT_PROFILE_*', () => {
  it('AGENT_PROFILE_SCHEMA_INVALID when the body carries no ucp.version', () => {
    expect(() => loadAgentProfile({ body: { nope: true }, url: SELF_HOSTED })).toThrowError(
      expect.objectContaining({
        code: 'AGENT_PROFILE_SCHEMA_INVALID',
        layer: 'client',
      }) as unknown as Error,
    )
  })

  it('AGENT_PROFILE_SCHEMA_INVALID when the release schema rejects the body', () => {
    const body = publishedBody()
    body.ucp.services = 'reshaped'
    expect(() => loadAgentProfile({ body, url: SELF_HOSTED, name: 'agent' })).toThrowError(
      expect.objectContaining({
        code: 'AGENT_PROFILE_SCHEMA_INVALID',
        layer: 'client',
        context: { url: SELF_HOSTED, version: '2026-08-25' },
      }) as unknown as Error,
    )
  })

  it('AGENT_PROFILE_VERSION_UNSUPPORTED names both the profile version and our window', () => {
    const body = publishedBody()
    body.ucp.version = '2026-12-01'
    expect(() => loadAgentProfile({ body, url: SELF_HOSTED })).toThrowError(
      expect.objectContaining({
        code: 'AGENT_PROFILE_VERSION_UNSUPPORTED',
        layer: 'client',
        // Both sets in the message: cli.ts serializes {code, message, cta},
        // never `context`.
        message: `${SELF_HOSTED} declares UCP 2026-12-01; ucp-cli supports 2026-04-08, 2026-08-25`,
      }) as unknown as Error,
    )
  })
})

// ─── Severity split: whose document is it? ─────────────────────────────────
//
// A `dev.ucp.*` entry off the profile's own `ucp.version` is the same defect
// either way, but the remedy is not. Self-hosted: the user is the principal
// and can correct the hosted document → fatal. Release default: it is the platform's,
// and a pre-flight fatal there means one publisher defect hard-stops every
// installed CLI before a single call. Shopify storefront profiles carry
// exactly this defect today (`embedded@2026-04-08` under an 08-25 rendering).

describe('loadAgentProfile — AGENT_PROFILE_VERSION_MISMATCH severity split', () => {
  function mixedVersionBody(): ReturnType<typeof publishedBody> {
    const body = publishedBody()
    body.ucp.services = {
      'dev.ucp.shopping': [
        { version: '2026-08-25', transport: 'mcp' },
        { version: '2026-04-08', transport: 'mcp' },
      ],
    }
    return body
  }

  it('self-hosted → fatal, with an upload-it-yourself CTA and both versions named', () => {
    captureWarnings()
    expect(() =>
      loadAgentProfile({ body: mixedVersionBody(), url: SELF_HOSTED, name: 'mine' }),
    ).toThrowError(
      expect.objectContaining({
        code: 'AGENT_PROFILE_VERSION_MISMATCH',
        layer: 'client',
        context: {
          url: SELF_HOSTED,
          registry: 'services',
          key: 'dev.ucp.shopping',
          versions: ['2026-04-08'],
        },
      }) as unknown as Error,
    )
  })

  it('the fatal case carries no `kind` — that discriminator belongs to the merchant code', () => {
    let caught: { context: Record<string, unknown> } | undefined
    try {
      loadAgentProfile({ body: mixedVersionBody(), url: SELF_HOSTED })
    } catch (err) {
      caught = err as { context: Record<string, unknown> }
    }
    expect(caught?.context).not.toHaveProperty('kind')
  })

  it('release default → uwarn and proceed; the off-version entry simply will not match', () => {
    const warnings = captureWarnings()
    const agent = loadAgentProfile({ body: mixedVersionBody(), url: DEFAULT_0825, name: 'agent' })

    expect(agent.version).toBe('2026-08-25')
    // Declaration kept verbatim: messages must quote the profile honestly, and
    // negotiation is what discards the off-version entry.
    expect(agent.services['dev.ucp.shopping']?.map((e) => e.version)).toEqual([
      '2026-08-25',
      '2026-04-08',
    ])
    expect(warnings.join('')).toContain('dev.ucp.shopping at [2026-04-08]')
    expect(warnings.join('')).toContain('published release default')
  })

  it('isReleaseDefaultProfileUrl recognizes every release in the window', () => {
    for (const rel of Object.values(RELEASES)) {
      expect(isReleaseDefaultProfileUrl(rel.defaultAgentProfileUrl)).toBe(true)
    }
    expect(isReleaseDefaultProfileUrl(SELF_HOSTED)).toBe(false)
  })
})

// ─── Where the bytes come from: never the wire ─────────────────────────────
//
// The request path resolves its identity locally. A release default is the
// verbatim document this build ships; a self-hosted URL is whatever the user
// wrote in `profile.json`. Both go through the same `loadAgentProfile`, so the
// only thing these tests have to prove is that the SOURCE is right — and that
// no fetch implementation is even accepted, let alone called.

describe('resolveAgentProfile — release defaults come from the bundled snapshot', () => {
  it('resolves every release default to the document this build ships', async () => {
    for (const rel of Object.values(RELEASES)) {
      const agent = await resolveAgentProfile({ url: rel.defaultAgentProfileUrl, name: 'agent' })

      expect(agent.version).toBe(rel.version)
      expect(agent.url).toBe(rel.defaultAgentProfileUrl)
      // Identical to what a GET of that URL would have produced: the snapshot
      // is the verbatim published body (byte-identity is enforced by
      // `pnpm gen:schemas` + the CI drift gate).
      expect(agent).toStrictEqual(
        loadAgentProfile({
          body: JSON.parse(rel.agentProfileJson),
          url: rel.defaultAgentProfileUrl,
          name: 'agent',
        }),
      )
    }
  })

  it('defaults to the latest release when no URL is configured', async () => {
    const agent = await resolveAgentProfile()
    expect(agent.url).toBe(RELEASES[LATEST].defaultAgentProfileUrl)
    expect(agent.version).toBe(LATEST)
  })

  it('does not hand out the shared release template', async () => {
    const agent = await resolveAgentProfile({ url: DEFAULT_0825 })
    expect(agent.body).not.toBe(RELEASES['2026-08-25'].agentProfileTemplate)
  })
})

describe('resolveAgentProfile — a self-hosted URL is answered by the local profile.json', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ucp-agent-home-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function writeProfile(name: string, body: unknown): Promise<string> {
    const dir = join(home, 'profiles', name)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'profile.json')
    await writeFile(path, `${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}\n`)
    return path
  }

  // The premise the whole design rests on: `profile init` writes the same
  // document the URL serves, so the disk document and a fetched body are the
  // same shape and one validator consumes either. If this ever stops holding,
  // the self-hosted path is reading something a merchant will never see.
  it('produces exactly what the same bytes would produce over the wire', async () => {
    const served = JSON.parse(RELEASES['2026-08-25'].agentProfileJson) as unknown
    await writeProfile('mine', served)

    const agent = await resolveAgentProfile({ url: SELF_HOSTED, name: 'mine', homeDir: home })

    expect(agent).toStrictEqual(loadAgentProfile({ body: served, url: SELF_HOSTED, name: 'mine' }))
    expect(agent.version).toBe('2026-08-25')
    expect(Object.keys(agent.services)).toEqual(['dev.ucp.shopping'])
  })

  it('reads the user edits, not the bundled snapshot', async () => {
    const body = publishedBody()
    body.ucp.services = {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
      'com.acme.svc': [{ version: '2025-01-01', transport: 'mcp' }],
    }
    await writeProfile('mine', body)

    const agent = await resolveAgentProfile({ url: SELF_HOSTED, name: 'mine', homeDir: home })

    expect(Object.keys(agent.services).sort()).toEqual(['com.acme.svc', 'dev.ucp.shopping'])
  })

  it('is AGENT_PROFILE_SCHEMA_INVALID when the local document is not a UCP profile', async () => {
    await writeProfile('mine', { nope: true })
    await expect(
      resolveAgentProfile({ url: SELF_HOSTED, name: 'mine', homeDir: home }),
    ).rejects.toMatchObject({ code: 'AGENT_PROFILE_SCHEMA_INVALID', layer: 'client' })
  })

  it('is AGENT_PROFILE_SCHEMA_INVALID when profile.json is not valid JSON', async () => {
    await writeProfile('mine', '{ not json')
    await expect(
      resolveAgentProfile({ url: SELF_HOSTED, name: 'mine', homeDir: home }),
    ).rejects.toMatchObject({ code: 'AGENT_PROFILE_SCHEMA_INVALID', layer: 'client' })
  })

  it('names the file when there is no local document to read', async () => {
    await expect(
      resolveAgentProfile({ url: SELF_HOSTED, name: 'ghost', homeDir: home }),
    ).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
      message: expect.stringContaining('profile.json') as unknown as string,
    })
  })

  // Library-only rung: `discover({profileUrl})` with no profile name and no
  // injected agent. The URL on the wire is still right, so this warns and
  // negotiates generically rather than failing.
  it('warns and falls back to the bundled latest when no profile is named', async () => {
    const warnings = captureWarnings()
    const agent = await resolveAgentProfile({ url: SELF_HOSTED })

    expect(agent.url).toBe(SELF_HOSTED)
    expect(agent.version).toBe(LATEST)
    expect(warnings.join('')).toContain('no local profile was named')
  })
})

// ─── AGENT_PROFILE_UNREACHABLE.reason ──────────────────────────────────────
//
// Doctor's probe is the only fetcher left. The sub-cases must be branchable
// without regexing the message. `not_json` is the one that matters most: a 200
// serving an HTML error page is the common self-hosting failure and is not
// "unreachable" in any useful sense.

describe('fetchAgentProfileLive — AGENT_PROFILE_UNREACHABLE carries a reason', () => {
  function fetchStub(handler: (url: string) => Response | Promise<Response>): typeof fetch {
    return vi.fn(async (url: string | URL | Request) =>
      handler(String(url)),
    ) as unknown as typeof fetch
  }

  it('reports what the URL actually serves, and its cache policy', async () => {
    const fetch = fetchStub(
      () =>
        new Response(RELEASES['2026-04-08'].agentProfileJson, {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
        }),
    )
    // A release-default URL, read live: doctor is the only thing that can
    // catch published content changing out from under the bundled snapshot.
    const live = await fetchAgentProfileLive({ url: DEFAULT_0825, fetch })

    expect(live.agent.version).toBe('2026-04-08')
    expect(live.cacheControl).toBe('public, max-age=300')
  })

  it("reason 'network' for a failed connection", async () => {
    const fetch = fetchStub(() => {
      throw new Error('connect ECONNREFUSED')
    })
    await expect(
      fetchAgentProfileLive({ url: SELF_HOSTED, name: 'mine', fetch }),
    ).rejects.toMatchObject({
      code: 'AGENT_PROFILE_UNREACHABLE',
      layer: 'client',
      context: { url: SELF_HOSTED, reason: 'network', profile: 'mine' },
    })
  })

  it("reason 'http_status' for a non-2xx", async () => {
    const fetch = fetchStub(() => new Response('nope', { status: 404 }))
    await expect(fetchAgentProfileLive({ url: SELF_HOSTED, fetch })).rejects.toMatchObject({
      code: 'AGENT_PROFILE_UNREACHABLE',
      http_status: 404,
      context: { reason: 'http_status' },
    })
  })

  it("reason 'not_json' for a 200 serving HTML — the common self-hosting failure", async () => {
    const fetch = fetchStub(
      () =>
        new Response('<!doctype html><title>404 Not Found</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    await expect(fetchAgentProfileLive({ url: SELF_HOSTED, fetch })).rejects.toMatchObject({
      code: 'AGENT_PROFILE_UNREACHABLE',
      context: { reason: 'not_json' },
    })
  })

  it('names the reason in the message too, because `context` never reaches the wire', async () => {
    const fetch = fetchStub(() => new Response('nope', { status: 503 }))
    await expect(fetchAgentProfileLive({ url: SELF_HOSTED, fetch })).rejects.toMatchObject({
      message: expect.stringContaining('(http_status: HTTP 503)') as unknown as string,
    })
  })
})
