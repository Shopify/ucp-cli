// runDoctor() — local install health check.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUcpCli } from '../cli.js'
import { PROFILE_FORMAT_VERSION } from '../core/legacy-profile.js'
import type { PlatformProfile } from '../core/profile.js'
import { readActive, saveUserProfile, writeActive } from '../core/profile-store.js'
import { installProxyDispatcher, resetProxyStateForTests } from '../core/proxy.js'
import { LATEST, RELEASES, SUPPORTED_VERSIONS, type Version } from '../core/releases.js'
import { setWarnWriter } from '../core/verbose.js'
import { clearProxyEnv, serveCli } from '../test-utils.js'
import { runDoctor } from './doctor.js'

const SELF_HOSTED_URL = 'https://mybot.example.com/profile.json'

afterEach(() => {
  setWarnWriter(null)
})

/** Every URL a managed Profile publishes a rendering at, in release order. */
const RELEASE_URLS = SUPPORTED_VERSIONS.map((v) => RELEASES[v].defaultAgentProfileUrl)

/** A spec-conformant hosting policy, so cache-control never colours a test that isn't about it. */
const CACHEABLE = 'public, max-age=300'

/** A release's verbatim published agent profile — what the hosted URL serves. */
function publishedProfile(version: Version): unknown {
  return JSON.parse(RELEASES[version].agentProfileJson)
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** How one URL answers. Absent fields fall back to "serves its own published document, cacheable". */
interface Route {
  body?: unknown
  status?: number
  headers?: Record<string, string>
  throws?: Error
}

/**
 * A fetch that knows the published renderings: each release-default URL
 * answers with that release's own document under a conformant cache policy.
 * `routes` replaces the answer for one URL — the shape every managed-defect
 * test needs, because the point is always "one rendering is broken, the
 * others are not".
 */
function releaseFetch(routes: Record<string, Route> = {}) {
  const calls: Array<{ url: string; method: string | undefined }> = []
  const impl = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, method: init.method })
    const route = routes[url]
    if (route?.throws !== undefined) throw route.throws
    const status = route?.status ?? 200
    if (status >= 300) return new Response(null, { status, headers: route?.headers ?? {} })
    const version = SUPPORTED_VERSIONS.find((v) => RELEASES[v].defaultAgentProfileUrl === url)
    const body =
      route?.body ?? (version === undefined ? publishedProfile(LATEST) : publishedProfile(version))
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': CACHEABLE,
        ...(route?.headers ?? {}),
      },
    })
  })
  return { fetch: impl as unknown as typeof fetch, calls }
}

const SAMPLE_BODY: PlatformProfile = {
  ucp: { version: '2026-08-25', status: 'success', services: {}, payment_handlers: {} },
  keys: [],
}

const SAMPLE_META = {
  created_at: '2026-05-05T12:00:00Z',
  profile_url: 'https://mybot.example.com/profile.json',
}

/**
 * A DIY body that PASSES its release schema but violates the snapshot rule:
 * a `dev.ucp.*` entry at a version other than the document's own
 * `ucp.version` (the historical 0.4.2 … 0.7.0 defect). It is the local
 * failure whose authoritative remedy is NON-DESTRUCTIVE — edit the entry —
 * which is exactly what a re-derived `profile init --force` remedy destroys.
 */
const OFF_VERSION_BODY: PlatformProfile = {
  ucp: {
    version: LATEST,
    status: 'success',
    services: {
      'dev.ucp.shopping': [
        {
          version: '2026-01-23',
          spec: 'https://ucp.dev/2026-01-23/specification/overview',
          transport: 'mcp',
          schema: 'https://ucp.dev/2026-01-23/services/shopping/mcp.openrpc.json',
        },
      ],
    },
    payment_handlers: {},
  },
  keys: [],
}

/** Marked DIY, so classification cannot rescue the body the operator authored. */
const DIY_META = {
  created_at: '2026-05-05T12:00:00Z',
  format_version: PROFILE_FORMAT_VERSION,
  kind: 'diy' as const,
  profile_url: SELF_HOSTED_URL,
}

function findCheck(
  result: { checks: { id: string; status: string; detail: string }[] },
  id: string,
) {
  const check = result.checks.find((c) => c.id === id)
  if (check === undefined) throw new Error(`no check with id "${id}" in ${JSON.stringify(result)}`)
  return check
}

/** How many Checks carry this id. One-check-per-id is a contract, not an accident. */
function countChecks(result: { checks: { id: string }[] }, id: string): number {
  return result.checks.filter((c) => c.id === id).length
}

describe('runDoctor — clean install', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  // A fresh install transacts on the Shopify-managed Profile: no local files
  // or initialization are required. `profile init` is a separate opt-in that
  // creates a release-pinned DIY Profile; it does not configure managed use.
  it('is healthy on a fresh home, on the Shopify-managed Profile', async () => {
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(true)
    expect(findCheck(result, 'ucp-home').status).toBe('ok')
    expect(findCheck(result, 'profiles-dir').status).toBe('ok')
    expect(findCheck(result, 'cache-dir').status).toBe('ok')
    expect(findCheck(result, 'active-yaml').status).toBe('ok')
    const active = findCheck(result, 'active-profile')
    expect(active.status).toBe('ok')
    expect(active.detail).toContain('Shopify-managed Profile')
    // Which releases this install offers — the thing a managed Profile is.
    for (const version of SUPPORTED_VERSIONS) {
      expect(active.detail).toContain(`UCP ${version}: ${RELEASES[version].defaultAgentProfileUrl}`)
    }
    expect(active.detail).toMatch(/no .*init.*required/i)
    expect(active.detail).toMatch(/profile init.*release-pinned DIY Profile/i)
    expect(active.detail).not.toMatch(/adds a local name|adds .*headers\.json/i)
  })

  it('issues no request at all under --skip-network', async () => {
    const { fetch: fetchImpl, calls } = releaseFetch()
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {}, fetch: fetchImpl })
    expect(calls).toHaveLength(0)
    for (const id of ['protocol', 'profile-drift', 'profile-cache-control', 'profile-redirect']) {
      expect(result.checks.find((c) => c.id === id)).toBeUndefined()
    }
  })
})

describe('runDoctor — active.yaml states', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('keeps doctor healthy after profile use --managed persists an empty session', async () => {
    await writeActive({ profile: 'custom' }, { homeDir })
    const switched = await serveCli(
      createUcpCli({
        profile: {
          env: {},
          readActive: () => readActive({ homeDir }),
          writeActive: (session) => writeActive(session, { homeDir }),
        },
      }),
      ['profile', 'use', '--managed'],
    )
    expect(switched.exitCode).toBe(0)
    expect(await readActive({ homeDir })).toEqual({})

    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })

    expect(result.ok).toBe(true)
    expect(findCheck(result, 'active-yaml')).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('no stored selection'),
    })
    expect(findCheck(result, 'active-profile').detail).toContain('Shopify-managed Profile')
  })

  it('reports active.yaml content when present and parseable', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod', business: 'https://shop.example.com' }, { homeDir })
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    const active = findCheck(result, 'active-yaml')
    expect(active.status).toBe('ok')
    expect(active.detail).toContain('"business":"https://shop.example.com"')
  })

  // A corrupt active.yaml names nobody, so this is NOT the never-fall-back
  // case: readActive degrades to `{}` and the session is the managed default.
  // The warn is how the user learns the file was ignored.
  it('warns on corrupt active.yaml and stays on the managed Profile', async () => {
    await writeFile(join(homeDir, 'active.yaml'), '!!! not yaml [[[ broken', 'utf-8')
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(true)
    expect(findCheck(result, 'active-yaml').status).toBe('warn')
    expect(findCheck(result, 'active-profile').status).toBe('ok')
    expect(findCheck(result, 'active-profile').detail).toContain('Shopify-managed Profile')
  })
})

