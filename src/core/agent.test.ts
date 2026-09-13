// Agent identity: loading and fetching OUR hosted profile.
//
// Everything here is `AGENT_PROFILE_*` and `layer: 'client'` — this module
// only ever looks at our own document. The business's document has its own
// `PROFILE_*` codes (profile.ts) and no code may mean both; the code→layer
// invariant is asserted separately in `lib/error-layers.test.ts`.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { rendering } from '../test-utils.js'
import {
  agentProfileRedirect,
  createAdHocProfile,
  createDiyProfile,
  createManagedProfile,
  fetchAgentProfileLive,
  loadAgentProfile,
} from './agent.js'
import { LATEST, RELEASES, SUPPORTED_VERSIONS } from './releases.js'
import { setVerboseWriter, setWarnWriter } from './verbose.js'

const SELF_HOSTED = 'https://agent.example.invalid/agent.json'
const DEFAULT_0825 = RELEASES['2026-08-25'].defaultAgentProfileUrl

/** The published 08-25 snapshot, mutable copy. */
function publishedBody(): { ucp: Record<string, unknown>; [k: string]: unknown } {
  return JSON.parse(RELEASES['2026-08-25'].agentProfileJson) as {
    ucp: Record<string, unknown>
  }
}

function profile042To070Body(): {
  ucp: {
    services: Record<string, Array<Record<string, unknown>>>
    capabilities: Record<string, Array<Record<string, unknown>>>
  }
  [key: string]: unknown
} {
  const body = JSON.parse(RELEASES['2026-04-08'].agentProfileJson) as ReturnType<
    typeof profile042To070Body
  >
  const shopping = body.ucp.services['dev.ucp.shopping']?.[0]
  if (shopping === undefined) throw new Error('published shopping entry missing')
  shopping.version = '2026-01-23'
  return body
}

function captureWarnings(): string[] {
  const lines: string[] = []
  setWarnWriter((msg) => {
    lines.push(msg)
  })
  return lines
}

afterEach(() => {
  setVerboseWriter(null)
  setWarnWriter(null)
})

