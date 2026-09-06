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

import { ErrorCodes, UcpError } from '../lib/errors.js'
import {
  agentProfileRedirect,
  fetchAgentProfileLive,
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
// wherever the URL points, and the remedy is the same too: the bytes ucp-cli
// declares come from `profile.json`, which the reader can edit. Proceeding
// would send a declaration whose off-version entries silently fail to
// negotiate.

describe('loadAgentProfile — AGENT_PROFILE_VERSION_MISMATCH', () => {
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

  it('is fatal, naming the entry that is off and both versions', () => {
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

  // Who serves the URL changes nothing about validating the local declaration.
  // `ucp doctor` separately detects disagreement with the served document.
  it('is fatal on a release-default URL too', () => {
    captureWarnings()
    expect(() =>
      loadAgentProfile({ body: mixedVersionBody(), url: DEFAULT_0825, name: 'agent' }),
    ).toThrowError(
      expect.objectContaining({ code: 'AGENT_PROFILE_VERSION_MISMATCH' }) as unknown as Error,
    )
  })

  // The one place always-fatal could break an install that did nothing wrong:
  // the no-profile-name fallback declares a document the reader did not write.
  // Safe only while every template ucp-cli ships obeys the rule it enforces —
  // and those templates are regenerated from the published documents (CI's
  // codegen drift gate), so this is a live constraint, not a one-time audit.
  it('every published template ucp-cli ships satisfies the rule it enforces', () => {
    for (const rel of Object.values(RELEASES)) {
      expect(() =>
        loadAgentProfile({
          body: JSON.parse(rel.agentProfileJson),
          url: rel.defaultAgentProfileUrl,
        }),
      ).not.toThrow()
    }
  })
})

// ─── Where the bytes come from: never the wire ─────────────────────────────
//
// The request path resolves its identity locally, and a named profile is
// answered by its own `profile.json` at every URL. The published templates are
// the last resort for a caller that supplies no name. So the only things these
// tests have to prove is that the SOURCE is right — and that no fetch
// implementation is even accepted, let alone called.

describe('resolveAgentProfile — no profile name falls back to a published template', () => {
  it('picks the template for the release the URL belongs to', async () => {
    for (const rel of Object.values(RELEASES)) {
      const agent = await resolveAgentProfile({ url: rel.defaultAgentProfileUrl })

      expect(agent.version).toBe(rel.version)
      expect(agent.url).toBe(rel.defaultAgentProfileUrl)
      // Identical to what a GET of that URL would have produced: the template
      // is the verbatim published body (byte-identity is enforced by
      // `pnpm gen:schemas` + the CI drift gate).
      expect(agent).toStrictEqual(
        loadAgentProfile({
          body: JSON.parse(rel.agentProfileJson),
          url: rel.defaultAgentProfileUrl,
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

describe('resolveAgentProfile — a named profile is answered by its own profile.json', () => {
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

  // THE contract, in one test: the URL is a Shopify-published release default
  // and the local file still wins. Anything else makes an edit to the one file
  // the reader owns a no-op that nothing reports.
  it('reads profile.json even when the URL is a release default', async () => {
    const body = publishedBody()
    body.ucp.services = {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
      'com.acme.svc': [{ version: '2025-01-01', transport: 'mcp' }],
    }
    await writeProfile('mine', body)

    const agent = await resolveAgentProfile({ url: DEFAULT_0825, name: 'mine', homeDir: home })

    expect(agent.url).toBe(DEFAULT_0825)
    expect(Object.keys(agent.services).sort()).toEqual(['com.acme.svc', 'dev.ucp.shopping'])
  })

  // The premise the whole design rests on: `profile init` writes the same
  // document the URL serves, so the disk document and a fetched body are the
  // same shape and one validator consumes either. If this ever stops holding,
  // the request path is reading something a merchant will never see.
  it('produces exactly what the same bytes would produce over the wire', async () => {
    const served = JSON.parse(RELEASES['2026-08-25'].agentProfileJson) as unknown
    await writeProfile('mine', served)

    const agent = await resolveAgentProfile({ url: SELF_HOSTED, name: 'mine', homeDir: home })

    expect(agent).toStrictEqual(loadAgentProfile({ body: served, url: SELF_HOSTED, name: 'mine' }))
    expect(agent.version).toBe('2026-08-25')
    expect(Object.keys(agent.services)).toEqual(['dev.ucp.shopping'])
  })

  it('reads the user edits, not a published template', async () => {
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

  // The rung no CLI path reaches: `discover({profileUrl})` with no profile
  // name and no injected agent. The URL on the wire is still right, so this
  // warns and negotiates generically rather than failing.
  it('warns and falls back to the latest published template when no profile is named', async () => {
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
// serving an HTML error page is the common hosting failure and is not
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
    // Doctor reads the URL directly, so it can detect when the served
    // document differs from the local profile.
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

  it("reason 'not_json' for a 200 serving HTML — the common hosting failure", async () => {
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

  // Our own hosting, so it stays on the `client` layer with the rest of the
  // AGENT_PROFILE_* family rather than escaping as the transport-layer
  // refusal core/http-client.ts raises.
  it("reason 'redirect' for a 3xx, decodable by agentProfileRedirect", async () => {
    const fetch = fetchStub(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/profile.json' },
        }),
    )
    const err = await fetchAgentProfileLive({ url: SELF_HOSTED, name: 'mine', fetch }).catch(
      (e: unknown) => e,
    )
    expect(err).toMatchObject({
      code: 'AGENT_PROFILE_UNREACHABLE',
      layer: 'client',
      http_status: 302,
      context: { url: SELF_HOSTED, reason: 'redirect', profile: 'mine' },
      message: expect.stringContaining('https://cdn.example.com/profile.json') as unknown as string,
    })
    expect(agentProfileRedirect(err)).toEqual({
      status: 302,
      location: 'https://cdn.example.com/profile.json',
    })
  })

  // The decoder reads the refusal it wrapped rather than a copy stored beside
  // it, so anything that claims `redirect` without carrying a decodable one is
  // `undefined` — a remedy printing `HTTP undefined` is worse than no remedy.
  it('agentProfileRedirect returns undefined unless the cause carries the refusal', () => {
    const claimsRedirect = (cause?: Error): UcpError =>
      new UcpError({
        layer: 'client',
        code: ErrorCodes.AGENT_PROFILE_UNREACHABLE,
        message: 'could not be read (redirect: ...)',
        context: { url: SELF_HOSTED, reason: 'redirect' },
        ...(cause !== undefined ? { cause } : {}),
      })
    const missingStatus = new UcpError({
      layer: 'transport',
      code: ErrorCodes.TRANSPORT_REDIRECT_REFUSED,
      message: 'refused',
      context: { url: SELF_HOSTED, location: 'https://cdn.example.com/profile.json' },
    })
    expect(agentProfileRedirect(claimsRedirect())).toBeUndefined()
    expect(agentProfileRedirect(claimsRedirect(new Error('boom')))).toBeUndefined()
    expect(agentProfileRedirect(claimsRedirect(missingStatus))).toBeUndefined()
    expect(agentProfileRedirect(new Error('boom'))).toBeUndefined()
  })

  it('names the reason in the message too, because `context` never reaches the wire', async () => {
    const fetch = fetchStub(() => new Response('nope', { status: 503 }))
    await expect(fetchAgentProfileLive({ url: SELF_HOSTED, fetch })).rejects.toMatchObject({
      message: expect.stringContaining('(http_status: HTTP 503)') as unknown as string,
    })
  })
})