// ─── which Profile resolved ──────────────────────────────────────────────
//
// Doctor reports the Profile `resolveSession` builds — the same one commerce
// runs on — so the kinds it can report are the kinds that exist: managed
// (bundled renderings, named or not), authored DIY (one local document, with
// either a stored or overridden URL), and a URL-only ad-hoc singleton.
describe('runDoctor — resolved Profile', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('reports a named DIY profile as locally authored, and names its document', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(true)
    const active = findCheck(result, 'active-profile')
    expect(active.status).toBe('ok')
    expect(active.detail).toContain('locally authored (DIY)')
    expect(active.detail).toContain(join(homeDir, 'profiles', 'prod', 'profile.json'))
    expect(active.detail).toContain(SELF_HOSTED_URL)
  })

  // The one case that must never degrade: an explicitly selected identity
  // that cannot be loaded. Falling back to the managed Profile would sell
  // under a different identity than the operator asked for.
  it('fails on a named profile that is not on disk, and probes nothing', async () => {
    await saveUserProfile({ name: 'backup', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'ghost' }, { homeDir })
    const { fetch: fetchImpl, calls } = releaseFetch()
    const result = await runDoctor({ homeDir, env: {}, fetch: fetchImpl })
    expect(result.ok).toBe(false)
    const active = findCheck(result, 'active-profile')
    expect(active.status).toBe('fail')
    expect(active.detail).toContain('PROFILE_NOT_FOUND')
    expect(active.detail).toContain('ghost')
    expect(active.detail).toContain('active.yaml')
    expect(active.detail).toContain('ucp profile init --name ghost --force')
    expect(active.detail).toContain('ucp profile use backup')
    expect(active.detail).toContain('ucp profile use --managed')
    expect(active.detail).not.toContain('<name>')
    expect(active.detail).toMatch(/never silently replaced/)
    // No identity resolved, so there is nothing to fetch and no second voice.
    expect(calls).toHaveLength(0)
    for (const id of ['protocol', 'profile-drift', 'profile-cache-control', 'profile-redirect']) {
      expect(result.checks.find((c) => c.id === id)).toBeUndefined()
    }
  })

  it('keeps alternative-Profile classification read-only while reporting a failed selection', async () => {
    await saveUserProfile(
      {
        name: 'legacy',
        body: publishedProfile(LATEST) as PlatformProfile,
        meta: {},
      },
      { homeDir },
    )
    const metaPath = join(homeDir, 'profiles', 'legacy', 'meta.json')
    const before = await readFile(metaPath, 'utf-8')
    await writeActive({ profile: 'ghost' }, { homeDir })

    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })

    expect(findCheck(result, 'active-profile').detail).toContain('ucp profile use legacy')
    expect(await readFile(metaPath, 'utf-8')).toBe(before)
    expect(JSON.parse(before)).toEqual({})
  })

  // The store authored this remedy where the failure is understood — it knows
  // which file it could not read, and therefore whether a custom profile_url
  // survives a re-init. Doctor reports that block verbatim, named profile and
  // all; it does not re-derive one from the error's shape.
  it('fails on a named profile whose profile.json is corrupt', async () => {
    const dir = join(homeDir, 'profiles', 'broken')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'profile.json'), '{ not json', 'utf-8')
    await writeFile(join(dir, 'meta.json'), '{}', 'utf-8')
    await writeActive({ profile: 'broken' }, { homeDir })
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(false)
    const active = findCheck(result, 'active-profile')
    expect(active.status).toBe('fail')
    expect(active.detail).toContain('broken')
    // The exact-name force command, and the file-aware URL promise that only
    // a readable meta.json can make.
    expect(active.detail).toContain('ucp profile init --name broken --force')
    expect(active.detail).toMatch(
      /custom profile_url in the readable, valid meta\.json is preserved/i,
    )
    expect(active.detail).not.toMatch(/cannot preserve a custom profile_url/i)
    expect(active.detail).not.toContain('<name>')
  })

  it('does not promise URL preservation when the selected meta.json is invalid', async () => {
    const dir = join(homeDir, 'profiles', 'broken-meta')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'profile.json'), JSON.stringify(SAMPLE_BODY), 'utf-8')
    await writeFile(join(dir, 'meta.json'), '{ not json', 'utf-8')
    await writeActive({ profile: 'broken-meta' }, { homeDir })

    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    const active = findCheck(result, 'active-profile')

    expect(active.status).toBe('fail')
    expect(active.detail).toContain('ucp profile init --name broken-meta --force')
    expect(active.detail).toMatch(/meta\.json could not be read and validated/i)
    expect(active.detail).toMatch(/cannot preserve a custom profile_url/i)
    expect(active.detail).toMatch(/--profile-url with the HTTPS URL you need to retain/i)
    expect(active.detail).not.toMatch(/custom profile_url.*is preserved/i)
  })

  // The regression this pass exists for. A schema-valid DIY body with an
  // off-version `dev.ucp.*` entry fails with AGENT_PROFILE_VERSION_MISMATCH,
  // whose cta says to ALIGN the entries — the local document stays the
  // operator's. Reconstructing a remedy from the error's shape replaced that
  // with `profile init --force`, which REWRITES the authored document, so the
  // absence of `--force` here is the assertion that matters.
  it('reports the carried alignment remedy for an off-version dev.ucp.* entry', async () => {
    await saveUserProfile({ name: 'authored', body: OFF_VERSION_BODY, meta: DIY_META }, { homeDir })
    await writeActive({ profile: 'authored' }, { homeDir })

    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    const active = findCheck(result, 'active-profile')

    expect(result.ok).toBe(false)
    expect(active.status).toBe('fail')
    expect(active.detail).toContain('AGENT_PROFILE_VERSION_MISMATCH')
    // The authoritative, non-destructive remedy, plus its inspection command.
    expect(active.detail).toMatch(/align every dev\.ucp\.\* entry/i)
    expect(active.detail).toContain('ucp profile show')
    expect(active.detail).not.toContain('--force')
    expect(active.detail).not.toContain('profile init')
    // Doctor never sends the reader back into Doctor: the cta's `ucp doctor`
    // command is dropped, the useful one is kept.
    expect(active.detail).not.toContain('ucp doctor')
    // Source + precedence guidance is Doctor's own and still reported.
    expect(active.detail).toMatch(/active\.yaml selects local Profile "authored"/)
    expect(active.detail).toMatch(/never silently replaced/)
    expect(active.detail).toContain('ucp profile use --managed')
  })

  it('keeps UCP_PROFILE precedence guidance around a carried alignment remedy', async () => {
    await saveUserProfile({ name: 'authored', body: OFF_VERSION_BODY, meta: DIY_META }, { homeDir })

    const result = await runDoctor({
      homeDir,
      skipNetwork: true,
      env: { UCP_PROFILE: 'authored' },
    })
    const active = findCheck(result, 'active-profile')

    expect(active.status).toBe('fail')
    expect(active.detail).toMatch(/align every dev\.ucp\.\* entry/i)
    expect(active.detail).not.toContain('--force')
    expect(active.detail).toContain('unset UCP_PROFILE')
    expect(active.detail).toMatch(/profile use.*cannot override UCP_PROFILE/i)
    // active.yaml's remedies are not offered against an env selection.
    expect(active.detail).not.toContain('ucp profile use --managed')
  })

  it('a failing UCP_PROFILE selection names the env source and cannot be overridden by profile use', async () => {
    await writeActive({ profile: 'from-active' }, { homeDir })
    const result = await runDoctor({
      homeDir,
      skipNetwork: true,
      env: { UCP_PROFILE: 'from-env' },
    })

    expect(result.ok).toBe(false)
    const active = findCheck(result, 'active-profile')
    expect(active.status).toBe('fail')
    expect(active.detail).toContain('UCP_PROFILE')
    expect(active.detail).toContain('from-env')
    expect(active.detail).not.toContain('from-active')
    expect(active.detail).toContain('ucp profile init --name from-env --force')
    expect(active.detail).toContain('unset UCP_PROFILE')
    expect(active.detail).toMatch(/profile use.*cannot override UCP_PROFILE/i)
    expect(active.detail).not.toContain('<name>')
    expect(active.detail).not.toContain('ucp profile use --managed')
  })

  it('an invalid UCP_AGENT_PROFILE_URL reports how to remove or fix that override', async () => {
    const result = await runDoctor({
      homeDir,
      skipNetwork: true,
      env: { UCP_AGENT_PROFILE_URL: 'http://agent.example.com/profile.json' },
    })

    expect(result.ok).toBe(false)
    const active = findCheck(result, 'active-profile')
    expect(active.status).toBe('fail')
    expect(active.detail).toContain('UCP_AGENT_PROFILE_URL')
    expect(active.detail).toContain('http://agent.example.com/profile.json')
    expect(active.detail).toContain('unset UCP_AGENT_PROFILE_URL')
    expect(active.detail).toMatch(/fix|valid HTTPS/i)
    expect(active.detail).not.toContain('<name>')
  })

  it('UCP_PROFILE env wins over active.yaml when deciding which Profile to report', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'ghost' }, { homeDir })
    const result = await runDoctor({
      homeDir,
      skipNetwork: true,
      env: { UCP_PROFILE: 'prod' },
    })
    expect(result.ok).toBe(true)
    expect(findCheck(result, 'active-profile').status).toBe('ok')
    expect(findCheck(result, 'active-profile').detail).toContain('prod')
  })

  it('reports UCP_AGENT_PROFILE_URL as a one-rendering ad-hoc identity', async () => {
    const warnings: string[] = []
    setWarnWriter((message) => warnings.push(message))
    const result = await runDoctor({
      homeDir,
      skipNetwork: true,
      env: { UCP_AGENT_PROFILE_URL: SELF_HOSTED_URL },
    })
    const active = findCheck(result, 'active-profile')
    expect(active.status).toBe('ok')
    expect(active.detail).toContain('UCP_AGENT_PROFILE_URL')
    expect(active.detail).toContain(SELF_HOSTED_URL)
    expect(active.detail).toContain(`UCP ${LATEST}`)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`bundled UCP ${LATEST} body`)
  })
})

