// runDoctor() — local install health check.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformProfile } from '../core/profile.js'
import { saveUserProfile, writeActive } from '../core/profile-store.js'
import { installProxyDispatcher, resetProxyStateForTests } from '../core/proxy.js'
import { LATEST, RELEASES, SUPPORTED_VERSIONS, type Version } from '../core/releases.js'
import { clearProxyEnv } from '../test-utils.js'
import { runDoctor } from './doctor.js'

const SELF_HOSTED_URL = 'https://mybot.example.com/profile.json'

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

const SAMPLE_BODY: PlatformProfile = {
  ucp: { version: '2026-08-25', status: 'success', services: {}, payment_handlers: {} },
  keys: [],
}

const SAMPLE_META = {
  created_at: '2026-05-05T12:00:00Z',
  profile_url: 'https://mybot.example.com/profile.json',
}

function findCheck(
  result: { checks: { id: string; status: string; detail: string }[] },
  id: string,
) {
  const check = result.checks.find((c) => c.id === id)
  if (check === undefined) throw new Error(`no check with id "${id}" in ${JSON.stringify(result)}`)
  return check
}

describe('runDoctor — clean install', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('passes writability checks but fails active profile when nothing is configured', async () => {
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(false)
    expect(findCheck(result, 'ucp-home').status).toBe('ok')
    expect(findCheck(result, 'profiles-dir').status).toBe('ok')
    expect(findCheck(result, 'cache-dir').status).toBe('ok')
    expect(findCheck(result, 'active-yaml').status).toBe('ok')
    expect(findCheck(result, 'active-profile').status).toBe('fail')
    expect(findCheck(result, 'active-profile').detail).toContain('profile init --name agent')
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

  it('reports active.yaml content when present and parseable', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod', business: 'https://shop.example.com' }, { homeDir })
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    const active = findCheck(result, 'active-yaml')
    expect(active.status).toBe('ok')
    expect(active.detail).toContain('"business":"https://shop.example.com"')
  })

  it('warns on corrupt active.yaml and fails because no profile is selected', async () => {
    await writeFile(join(homeDir, 'active.yaml'), '!!! not yaml [[[ broken', 'utf-8')
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(false)
    expect(findCheck(result, 'active-yaml').status).toBe('warn')
    expect(findCheck(result, 'active-profile').status).toBe('fail')
  })
})

describe('runDoctor — user profile branch', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('passes when the named profile is on disk and parses', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(true)
    expect(findCheck(result, 'active-profile').status).toBe('ok')
  })

  it('fails when active.yaml references a profile that does not exist', async () => {
    await writeActive({ profile: 'ghost' }, { homeDir })
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(false)
    expect(findCheck(result, 'active-profile').status).toBe('fail')
    expect(findCheck(result, 'active-profile').detail).toContain('ghost')
  })

  it('UCP_PROFILE env wins over active.yaml when checking which profile to validate', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'ghost' }, { homeDir })
    const result = await runDoctor({
      homeDir,
      skipNetwork: true,
      env: { UCP_PROFILE: 'prod' },
    })
    expect(result.ok).toBe(true)
    expect(findCheck(result, 'active-profile').status).toBe('ok')
  })
})

// ─── the hosted-identity fetch ───────────────────────────────────────
//
// ONE network request: the GET the business also performs. Never add a second
// probe of the same URL — a `warn`-only HEAD adds no information the GET does
// not have and produces contradictory pairs (a host that 405s HEAD but serves
// GET reports `profile-url: warn` beside `protocol: ok`). Because `protocol`
// is the only voice on this URL, its failure detail has to separate transport
// failure from HTTP status from parse/validate failure: the remedies differ.
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

  // The business GETs this URL on every call and hard-fails `-32001
  // profile_unreachable`, so a doctor reporting `ok: true` here would be
  // telling the user their install is healthy while every command is
  // guaranteed to fail.
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

  // The most common self-hosting failure: a 200 serving an HTML error page.
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

  it('falls back to the latest published default when no profile_url is configured', async () => {
    // "No profile_url" is not "no identity": session resolution falls back to
    // the latest release's PUBLISHED agent profile, so `protocol` reports that
    // URL.
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

  it('skipNetwork omits every hosted-identity check', async () => {
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    for (const id of ['protocol', 'profile-drift', 'profile-cache-control']) {
      expect(result.checks.find((c) => c.id === id)).toBeUndefined()
    }
  })
})