describe('loadAgentProfile — failure codes are all AGENT_PROFILE_*', () => {
  it('AGENT_PROFILE_SCHEMA_INVALID when the body carries no ucp.version', () => {
    expect(() =>
      loadAgentProfile({
        body: { nope: true },
        url: SELF_HOSTED,
        source: 'diy',
        urlOverride: false,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'AGENT_PROFILE_SCHEMA_INVALID',
        layer: 'client',
      }) as unknown as Error,
    )
  })

  it('AGENT_PROFILE_SCHEMA_INVALID when the release schema rejects the body', () => {
    const body = publishedBody()
    body.ucp.services = 'reshaped'
    expect(() =>
      loadAgentProfile({
        body,
        url: SELF_HOSTED,
        source: 'diy',
        urlOverride: false,
        name: 'agent',
      }),
    ).toThrowError(
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
    expect(() =>
      loadAgentProfile({ body, url: SELF_HOSTED, source: 'diy', urlOverride: false }),
    ).toThrowError(
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

describe('createDiyProfile — ucp-cli 0.4.2–0.7.0 Profile compatibility', () => {
  it('normalizes only the runtime body at the DIY boundary and logs it', () => {
    const body = profile042To070Body()
    body.ucp.capabilities['com.acme.loyalty'] = [
      {
        version: '2026-04-08',
        spec: 'https://acme.test/loyalty/spec',
        schema: 'https://acme.test/loyalty/schema.json',
      },
    ]
    const before = structuredClone(body)
    const verbose: string[] = []
    setVerboseWriter((line) => verbose.push(line))

    const profile = createDiyProfile({ name: 'edited-042-070', body, url: SELF_HOSTED })
    const loaded = rendering(profile, '2026-04-08')

    expect(Object.keys(profile.renderings)).toEqual(['2026-04-08'])
    expect(loaded).toMatchObject({ source: 'diy', name: 'edited-042-070', url: SELF_HOSTED })
    expect(loaded.capabilities).toContain('com.acme.loyalty')
    expect(loaded.body).not.toBe(body)
    expect(body).toStrictEqual(before)
    expect(verbose.join('')).toContain('source bytes remain unchanged')
  })
})

// ─── Severity split: whose document is it? ─────────────────────────────────
//
// These direct-loader fixtures model DIY documents. A `dev.ucp.*` entry off
// the profile's own `ucp.version` would silently fail to negotiate, so loading
// it is fatal regardless of where its DIY author publishes it.

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
      loadAgentProfile({
        body: mixedVersionBody(),
        url: SELF_HOSTED,
        source: 'diy',
        urlOverride: false,
        name: 'mine',
      }),
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
      loadAgentProfile({
        body: mixedVersionBody(),
        url: SELF_HOSTED,
        source: 'diy',
        urlOverride: false,
      })
    } catch (err) {
      caught = err as { context: Record<string, unknown> }
    }
    expect(caught?.context).not.toHaveProperty('kind')
  })

  function mismatchError(name: string, url = SELF_HOSTED): UcpError {
    try {
      loadAgentProfile({ body: mixedVersionBody(), url, source: 'diy', urlOverride: false, name })
    } catch (err) {
      const mismatch = err as UcpError
      expect(mismatch.code).toBe(ErrorCodes.AGENT_PROFILE_VERSION_MISMATCH)
      return mismatch
    }
    throw new Error('expected profile mismatch')
  }

  it('uses the safe Profile name in the inspection command for a custom hosted URL', () => {
    const caught = mismatchError('mine')
    expect(caught.cta?.description).toContain('configured hosted URL')
    expect(
      caught.cta?.commands.map((entry) => (typeof entry === 'string' ? entry : entry.command)),
    ).toEqual(['ucp profile show mine', 'ucp doctor'])
  })

  it('falls back to bare profile show for an untrusted name', () => {
    const caught = mismatchError('mine; rm -rf ~')
    expect(caught.cta?.commands[0]).toMatchObject({ command: 'ucp profile show' })
    expect(JSON.stringify(caught.cta)).not.toContain('mine; rm -rf ~')
  })

  it('directs release-default users to host and select the complete corrected document', () => {
    captureWarnings()
    const caught = mismatchError('agent', DEFAULT_0825)
    expect(caught.cta?.description).toContain('Shopify release-default URL')
    expect(caught.cta?.description).toContain('complete corrected document at a URL you control')
    expect(caught.cta?.description).toContain('--profile-url or UCP_AGENT_PROFILE_URL')
    expect(JSON.stringify(caught.cta)).not.toMatch(/profile init|--force|profile use/)
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
          source: 'managed',
          urlOverride: false,
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

describe('createManagedProfile', () => {
  it('matches every installed release with exact key/body/url/release invariants', () => {
    const managed = createManagedProfile()
    const another = createManagedProfile()

    expect(managed.source).toBe('managed')
    expect(managed).not.toHaveProperty('kind')
    expect(managed.urlOverride).toBe(false)
    expect(managed.name).toBeUndefined()
    expect(Object.keys(managed.renderings)).toEqual(SUPPORTED_VERSIONS)
    for (const version of SUPPORTED_VERSIONS) {
      const installed = rendering(managed, version)
      expect(installed.version).toBe(version)
      expect(installed.source).toBe('managed')
      expect(installed.urlOverride).toBe(false)
      expect(installed.name).toBeUndefined()
      expect(installed.body.ucp.version).toBe(version)
      expect(installed.url).toBe(RELEASES[version].defaultAgentProfileUrl)
      expect(installed.release).toBe(RELEASES[version])
      expect(installed.body).not.toBe(RELEASES[version].agentProfileTemplate)
      expect(installed.body).not.toBe(rendering(another, version).body)
    }
  })

  // The name is the local profile directory an upgraded legacy profile came
  // from: it selects headers.json and addresses this identity in messages.
  // It must reach every rendering (that is what error text reads) without
  // changing any URL — managed renderings are always the published documents.
  it('carries an optional local profile name onto the Profile and every rendering', () => {
    const named = createManagedProfile('legacy')

    expect(named.source).toBe('managed')
    expect(named.urlOverride).toBe(false)
    expect(named.name).toBe('legacy')
    expect(Object.keys(named.renderings)).toEqual(SUPPORTED_VERSIONS)
    for (const version of SUPPORTED_VERSIONS) {
      expect(rendering(named, version).source).toBe('managed')
      expect(rendering(named, version).urlOverride).toBe(false)
      expect(rendering(named, version).name).toBe('legacy')
      expect(rendering(named, version).url).toBe(RELEASES[version].defaultAgentProfileUrl)
    }
  })
})

describe('runtime Profile provenance', () => {
  it('tracks body source and explicit URL override independently', () => {
    const body = publishedBody()
    const diy = createDiyProfile({ name: 'mine', body, url: SELF_HOSTED })
    const overriddenDiy = createDiyProfile({
      name: 'mine',
      body,
      url: SELF_HOSTED,
      urlOverride: true,
    })
    const adhoc = createAdHocProfile(DEFAULT_0825, 'mine')

    expect(diy).toMatchObject({
      source: 'diy',
      urlOverride: false,
      name: 'mine',
    })
    expect(rendering(diy, LATEST)).toMatchObject({ source: 'diy', urlOverride: false })
    expect(overriddenDiy).toMatchObject({
      source: 'diy',
      urlOverride: true,
      name: 'mine',
    })
    expect(rendering(overriddenDiy, LATEST)).toMatchObject({
      source: 'diy',
      urlOverride: true,
      body: rendering(diy, LATEST).body,
    })
    expect(adhoc).toMatchObject({
      source: 'url',
      urlOverride: true,
      name: 'mine',
    })
    expect(rendering(adhoc, LATEST)).toMatchObject({ source: 'url', urlOverride: true })
  })

  it('warns on every unknown URL-only or managed-alias override and uses the bundled LATEST body', () => {
    const warnings = captureWarnings()

    const nameless = createAdHocProfile(SELF_HOSTED)
    const named = createAdHocProfile(SELF_HOSTED, 'legacy')

    expect(warnings).toHaveLength(2)
    for (const warning of warnings) {
      expect(warning).toContain(SELF_HOSTED)
      expect(warning).toContain(`bundled UCP ${LATEST} body`)
      expect(warning).toMatch(/planning and negotiation/i)
      expect(warning).toContain('ucp doctor')
    }
    expect(rendering(nameless, LATEST).body).toMatchObject(
      JSON.parse(RELEASES[LATEST].agentProfileJson),
    )
    expect(rendering(named, LATEST)).toMatchObject({ name: 'legacy', url: SELF_HOSTED })
  })

  it('does not warn when a scalar override is a known release-default URL', () => {
    const warnings = captureWarnings()

    for (const rel of Object.values(RELEASES)) {
      const profile = createAdHocProfile(rel.defaultAgentProfileUrl)
      expect(Object.keys(profile.renderings)).toEqual([rel.version])
      expect(rendering(profile, rel.version).url).toBe(rel.defaultAgentProfileUrl)
    }
    expect(warnings).toEqual([])
  })

  it('does not emit the bundled-body substitution warning for a named DIY URL override', () => {
    const warnings = captureWarnings()
    const body = publishedBody()

    const profile = createDiyProfile({
      name: 'mine',
      body,
      url: SELF_HOSTED,
      urlOverride: true,
    })

    expect(warnings).toEqual([])
    expect(rendering(profile, LATEST).body).toMatchObject(body)
    expect(rendering(profile, LATEST).url).toBe(SELF_HOSTED)
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
    expect(live.agent.source).toBe('url')
    expect(live.cacheControl).toBe('public, max-age=300')
  })

  it('rejects raw hosted ucp-cli 0.4.2–0.7.0 Profile instead of applying local DIY compatibility', async () => {
    const fetch = fetchStub(
      () => new Response(JSON.stringify(profile042To070Body()), { status: 200 }),
    )

    await expect(fetchAgentProfileLive({ url: SELF_HOSTED, fetch })).rejects.toMatchObject({
      code: ErrorCodes.AGENT_PROFILE_VERSION_MISMATCH,
      context: {
        url: SELF_HOSTED,
        registry: 'services',
        key: 'dev.ucp.shopping',
        versions: ['2026-01-23'],
      },
    })
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