// ─── the managed Profile's renderings ────────────────────────────────────
//
// A managed Profile publishes one rendering per installed release and the
// Business selects one of them at negotiation — any of them. So every
// installed rendering URL is audited, and the four hosted ids stay four
// Checks: worst severity wins, and the lines are labelled by release.
describe('runDoctor — managed renderings', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-managed-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const FIXTURE_DIR = fileURLToPath(
    new URL('../../test/fixtures/legacy-profiles/', import.meta.url),
  )

  /** A profile directory exactly as 0.4.2 … 0.8.0 wrote it: stock body, no marker, no URL. */
  async function seedLegacy(name: string, fixture: string): Promise<string> {
    const dir = join(homeDir, 'profiles', name)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(
      join(dir, 'profile.json'),
      await readFile(join(FIXTURE_DIR, fixture), 'utf-8'),
      'utf-8',
    )
    await writeFile(
      join(dir, 'meta.json'),
      `${JSON.stringify({ created_at: '2026-06-01T10:00:00.000Z' }, null, 2)}\n`,
      'utf-8',
    )
    return dir
  }

  it('probes every rendering URL exactly once and reports one Check per id', async () => {
    const { fetch: fetchImpl, calls } = releaseFetch()
    const result = await runDoctor({ homeDir, env: {}, fetch: fetchImpl })

    expect(calls.map((c) => c.url).sort()).toEqual([...RELEASE_URLS].sort())
    // One GET each — never a second probe of the same URL, and never a HEAD.
    expect(calls).toHaveLength(RELEASE_URLS.length)
    for (const call of calls) expect(call.method).not.toBe('HEAD')

    for (const id of ['protocol', 'profile-redirect', 'profile-cache-control', 'profile-drift']) {
      expect(countChecks(result, id)).toBe(1)
      expect(findCheck(result, id).status).toBe('ok')
    }
    // Version-labelled, so a reader can tell which rendering each line is about.
    const protocol = findCheck(result, 'protocol')
    for (const version of SUPPORTED_VERSIONS) expect(protocol.detail).toContain(`UCP ${version}:`)
    for (const url of RELEASE_URLS) expect(protocol.detail).toContain(url)
    expect(result.ok).toBe(true)
  })

  it('starts distinct probes before either response is released and preserves release order', async () => {
    const distinctUrls = [...new Set(RELEASE_URLS)]
    expect(distinctUrls.length).toBeGreaterThanOrEqual(2)

    const startedUrls: string[] = []
    const responses = new Map<string, Promise<Response>>()
    const releaseResponse = new Map<string, (response: Response) => void>()
    for (const url of distinctUrls) {
      let release!: (response: Response) => void
      responses.set(
        url,
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      )
      releaseResponse.set(url, release)
    }

    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const startedFetch = vi.fn((input: unknown) => {
      const url = String(input)
      startedUrls.push(url)
      markFirstStarted()
      const response = responses.get(url)
      if (response === undefined) throw new Error(`unexpected rendering URL: ${url}`)
      return response
    })
    const doctor = runDoctor({
      homeDir,
      env: {},
      fetch: startedFetch as unknown as typeof fetch,
    })

    await firstStarted
    await new Promise<void>((resolve) => setImmediate(resolve))
    const startedBeforeRelease = [...startedUrls]

    // Settle in reverse to ensure completion timing cannot reorder output.
    for (const version of [...SUPPORTED_VERSIONS].reverse()) {
      const url = RELEASES[version].defaultAgentProfileUrl
      const release = releaseResponse.get(url)
      if (release === undefined) throw new Error(`no deferred response for: ${url}`)
      release(
        new Response(RELEASES[version].agentProfileJson, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': CACHEABLE,
          },
        }),
      )
    }

    const result = await doctor
    expect(startedBeforeRelease).toEqual(distinctUrls)
    expect(startedUrls).toEqual(distinctUrls)
    for (const id of ['protocol', 'profile-redirect', 'profile-cache-control', 'profile-drift']) {
      expect(findCheck(result, id).detail.split('\n')).toEqual(
        SUPPORTED_VERSIONS.map((version) => expect.stringContaining(`UCP ${version}:`)),
      )
    }
  })

  it('aggregates one failed protocol check when a single rendering URL 404s', async () => {
    const broken = RELEASES['2026-04-08'].defaultAgentProfileUrl
    const { fetch: fetchImpl } = releaseFetch({ [broken]: { status: 404 } })
    const result = await runDoctor({ homeDir, env: {}, fetch: fetchImpl })

    expect(countChecks(result, 'protocol')).toBe(1)
    const protocol = findCheck(result, 'protocol')
    expect(protocol.status).toBe('fail')
    expect(protocol.detail).toContain('UCP 2026-04-08:')
    expect(protocol.detail).toContain('AGENT_PROFILE_UNREACHABLE')
    expect(protocol.detail).toContain('http_status: HTTP 404')
    // The healthy rendering still reports, in the same Check.
    expect(protocol.detail).toContain(`UCP ${LATEST}:`)
    expect(protocol.detail).toContain(RELEASES[LATEST].defaultAgentProfileUrl)
    expect(result.ok).toBe(false)
  })

  // One fault, one voice. The redirecting rendering is represented by
  // `profile-redirect` and nowhere else — no second, vaguer `protocol` fail
  // on the same GET.
  it('reports a redirecting rendering as profile-redirect only', async () => {
    const hopping = RELEASES['2026-04-08'].defaultAgentProfileUrl
    const { fetch: fetchImpl } = releaseFetch({
      [hopping]: { status: 301, headers: { location: 'https://cdn.example.com/profile.json' } },
    })
    const result = await runDoctor({ homeDir, env: {}, fetch: fetchImpl })

    expect(countChecks(result, 'profile-redirect')).toBe(1)
    const redirect = findCheck(result, 'profile-redirect')
    expect(redirect.status).toBe('fail')
    expect(redirect.detail).toContain('HTTP 301')
    expect(redirect.detail).toContain('https://cdn.example.com/profile.json')
    expect(redirect.detail).toContain('UCP forbids redirects (3xx) on published profiles')
    // A managed rendering is not the reader's to serve, so the remedy is not
    // "point meta.profile_url" and never "upload profile.json".
    expect(redirect.detail).toContain('upgrade ucp-cli')
    expect(redirect.detail).not.toContain('meta.profile_url')
    expect(redirect.detail).not.toMatch(/upload/i)

    // `protocol` stays with the rendering it could actually judge.
    expect(countChecks(result, 'protocol')).toBe(1)
    const protocol = findCheck(result, 'protocol')
    expect(protocol.status).toBe('ok')
    expect(protocol.detail).not.toContain(hopping)
    expect(result.ok).toBe(false)
  })

  it('fails protocol when one rendering URL serves another release', async () => {
    const drifted = RELEASES[LATEST].defaultAgentProfileUrl
    const { fetch: fetchImpl } = releaseFetch({
      [drifted]: { body: publishedProfile('2026-04-08') },
    })
    const result = await runDoctor({ homeDir, env: {}, fetch: fetchImpl })

    expect(countChecks(result, 'protocol')).toBe(1)
    const protocol = findCheck(result, 'protocol')
    expect(protocol.status).toBe('fail')
    expect(protocol.detail).toContain(`UCP ${LATEST}: ${drifted} serves UCP 2026-04-08`)
    // Managed remedies: refresh the install / report the hosted change. Never
    // "upload profile.json" — the local file (if any) is not what we declare.
    expect(protocol.detail).toContain('upgrade ucp-cli')
    expect(protocol.detail).not.toMatch(/upload/i)
    expect(protocol.detail).not.toContain('profile.json')
    // One voice per fault: drift stays quiet for the rendering protocol ruled
    // on, and reports the healthy one.
    expect(findCheck(result, 'profile-drift').status).toBe('ok')
    expect(findCheck(result, 'profile-drift').detail).toContain('UCP 2026-04-08:')
    expect(result.ok).toBe(false)
  })

  it('warns profile-drift when one rendering URL serves a modified body', async () => {
    const url = RELEASES[LATEST].defaultAgentProfileUrl
    const modified = publishedProfile(LATEST) as { ucp: { capabilities: Record<string, unknown> } }
    delete modified.ucp.capabilities['dev.shopify.catalog.global']
    const { fetch: fetchImpl } = releaseFetch({ [url]: { body: modified } })
    const result = await runDoctor({ homeDir, env: {}, fetch: fetchImpl })

    expect(countChecks(result, 'profile-drift')).toBe(1)
    const drift = findCheck(result, 'profile-drift')
    expect(drift.status).toBe('warn')
    expect(drift.detail).toContain(`UCP ${LATEST}: ${url} serves a document that differs`)
    expect(drift.detail).toContain('bundled')
    expect(drift.detail).not.toMatch(/upload/i)
    // The other rendering is still reported as matching, in the same Check.
    expect(drift.detail).toContain('UCP 2026-04-08:')
    expect(findCheck(result, 'protocol').status).toBe('ok')
    // Only `fail` gates the verdict.
    expect(result.ok).toBe(true)
  })

  it('warns profile-cache-control when one rendering URL is uncacheable', async () => {
    const url = RELEASES['2026-04-08'].defaultAgentProfileUrl
    const { fetch: fetchImpl } = releaseFetch({
      [url]: { headers: { 'cache-control': 'no-store' } },
    })
    const result = await runDoctor({ homeDir, env: {}, fetch: fetchImpl })

    const cache = findCheck(result, 'profile-cache-control')
    expect(countChecks(result, 'profile-cache-control')).toBe(1)
    expect(cache.status).toBe('warn')
    expect(cache.detail).toContain(`UCP 2026-04-08: ${url} serves \`Cache-Control: no-store\``)
    expect(cache.detail).toContain(`UCP ${LATEST}: ${RELEASES[LATEST].defaultAgentProfileUrl}`)
    expect(result.ok).toBe(true)
  })

  // The upgraded-legacy population. `profiles/<name>/profile.json` is a stock
  // 0.7.0 body that ucp-cli no longer declares — the renderings are the
  // BUNDLED documents at their published URLs, and that is what doctor must
  // fetch and compare. A drift warn here would be doctor reporting a
  // difference against a file nothing sends.
  it('audits a named managed profile against the bundled renderings, not its legacy profile.json', async () => {
    const dir = await seedLegacy('legacy07', 'profile-0.4.2-to-0.7.0.json')
    await writeActive({ profile: 'legacy07' }, { homeDir })
    const before = await readFile(join(dir, 'profile.json'), 'utf-8')
    const { fetch: fetchImpl, calls } = releaseFetch()

    const result = await runDoctor({ homeDir, env: {}, fetch: fetchImpl })

    const active = findCheck(result, 'active-profile')
    expect(active.status).toBe('ok')
    expect(active.detail).toContain('profile "legacy07" is a Shopify-managed Profile')
    expect(calls.map((c) => c.url).sort()).toEqual([...RELEASE_URLS].sort())
    for (const id of ['protocol', 'profile-redirect', 'profile-cache-control', 'profile-drift']) {
      expect(countChecks(result, id)).toBe(1)
      expect(findCheck(result, id).status).toBe('ok')
    }
    expect(result.ok).toBe(true)
    // The stale body stays exactly as found — doctor reads, it does not repair.
    expect(await readFile(join(dir, 'profile.json'), 'utf-8')).toBe(before)
  })
})