// ─── protocol + profile drift ────────────────────────────────────────
//
// Which UCP version an install speaks is a property of the ACTIVE PROFILE,
// not the build. `protocol` is the only place doctor says so, and
// `profile-drift` is the only place the local authoring copy meets the hosted
// identity. Both are diagnostics: nothing here gates a request.
describe('runDoctor — protocol + profile drift', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-protocol-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  /** Serve `body` for the agent-profile GET; 200 for the HEAD probe. */
  function serving(body: unknown): typeof fetch {
    return vi.fn(async (_url: unknown, init: RequestInit = {}) =>
      init.method === 'HEAD' ? new Response(null, { status: 200 }) : jsonResponse(body),
    ) as unknown as typeof fetch
  }

  it('names the active version, the window, whether it is latest, and the URL', async () => {
    const body = publishedProfile(LATEST)
    await saveUserProfile(
      {
        name: 'prod',
        body: body as PlatformProfile,
        meta: { profile_url: RELEASES[LATEST].defaultAgentProfileUrl },
      },
      { homeDir },
    )
    await writeActive({ profile: 'prod' }, { homeDir })
    const result = await runDoctor({ homeDir, env: {}, fetch: serving(body) })

    const check = findCheck(result, 'protocol')
    expect(check.status).toBe('ok')
    expect(check.detail).toContain(`uses UCP ${LATEST}`)
    // Where the negotiated document came from, and that the URL agrees with
    // it — the one thing no other check can establish now that the request
    // path never reads the wire.
    expect(check.detail).toContain('bundled snapshot')
    expect(check.detail).toContain('serves the same version (checked live)')
    expect(check.detail).toContain(`ucp-cli supports ${SUPPORTED_VERSIONS.join(', ')}`)
    expect(check.detail).toContain('this is the latest')
    expect(check.detail).not.toContain('NOT the latest')
    expect(check.detail).toContain(RELEASES[LATEST].defaultAgentProfileUrl)
    expect(check.detail).toContain('published release default')
    expect(result.ok).toBe(true)
  })

  // Every command resolves a release-default URL from the snapshot this build
  // ships and makes no request at all. Doctor is the exception, and this is
  // the scenario it exists for: a published default URL whose content changed
  // under a frozen version is a spec-release violation, the CLI would keep
  // negotiating as its snapshot while the merchant reads the new document,
  // and a check that answers from the snapshot is structurally incapable of
  // seeing it.
  it('fails when a release-default URL serves a different version than the snapshot', async () => {
    const body = publishedProfile(LATEST)
    await saveUserProfile(
      {
        name: 'prod',
        body: body as PlatformProfile,
        meta: { profile_url: RELEASES[LATEST].defaultAgentProfileUrl },
      },
      { homeDir },
    )
    await writeActive({ profile: 'prod' }, { homeDir })
    // The LATEST default URL serving the OTHER release's document.
    const requested: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      requested.push(String(url))
      return jsonResponse(publishedProfile('2026-04-08'))
    })
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fetchImpl as unknown as typeof fetch,
    })

    expect(requested).toContain(RELEASES[LATEST].defaultAgentProfileUrl)
    const check = findCheck(result, 'protocol')
    expect(check.status).toBe('fail')
    // Both values, and which one each side uses.
    expect(check.detail).toContain('serves UCP 2026-04-08')
    expect(check.detail).toContain(`negotiates as ${LATEST}`)
    expect(check.detail).toContain('Upgrade ucp-cli')
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
        meta: { profile_url: RELEASES['2026-04-08'].defaultAgentProfileUrl },
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
    // The move-forward remedy leads with the one-field change and labels
    // `init --force` as destructive: it rewrites profile.json from the
    // release template, so a user with local edits loses them by following
    // our own advice.
    expect(check.detail).toContain('point meta.profile_url at')
    expect(check.detail).toContain(RELEASES[LATEST].defaultAgentProfileUrl)
    expect(check.detail).toContain(`--version ${LATEST}`)
    expect(check.detail).toMatch(/REWRITES profile\.json/)
    // A DELIBERATE pin (profile_url set, hosted document matches) is green.
    // The version-drift warn below must not fire here, or the check would be
    // permanently red for everyone who pinned on purpose.
    expect(findCheck(result, 'profile-drift').status).toBe('ok')
    expect(result.ok).toBe(true)
  })

  // The legacy-upgrade population: 0.6.x wrote profile.json at 2026-04-08
  // (the build clamped there) and no meta.profile_url, so the identity now
  // resolves to the latest published default and negotiates 2026-08-25.
  // Before this check doctor was GREEN on exactly this population — and its
  // only warning blamed "managed upload may not be configured yet", which
  // named the wrong cause.
  it('warns when the local ucp.version differs from the hosted identity', async () => {
    const legacy = publishedProfile('2026-04-08')
    await saveUserProfile(
      {
        name: 'legacy',
        body: legacy as PlatformProfile,
        meta: { created_at: '2026-05-05T12:00:00Z' },
      },
      { homeDir },
    )
    await writeActive({ profile: 'legacy' }, { homeDir })
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: serving(publishedProfile(LATEST)),
    })

    expect(findCheck(result, 'protocol').status).toBe('ok')
    const drift = findCheck(result, 'profile-drift')
    expect(drift.status).toBe('warn')
    // Both versions, which one is actually used, and why the file is not it.
    expect(drift.detail).toContain('local profile.json declares ucp 2026-04-08')
    expect(drift.detail).toContain(`which serves ${LATEST}`)
    expect(drift.detail).toContain('never from profile.json')
    expect(drift.detail).toContain('Editing profile.json changes nothing merchants can see')
    // Remedy is the one-field change, naming the URL that pins 04-08.
    expect(drift.detail).toContain('set meta.profile_url')
    expect(drift.detail).toContain(RELEASES['2026-04-08'].defaultAgentProfileUrl)
    expect(drift.detail).not.toMatch(/managed upload/)
    // Still a warn: this is a diagnostic, and the install works.
    expect(result.ok).toBe(true)
  })

  // Self-hosted is the case where the two documents must AGREE, because the
  // CLI negotiates from the local one and the merchant reads the hosted one.
  // A version difference there is not a documentation nit; it is the two
  // sides speaking different releases, so `protocol` fails rather than
  // `profile-drift` warning.
  it('fails a self-hosted version mismatch and points at uploading, not at pinning', async () => {
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
    expect(check.detail).toContain('profile.json')
    // No command: ucp-cli cannot write to the user's URL, so the remedy must
    // not name a verb that would imply it can.
    expect(check.detail).toMatch(/Upload .*profile\.json to https:/)
    expect(check.detail).not.toMatch(/ucp profile publish/)
    expect(check.detail).not.toContain('set meta.profile_url')
    expect(result.ok).toBe(false)
  })

  it('fails when the hosted document is outside the window', async () => {
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

  it('warns on drift against a release default: the edit is inert, or the snapshot is stale', async () => {
    // Not a false alarm: `profile init` writes the release's verbatim
    // snapshot, so a clean install reports `matches` (asserted below in
    // "reports no drift when the local copy matches the hosted bytes"). A diff
    // here means the user edited a file that cannot affect anything, or the
    // publisher moved the document out from under this build's snapshot.
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
    expect(drift.detail).toContain('invisible to them')
    expect(drift.detail).toContain('--profile-url')
    expect(drift.detail).toContain('snapshot is stale')
    // A warn describes state the user should know about; only `fail` gates the
    // verdict, so an inert local edit must not fail a CI job.
    expect(result.ok).toBe(true)
  })

  it('drift on a SELF-HOSTED URL warns: the hosted copy is what the business reads', async () => {
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
    expect(drift.detail).toContain('your edits are NOT live')
    expect(drift.detail).toMatch(/Upload .*profile\.json to https:/)
    expect(drift.detail).not.toMatch(/ucp profile publish/)
    // A warn describes optional state and must not gate the verdict.
    expect(result.ok).toBe(true)
  })

  it('reports no drift when the local copy matches the hosted bytes', async () => {
    // What `profile init` produces: profile.json IS the published snapshot,
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

  it('UCP_AGENT_PROFILE_URL overrides meta.profile_url for the protocol check', async () => {
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
      fetch: serving(publishedProfile(LATEST)),
    })

    expect(findCheck(result, 'protocol').detail).toContain(SELF_HOSTED_URL)
    expect(findCheck(result, 'protocol').detail).toContain('self-hosted')
  })
})