// ─── the hosted-identity fetch, DIY ──────────────────────────────────────
//
// ONE network request per rendering, and a DIY Profile has exactly one. Never
// add a second probe of the same URL — a `warn`-only HEAD adds no information
// the GET does not have and produces contradictory pairs (a host that 405s
// HEAD but serves GET reports `profile-url: warn` beside `protocol: ok`).
// Because `protocol` is the only voice on this URL, its failure detail has to
// separate transport failure from HTTP status from parse/validate failure:
// the remedies differ.
describe('runDoctor — hosted-identity fetch', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('issues exactly one GET of the profile URL and no HEAD probe', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const methods: (string | undefined)[] = []
    const fakeFetch = vi.fn(async (_url: unknown, init: RequestInit = {}) => {
      methods.push(init.method)
      return jsonResponse(publishedProfile(LATEST))
    })
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    expect(result.checks.find((c) => c.id === 'profile-url')).toBeUndefined()
    expect(methods).toHaveLength(1)
    expect(methods[0]).not.toBe('HEAD')
    expect(fakeFetch.mock.calls[0]?.[0]).toBe(SELF_HOSTED_URL)
    expect(findCheck(result, 'protocol').status).toBe('ok')
  })

  // A business dereferences this URL to negotiate with us (and may cache what
  // it gets). A doctor reporting `ok: true` on a URL that cannot be read
  // would be calling an install healthy while the identity it advertises is
  // unreadable to the only party that reads it.
  it('fails and names the HTTP status when the profile URL 404s', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const fakeFetch = vi.fn(async () => new Response(null, { status: 404 }))
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const check = findCheck(result, 'protocol')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('AGENT_PROFILE_UNREACHABLE')
    expect(check.detail).toContain('http_status: HTTP 404')
    expect(check.detail).toContain(SELF_HOSTED_URL)
    expect(result.ok).toBe(false)
  })

  it('fails and names a transport failure when fetch throws', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const fakeFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const check = findCheck(result, 'protocol')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('network: ECONNREFUSED')
    expect(result.ok).toBe(false)
  })

  // The most common hosting failure: a 200 serving an HTML error page.
  // Not "unreachable", and not a schema problem either.
  it('fails and names a parse failure when the URL serves non-JSON', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const fakeFetch = vi.fn(
      async () =>
        new Response('<html><body>404 not found</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const check = findCheck(result, 'protocol')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('not_json')
    expect(result.ok).toBe(false)
  })

  it('fails and names schema validation when the document is not a UCP profile', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const fakeFetch = vi.fn(async () => jsonResponse({ hello: 'world' }))
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const check = findCheck(result, 'protocol')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('AGENT_PROFILE_SCHEMA_INVALID')
    expect(check.detail).toContain('ucp.version')
    expect(result.ok).toBe(false)
  })

  it('falls back to the body release published default when no profile_url is configured', async () => {
    // "No profile_url" is not "no identity": a DIY singleton is advertised at
    // its own release's PUBLISHED agent profile, so `protocol` reports that URL.
    await saveUserProfile(
      { name: 'deferred', body: SAMPLE_BODY, meta: { created_at: SAMPLE_META.created_at } },
      { homeDir },
    )
    await writeActive({ profile: 'deferred' }, { homeDir })
    const fakeFetch = vi.fn(async () => jsonResponse(publishedProfile('2026-08-25')))
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    expect(findCheck(result, 'protocol').status).toBe('ok')
    expect(findCheck(result, 'protocol').detail).toContain(RELEASES[LATEST].defaultAgentProfileUrl)
  })

  // Hosting rule 2 beside the cache-control rule 3, off the same single GET.
  // Doctor is the only place ucp-cli fetches this URL, and it refuses the hop
  // itself; commerce requests only advertise the URL, and a conforming
  // business dereferencing it is bound by the same MUST NOT, so they cannot
  // negotiate. Local commands are unaffected — so the detail must not claim
  // "every command fails".
  it('fails, names the Location, and cites the rule when the profile URL redirects', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const fakeFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: { location: 'https://cdn.example.com/profile.json' },
        }),
    )
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    // One fault, one voice: exactly one `profile-redirect` check, and no
    // second, vaguer `protocol` fail on the same GET. With a singleton
    // Profile nothing else had anything to say, so `protocol` is absent
    // rather than green.
    expect(countChecks(result, 'profile-redirect')).toBe(1)
    expect(result.checks.find((c) => c.id === 'protocol')).toBeUndefined()
    const check = findCheck(result, 'profile-redirect')
    expect(check.status).toBe('fail')
    expect(result.ok).toBe(false)
    expect(check.detail).toContain(SELF_HOSTED_URL)
    expect(check.detail).toContain('HTTP 301')
    expect(check.detail).toContain('https://cdn.example.com/profile.json')
    expect(check.detail).toContain('UCP forbids redirects (3xx) on published profiles')
    expect(check.detail).toContain('meta.json')
    // The actor chain, not a blanket claim about the CLI's whole surface:
    // doctor refused the hop, commerce requests only advertise the URL, and
    // the business that dereferences it is the one that cannot negotiate.
    expect(check.detail).toMatch(/Doctor[^.]*refused the hop/)
    expect(check.detail).toMatch(/commerce requests only advertise/)
    expect(check.detail).toContain('cannot negotiate')
    // Scope, stated in the output rather than only in the source comments.
    expect(check.detail).toMatch(/[Ll]ocal profile commands[^.]*unaffected/)
    expect(check.detail).not.toContain('every command')
  })

  it('never suggests stored profile metadata while UCP_AGENT_PROFILE_URL is active', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const overrideUrl = 'https://override.example.com/profile.json'
    const fakeFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: { location: 'https://cdn.example.com/profile.json' },
        }),
    )

    const result = await runDoctor({
      homeDir,
      env: { UCP_AGENT_PROFILE_URL: overrideUrl },
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const check = findCheck(result, 'profile-redirect')

    expect(check.detail).toContain(overrideUrl)
    expect(check.detail).toContain('point UCP_AGENT_PROFILE_URL')
    expect(check.detail).not.toContain('meta.profile_url')
    expect(check.detail).not.toContain('meta.json')
  })

  // Profile URLs are https, so an http target can never be the URL to
  // advertise — the remedy must not name it.
  it('does not offer an http redirect target as the profile URL to advertise', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const fakeFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://mybot.example.com/profile.json' },
        }),
    )
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const check = findCheck(result, 'profile-redirect')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('`Location: http://mybot.example.com/profile.json`')
    expect(check.detail).toContain('over https')
  })

  it('reports profile-redirect ok when the URL serves the document itself', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const fakeFetch = vi.fn(async () => jsonResponse(publishedProfile(LATEST)))
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    const check = findCheck(result, 'profile-redirect')
    expect(check.status).toBe('ok')
    expect(check.detail).toContain(SELF_HOSTED_URL)
  })

  it('skipNetwork omits every hosted-identity check', async () => {
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    for (const id of ['protocol', 'profile-drift', 'profile-cache-control', 'profile-redirect']) {
      expect(result.checks.find((c) => c.id === id)).toBeUndefined()
    }
  })
})

// ─── protocol + profile drift, DIY ───────────────────────────────────────
//
// For an authored Profile, `profile.json` IS the declaration: which UCP
// version it speaks and every capability it claims. `protocol` is the only
// place doctor says so, and the only place the local document meets the one
// the URL serves. Severity follows consequence: a version disagreement makes
// every request wrong (`fail`), any other difference makes our plan wrong but
// our requests well-formed (`warn`).
describe('runDoctor — protocol + profile drift', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-protocol-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  /** Serve `body` for the agent-profile GET; 200 for anything else. */
  function serving(body: unknown): typeof fetch {
    return vi.fn(async (_url: unknown, init: RequestInit = {}) =>
      init.method === 'HEAD' ? new Response(null, { status: 200 }) : jsonResponse(body),
    ) as unknown as typeof fetch
  }

  it('names the active version, the window, whether it is latest, and the URL', async () => {
    // A published body at a URL the user typed is an authored (DIY) identity:
    // the pairing is a decision, so the local document is what we declare.
    const body = publishedProfile(LATEST)
    await saveUserProfile(
      { name: 'prod', body: body as PlatformProfile, meta: { profile_url: SELF_HOSTED_URL } },
      { homeDir },
    )
    await writeActive({ profile: 'prod' }, { homeDir })
    const result = await runDoctor({ homeDir, env: {}, fetch: serving(body) })

    const check = findCheck(result, 'protocol')
    expect(check.status).toBe('ok')
    expect(check.detail).toContain(`uses UCP ${LATEST}`)
    // Which file the version came from, and that the URL agrees with it — the
    // one thing no other check can establish, because the request path never
    // reads the wire.
    expect(check.detail).toContain(join(homeDir, 'profiles', 'prod', 'profile.json'))
    expect(check.detail).toContain('serves the same version (checked live)')
    expect(check.detail).toContain(`ucp-cli supports ${SUPPORTED_VERSIONS.join(', ')}`)
    expect(check.detail).toContain('this is the latest')
    expect(check.detail).not.toContain('NOT the latest')
    expect(check.detail).toContain(SELF_HOSTED_URL)
    expect(result.ok).toBe(true)
  })

  it('keeps hosted validation strict for an edited ucp-cli 0.4.2–0.7.0 Profile', async () => {
    const body = publishedProfile('2026-04-08') as PlatformProfile & {
      ucp: {
        services: Record<string, Array<Record<string, unknown>>>
        capabilities: Record<string, unknown>
      }
    }
    const shopping = body.ucp.services['dev.ucp.shopping']?.[0]
    if (shopping === undefined) throw new Error('published shopping entry missing')
    shopping.version = '2026-01-23'
    body.ucp.capabilities['com.acme.loyalty'] = [
      {
        version: '2026-04-08',
        spec: 'https://acme.test/loyalty/spec',
        schema: 'https://acme.test/loyalty/schema.json',
      },
    ]

    await saveUserProfile({ name: 'edited-042-070', body, meta: DIY_META }, { homeDir })
    await writeActive({ profile: 'edited-042-070' }, { homeDir })

    const result = await runDoctor({ homeDir, env: {}, fetch: serving(body) })

    expect(findCheck(result, 'active-profile').status).toBe('ok')
    const protocol = findCheck(result, 'protocol')
    expect(protocol.status).toBe('fail')
    expect(protocol.detail).toContain('AGENT_PROFILE_VERSION_MISMATCH')
    expect(result.ok).toBe(false)
  })

  it('says NOT latest — and stays ok — for a supported older release', async () => {
    // A 2026-04-08 profile is VALID: the window is a set, not a floor. This
    // must never be a failure, or every user pinned to an older release for a
    // reason would see a red doctor.
    const body = publishedProfile('2026-04-08')
    await saveUserProfile(
      {
        name: 'legacy',
        body: body as PlatformProfile,
        meta: { profile_url: SELF_HOSTED_URL },
      },
      { homeDir },
    )
    await writeActive({ profile: 'legacy' }, { homeDir })
    const result = await runDoctor({ homeDir, env: {}, fetch: serving(body) })

    const check = findCheck(result, 'protocol')
    expect(check.status).toBe('ok')
    expect(check.detail).toContain('uses UCP 2026-04-08')
    expect(check.detail).toContain(`NOT the latest (${LATEST})`)
    expect(check.detail).toContain('Still fully supported')
    // The move-forward remedy is one command, and it is labelled destructive:
    // it rewrites profile.json from the published document, so a user with
    // local edits loses them by following our own advice.
    expect(check.detail).toContain(`--version ${LATEST} --force`)
    expect(check.detail).toContain(RELEASES[LATEST].defaultAgentProfileUrl)
    expect(check.detail).toMatch(/REWRITES/)
    expect(check.detail).toContain('discarding local edits')
    // A DELIBERATE pin (profile_url set, served document matches) is green.
    expect(findCheck(result, 'profile-drift').status).toBe('ok')
    expect(result.ok).toBe(true)
  })

  // The same fault as a managed rendering serving the wrong release, but on a
  // URL the reader owns: the remedy differs in what they can do about it, not
  // in severity.
  it('fails a version mismatch on a URL you own and offers uploading', async () => {
    await saveUserProfile(
      {
        name: 'mine',
        body: publishedProfile('2026-04-08') as PlatformProfile,
        meta: { profile_url: SELF_HOSTED_URL },
      },
      { homeDir },
    )
    await writeActive({ profile: 'mine' }, { homeDir })
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: serving(publishedProfile(LATEST)),
    })

    const check = findCheck(result, 'protocol')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain(`serves UCP ${LATEST}`)
    expect(check.detail).toContain('negotiates as UCP 2026-04-08')
    expect(check.detail).toContain(join(homeDir, 'profiles', 'mine', 'profile.json'))
    expect(check.detail).toContain('point meta.profile_url')
    // Uploading is something the reader does, never something ucp-cli offers
    // to do: it has no command that writes to a URL. And never "upgrade
    // ucp-cli": the version ucp-cli sends is the local file's.
    expect(check.detail).toMatch(/upload .*profile\.json to https:/i)
    expect(check.detail).not.toMatch(/ucp profile publish/)
    expect(check.detail).not.toMatch(/upgrade ucp-cli/i)
    expect(result.ok).toBe(false)
    // One voice per fault: `protocol` has ruled, so drift stays quiet.
    expect(result.checks.find((c) => c.id === 'profile-drift')).toBeUndefined()
  })

  it('fails when the served document is outside the window', async () => {
    const hosted = publishedProfile(LATEST) as { ucp: Record<string, unknown> }
    hosted.ucp.version = '2027-01-01'
    hosted.ucp.services = {}
    hosted.ucp.capabilities = {}
    await saveUserProfile(
      { name: 'ahead', body: SAMPLE_BODY, meta: { profile_url: SELF_HOSTED_URL } },
      { homeDir },
    )
    await writeActive({ profile: 'ahead' }, { homeDir })
    const result = await runDoctor({ homeDir, env: {}, fetch: serving(hosted) })

    expect(findCheck(result, 'protocol').status).toBe('fail')
    expect(findCheck(result, 'protocol').detail).toContain('AGENT_PROFILE_VERSION_UNSUPPORTED')
    expect(result.ok).toBe(false)
  })

  // Same version on both sides, different content: the requests ucp-cli sends
  // are well-formed, but the business grants capabilities off a different
  // declaration than the one we planned against. Worth saying, not worth
  // stopping a build for — and the URL's owner is not part of the judgement.
  it('warns on a content difference under a release-default URL', async () => {
    await saveUserProfile(
      {
        name: 'prod',
        body: SAMPLE_BODY,
        meta: { profile_url: RELEASES[LATEST].defaultAgentProfileUrl },
      },
      { homeDir },
    )
    await writeActive({ profile: 'prod' }, { homeDir })
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: serving(publishedProfile(LATEST)),
    })

    const drift = findCheck(result, 'profile-drift')
    expect(drift.status).toBe('warn')
    expect(drift.detail).toContain('the versions agree')
    expect(drift.detail).toContain(join(homeDir, 'profiles', 'prod', 'profile.json'))
    // Only `fail` gates the verdict, so a content difference must not fail a
    // CI job.
    expect(result.ok).toBe(true)
  })

  it('warns on a content difference under a URL you own, and says who reads what', async () => {
    await saveUserProfile(
      { name: 'mine', body: SAMPLE_BODY, meta: { profile_url: SELF_HOSTED_URL } },
      { homeDir },
    )
    await writeActive({ profile: 'mine' }, { homeDir })
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: serving(publishedProfile(LATEST)),
    })

    const drift = findCheck(result, 'profile-drift')
    expect(drift.status).toBe('warn')
    expect(drift.detail).toContain('The business acts on what that URL serves')
    expect(drift.detail).toMatch(/upload .*profile\.json to https:/i)
    expect(drift.detail).toMatch(/edit .*profile\.json to match what the URL serves/i)
    expect(drift.detail).toContain('point meta.profile_url')
    expect(drift.detail).not.toMatch(/profile init|copy what that URL serves/i)
    expect(drift.detail).not.toMatch(/ucp profile publish/)
    // A warn describes optional state and must not gate the verdict.
    expect(result.ok).toBe(true)
  })

  it('reports no drift when the local document matches the served bytes', async () => {
    // What `profile init` produces: profile.json IS the published document,
    // re-serialized. The comparison is structural, not byte-wise, so the
    // indentation `saveUserProfile` applies is not reported as drift.
    const body = publishedProfile(LATEST)
    await saveUserProfile(
      {
        name: 'fresh',
        body: body as PlatformProfile,
        meta: { profile_url: SELF_HOSTED_URL },
      },
      { homeDir },
    )
    await writeActive({ profile: 'fresh' }, { homeDir })
    const result = await runDoctor({ homeDir, env: {}, fetch: serving(body) })

    expect(findCheck(result, 'profile-drift').status).toBe('ok')
    expect(findCheck(result, 'profile-drift').detail).toContain('matches')
  })

  it('keeps a named DIY body authored under UCP_AGENT_PROFILE_URL for version remedies', async () => {
    await saveUserProfile(
      {
        name: 'prod',
        body: SAMPLE_BODY,
        meta: { profile_url: RELEASES[LATEST].defaultAgentProfileUrl },
      },
      { homeDir },
    )
    await writeActive({ profile: 'prod' }, { homeDir })
    const result = await runDoctor({
      homeDir,
      env: { UCP_AGENT_PROFILE_URL: SELF_HOSTED_URL },
      fetch: serving(publishedProfile('2026-04-08')),
    })

    const bodyPath = join(homeDir, 'profiles', 'prod', 'profile.json')
    const active = findCheck(result, 'active-profile')
    expect(active.detail).toContain('locally authored (DIY)')
    expect(active.detail).toContain('UCP_AGENT_PROFILE_URL overrides')
    expect(active.detail).toContain(bodyPath)
    expect(active.detail).toContain(SELF_HOSTED_URL)
    expect(active.detail).toContain('unset UCP_AGENT_PROFILE_URL')
    expect(active.detail).not.toContain('bundled')
    expect(active.detail).not.toContain('meta.profile_url')

    const protocol = findCheck(result, 'protocol')
    expect(protocol.status).toBe('fail')
    expect(protocol.detail).toContain(SELF_HOSTED_URL)
    expect(protocol.detail).toContain(bodyPath)
    expect(protocol.detail).toMatch(/upload local profile\.json.*override URL/i)
    expect(protocol.detail).toContain('unset UCP_AGENT_PROFILE_URL')
    expect(protocol.detail).not.toContain('meta.profile_url')
    expect(protocol.detail).not.toContain('bundled')
  })

  it('compares a DIY override URL against the local authored body, not the bundle', async () => {
    await saveUserProfile(
      {
        name: 'prod',
        body: SAMPLE_BODY,
        meta: { profile_url: RELEASES[LATEST].defaultAgentProfileUrl },
      },
      { homeDir },
    )
    await writeActive({ profile: 'prod' }, { homeDir })

    const result = await runDoctor({
      homeDir,
      env: { UCP_AGENT_PROFILE_URL: SELF_HOSTED_URL },
      fetch: serving(SAMPLE_BODY),
    })

    const active = findCheck(result, 'active-profile')
    expect(active.detail).toContain('locally authored (DIY)')
    expect(active.detail).toContain('UCP_AGENT_PROFILE_URL')
    const drift = findCheck(result, 'profile-drift')
    expect(drift.status).toBe('ok')
    expect(drift.detail).toContain(join(homeDir, 'profiles', 'prod', 'profile.json'))
    expect(drift.detail).toContain(SELF_HOSTED_URL)
    expect(drift.detail).toContain('UCP_AGENT_PROFILE_URL')
    expect(drift.detail).not.toContain('bundled')
    expect(drift.detail).not.toContain('meta.profile_url')
  })

  it('keeps named DIY + UCP_AGENT_PROFILE_URL drift remedies on the override', async () => {
    await saveUserProfile(
      {
        name: 'prod',
        body: SAMPLE_BODY,
        meta: { profile_url: RELEASES[LATEST].defaultAgentProfileUrl },
      },
      { homeDir },
    )
    await writeActive({ profile: 'prod' }, { homeDir })
    const served = publishedProfile(LATEST) as {
      ucp: { capabilities: Record<string, unknown> }
    }
    delete served.ucp.capabilities['dev.shopify.catalog.global']

    const result = await runDoctor({
      homeDir,
      env: { UCP_AGENT_PROFILE_URL: SELF_HOSTED_URL },
      fetch: serving(served),
    })

    const drift = findCheck(result, 'profile-drift')
    expect(drift.status).toBe('warn')
    expect(drift.detail).toContain(join(homeDir, 'profiles', 'prod', 'profile.json'))
    expect(drift.detail).toMatch(/upload local profile\.json.*override URL/i)
    expect(drift.detail).toContain('unset UCP_AGENT_PROFILE_URL')
    expect(drift.detail).not.toContain('meta.profile_url')
    expect(drift.detail).not.toContain('bundled')
  })

  // A scalar URL demotes even the managed Profile to one rendering, and the
  // body at that URL is a BUNDLED document — there is no local file to
  // upload, so the remedies name the override instead.
  it('audits only the pinned URL when UCP_AGENT_PROFILE_URL overrides the managed Profile', async () => {
    const warnings: string[] = []
    setWarnWriter((message) => warnings.push(message))
    const { fetch: fetchImpl, calls } = releaseFetch({
      [SELF_HOSTED_URL]: { body: publishedProfile('2026-04-08') },
    })
    const result = await runDoctor({
      homeDir,
      env: { UCP_AGENT_PROFILE_URL: SELF_HOSTED_URL },
      fetch: fetchImpl,
    })

    expect(calls.map((c) => c.url)).toEqual([SELF_HOSTED_URL])
    const check = findCheck(result, 'protocol')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain(`UCP ${LATEST}: ${SELF_HOSTED_URL} serves UCP 2026-04-08`)
    expect(check.detail).toContain('UCP_AGENT_PROFILE_URL')
    expect(check.detail).not.toMatch(/upload/i)
    expect(result.ok).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`bundled UCP ${LATEST} body`)
  })
})