// ─── hosting advisory: Cache-Control ─────────────────────────────────────
//
// The merchant fetches this URL to negotiate with us, so its cache policy is
// the merchant's fetch rate. UCP's hosting rules make it normative
// (`Cache-Control: public, max-age>=60`, never private/no-store/no-cache),
// and a profile served uncacheable turns every call into an origin hit on the
// user's own host. Advisory only, and only where the user owns the headers.
describe('runDoctor — self-hosted cache policy', () => {
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
    expect(check.detail).toContain('refetches your profile on every request')
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

  it('says nothing about a release default — nobody local owns those headers', async () => {
    const result = await doctorWith(RELEASES[LATEST].defaultAgentProfileUrl, 'no-store')
    expect(result.checks.find((c) => c.id === 'profile-cache-control')).toBeUndefined()
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

  it('fails the runtime check below the engines floor', async () => {
    // npm engines is warning-only, so an unsupported Node still installs and
    // mostly runs; doctor is where that state gets caught deliberately
    // instead of as a cryptic dependency error (field-reported: undici 7 on
    // Node 18 dies with "File is not defined").
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')
    Object.defineProperty(process.versions, 'node', { ...descriptor, value: '18.19.1' })
    try {
      const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
      const check = findCheck(result, 'runtime')
      expect(check.status).toBe('fail')
      expect(check.detail).toContain('Node v18.19.1')
      expect(check.detail).toContain('requires Node >= 22')
      expect(result.ok).toBe(false)
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