// ─── hosting advisory: Cache-Control ─────────────────────────────────────
//
// A business dereferences this URL to negotiate with us, so its cache policy
// is that business's refetch rate. UCP's hosting rules make it normative
// (`Cache-Control: public, max-age>=60`, never private/no-store/no-cache),
// and a profile served uncacheable turns every exchange into an origin hit on
// that host. Advisory only — and reported for every URL, so its absence from
// the output means "not checked", never "fine".
describe('runDoctor — profile URL cache policy', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-cache-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  async function doctorWith(
    profileUrl: string,
    cacheControl: string | undefined,
  ): Promise<Awaited<ReturnType<typeof runDoctor>>> {
    const body = publishedProfile(LATEST)
    await saveUserProfile(
      { name: 'mine', body: body as PlatformProfile, meta: { profile_url: profileUrl } },
      { homeDir },
    )
    await writeActive({ profile: 'mine' }, { homeDir })
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            ...(cacheControl === undefined ? {} : { 'cache-control': cacheControl }),
          },
        }),
    )
    return runDoctor({ homeDir, env: {}, fetch: fetchImpl as unknown as typeof fetch })
  }

  it('accepts a spec-conformant policy', async () => {
    const result = await doctorWith(SELF_HOSTED_URL, 'public, max-age=300')
    const check = findCheck(result, 'profile-cache-control')
    expect(check.status).toBe('ok')
    expect(check.detail).toContain('max-age=300')
  })

  it('warns when no Cache-Control is served at all', async () => {
    const check = findCheck(await doctorWith(SELF_HOSTED_URL, undefined), 'profile-cache-control')
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('no Cache-Control header')
    expect(check.detail).toContain('max-age>=60')
  })

  it('warns on directives that forbid shared caching', async () => {
    const check = findCheck(await doctorWith(SELF_HOSTED_URL, 'no-store'), 'profile-cache-control')
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('no-store')
    expect(check.detail).toContain('cannot reuse a cached copy')
  })

  it('warns below the 60s floor', async () => {
    const check = findCheck(
      await doctorWith(SELF_HOSTED_URL, 'public, max-age=5'),
      'profile-cache-control',
    )
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('max-age=5')
  })

  // A warn is an advisory, never a gate: a merchant refetching more often
  // than necessary is a hosting inefficiency, not a broken install.
  it('never gates the verdict', async () => {
    expect((await doctorWith(SELF_HOSTED_URL, 'no-store')).ok).toBe(true)
  })

  // Reported on a release-default URL too. The headers are somebody else's to
  // fix, but merchants still refetch that document, and the reader can act on
  // it — by moving to a URL they control.
  it('reports a release-default URL on the same terms', async () => {
    const check = findCheck(
      await doctorWith(RELEASES[LATEST].defaultAgentProfileUrl, 'no-store'),
      'profile-cache-control',
    )
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('no-store')
  })
})

describe('runDoctor — proxy check', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
    clearProxyEnv(vi.stubEnv)
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    resetProxyStateForTests()
  })

  it('reports the running Node version as a passing runtime check', async () => {
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    const check = findCheck(result, 'runtime')
    expect(check.status).toBe('ok')
    expect(check.detail).toBe(`Node v${process.versions.node}`)
  })

  it.each([
    ['22.10.0', 'fail'],
    ['22.19.0', 'ok'],
    ['22.19.1', 'ok'],
    ['22.19.0-rc.1', 'fail'],
    ['22.20.0-nightly20250101', 'ok'],
  ] as const)('compares the full runtime version for Node %s', async (version, expectedStatus) => {
    // The 22.10.0 case shares the floor's major version but remains outside
    // the engines range. Suffix-bearing builds must also be classified without
    // making the diagnostic throw.
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')
    Object.defineProperty(process.versions, 'node', { ...descriptor, value: version })
    try {
      const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
      const check = findCheck(result, 'runtime')
      expect(check.status).toBe(expectedStatus)
      expect(check.detail).toBe(
        expectedStatus === 'ok'
          ? `Node v${version}`
          : `Node v${version} — ucp requires Node >= ${__MIN_NODE_VERSION__}`,
      )
    } finally {
      Object.defineProperty(process.versions, 'node', descriptor as PropertyDescriptor)
    }
  })

  it('reports direct connections when no proxy env is set', async () => {
    await installProxyDispatcher()
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(findCheck(result, 'proxy').status).toBe('ok')
    expect(findCheck(result, 'proxy').detail).toBe('none configured; connecting directly')
  })

  it('reports the active proxy without leaking credentials', async () => {
    vi.stubEnv('https_proxy', 'http://alice:s3cret@proxy.example:3128')
    await installProxyDispatcher()
    const check = findCheck(await runDoctor({ homeDir, skipNetwork: true, env: {} }), 'proxy')
    expect(check.status).toBe('ok')
    expect(check.detail).toContain('proxy.example:3128')
    expect(check.detail).not.toContain('s3cret')
  })

  it('fails when proxy env is present but the dispatcher could not be installed', async () => {
    // The state that is otherwise invisible: requests silently go direct and
    // time out, which reads as an unreachable merchant.
    vi.stubEnv('https_proxy', 'not-a-url')
    await installProxyDispatcher()
    const check = findCheck(await runDoctor({ homeDir, skipNetwork: true, env: {} }), 'proxy')
    expect(check.status).toBe('fail')
    expect(check.detail).toContain('Invalid URL')
  })
})
