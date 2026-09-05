// `ucp doctor` — local install health check.
//
// Verifies what can be answered locally, plus one GET of the active profile's
// hosted identity — the same request the business makes. Each check that
// doesn't yet have a feature behind it is deliberately omitted: an
// always-green check for a feature that doesn't ship trains users to ignore
// the output.
//
// Returns a structured envelope so machine consumers (CI, agents) can
// pattern-match on individual checks. `ok` is the AND of all `fail` checks,
// which makes `fail` the ONLY machine-actionable severity: a consumer writing
// `if (result.ok)` never enumerates `checks` and never sees a warn. So
// anything that makes our requests wrong is a `fail`, and `warn` is reserved
// for state a human should know about but a build should not stop for.
// `ok: false` exits nonzero — see the `doctor` command in src/cli.ts.

import { access, constants, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { type AgentProfile, fetchAgentProfileLive, resolveAgentProfile } from '../core/agent.js'
import { MIN_CACHE_SECONDS } from '../core/cache.js'
import {
  activeYamlPath,
  type ProfileStoreOptions,
  profileDir,
  profileStoreHome,
  profilesRoot,
  readActive,
  readUserProfile,
} from '../core/profile-store.js'
import { describeProxyState, proxyState } from '../core/proxy.js'
import { LATEST, RELEASES, SUPPORTED_VERSIONS } from '../core/releases.js'
import { isUcpError } from '../lib/errors.js'

export interface DoctorDeps {
  homeDir?: string
  /** Injectable fetch for tests / offline mode. */
  fetch?: typeof fetch
  /** Skip the network probe. Defaults to false. */
  skipNetwork?: boolean
  /** Override env-var lookup for tests. */
  env?: Record<string, string | undefined>
}

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  id: string
  status: CheckStatus
  detail: string
}

export interface DoctorResult {
  ok: boolean
  checks: Check[]
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  const env = deps.env ?? process.env
  const storeOpts: ProfileStoreOptions = deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}
  const checks: Check[] = []

  // 1. Supported runtime. npm `engines` is warning-only at install time, so
  // an out-of-contract Node still installs and mostly runs — until a
  // dependency trips over a missing global with a cryptic error. Checked
  // first because it explains every downstream failure.
  checks.push(checkRuntime())

  // 2. ~/.ucp home + cache + profiles dirs writable. Side-effect: mkdir
  // recursive so a clean install passes (matches what readActive/saveUserProfile
  // do on first write). Failure here means the rest of the CLI is broken too.
  const home = profileStoreHome(storeOpts)
  checks.push(await checkWritable('ucp-home', home))
  checks.push(await checkWritable('profiles-dir', profilesRoot(storeOpts)))
  checks.push(await checkWritable('cache-dir', join(home, 'cache')))

  // 3. active.yaml resolves (degraded-empty allowed; readActive never throws).
  // The check exists so a corrupt file shows up explicitly rather than silently
  // collapsing the session to defaults.
  const activeCheck = await checkActive(storeOpts)
  checks.push(activeCheck)

  // 4. Active local profile parses from disk. Profile init is required; there
  // is no synthetic runtime profile for operations.
  const active = await readActive(storeOpts)
  const profileName = env.UCP_PROFILE ?? active.profile
  checks.push(await checkProfile(profileName, storeOpts))

  // 5. Outbound network configuration. Reports the proxy decision made at
  // boot, catching the otherwise-invisible state: proxy env present but
  // unusable, which looks exactly like an unreachable merchant. Ordered
  // before the network probe so a proxy misconfiguration reads as the cause
  // of the probe's failure.
  checks.push(checkProxy())

  // 6. Protocol negotiation. Which UCP version this install uses is a
  // property of the ACTIVE PROFILE, not the install, and nothing else in
  // doctor's output said so. `protocol` answers it — and, since the request
  // path never reads the wire, is the only thing that verifies the URL we
  // advertise works and serves what we declare. `profile-drift` compares the
  // rest of that document against the local one. Last because it is the only
  // check whose failure is fully explained by the ones above (proxy, hosting).
  //
  // There is deliberately no second, softer reachability probe of the same
  // URL: a HEAD `warn` next to a GET `fail` produced contradictory verdict
  // pairs with no added information (a host that 405s HEAD but serves GET
  // reported `warn` + `ok`), so the fetch that decides negotiation is the
  // only one that reports.
  if (deps.skipNetwork !== true) {
    checks.push(...(await checkProtocol(profileName, storeOpts, env, deps.fetch ?? fetch)))
  }

  const ok = checks.every((c) => c.status !== 'fail')
  return { ok, checks }
}

// Below the engines floor is a `fail`, not a warn: the contract is declared,
// the runtime is EOL, and breakage arrives as cryptic dependency errors (on
// Node 18 the proxy dispatcher dies with "File is not defined"). A CI gate
// going red on an unsupported runtime is the check working as intended.
function checkRuntime(): Check {
  const version = process.versions.node
  const supported = Number(version.split('.', 1)[0]) >= __MIN_NODE_MAJOR__
  return {
    id: 'runtime',
    status: supported ? 'ok' : 'fail',
    detail: supported
      ? `Node v${version}`
      : `Node v${version} — ucp requires Node >= ${__MIN_NODE_MAJOR__}`,
  }
}

// Proxy env we could not act on is a `fail`: every outbound request silently
// bypasses the proxy and times out, a broken install even though nothing
// local is wrong. `inactive` is the common, healthy path.
function checkProxy(): Check {
  return {
    id: 'proxy',
    status: proxyState().status === 'error' ? 'fail' : 'ok',
    detail: describeProxyState(),
  }
}

async function checkWritable(id: string, path: string): Promise<Check> {
  try {
    await mkdir(path, { recursive: true })
    await access(path, constants.W_OK)
    return { id, status: 'ok', detail: path }
  } catch (err) {
    return { id, status: 'fail', detail: `${path}: ${(err as Error).message}` }
  }
}

async function checkActive(opts: ProfileStoreOptions): Promise<Check> {
  // readActive degrades to {} on parse failure; check the file directly so we
  // can distinguish "missing" (fine) from "present but malformed" (warn).
  try {
    await access(activeYamlPath(opts), constants.R_OK)
  } catch {
    return { id: 'active-yaml', status: 'ok', detail: 'no active.yaml' }
  }
  const active = await readActive(opts)
  // readActive returning empty {} when the file exists is the malformed signal.
  // It's the same shape as a stale file truncated to 0 bytes; treat as warn so
  // the user knows but it doesn't gate `ok`.
  if (Object.keys(active).length === 0) {
    return {
      id: 'active-yaml',
      status: 'warn',
      detail: `${activeYamlPath(opts)} present but parsed empty (corrupt or truncated?)`,
    }
  }
  return { id: 'active-yaml', status: 'ok', detail: JSON.stringify(active) }
}

async function checkProfile(name: string | undefined, opts: ProfileStoreOptions): Promise<Check> {
  if (name === undefined || name === '') {
    return {
      id: 'active-profile',
      status: 'fail',
      detail: 'no local profile selected; run `ucp profile init --name agent`',
    }
  }
  try {
    await access(profileDir(name, opts), constants.R_OK)
  } catch {
    return {
      id: 'active-profile',
      status: 'fail',
      detail: `profile "${name}" referenced but not found on disk`,
    }
  }
  try {
    await readUserProfile(name, opts)
    return { id: 'active-profile', status: 'ok', detail: `profile "${name}" parsed cleanly` }
  } catch (err) {
    return {
      id: 'active-profile',
      status: 'fail',
      detail: `profile "${name}" failed to parse: ${(err as Error).message}`,
    }
  }
}

// ─── Protocol / profile-drift checks ─────────────────────────────────────
//
// Two checks, one fetch, one boundary between them:
//
//   `protocol`      can this URL be used as an identity, and does it serve
//                   the release ucp-cli will actually send?
//
//   `profile-drift` does the rest of that document match the local one?
//
// `protocol` is the one that carries correctness, and its severities follow
// consequence, not who owns the URL. The request path never reads the wire
// (core/agent.ts): `profile.json` is what ucp-cli declares, at every URL. The
// business, meanwhile, reads the URL. So if the URL cannot be read, or serves
// a different `ucp.version`, the two sides disagree about who we are and
// nothing else in the CLI will ever notice — both are `fail`, and the message
// names both versions. The business GETs this URL on every call and
// hard-fails `-32001 profile_unreachable` if it 404s, so a red `protocol` is
// a prediction of total failure, not a local inconvenience.
//
// `profile-drift` is what remains once the versions agree: a declaration the
// business will act on (it reads the URL) that differs from the one ucp-cli
// plans against. `warn`, because the requests we send are still well-formed
// and only `fail` gates the verdict.
async function checkProtocol(
  name: string | undefined,
  opts: ProfileStoreOptions,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<Check[]> {
  if (name === undefined || name === '') {
    return [{ id: 'protocol', status: 'warn', detail: 'no local profile; skipped' }]
  }
  let local: Awaited<ReturnType<typeof readUserProfile>>
  try {
    local = await readUserProfile(name, opts)
  } catch {
    // Already a `fail` on `active-profile`; no second voice on the same fault.
    return [{ id: 'protocol', status: 'warn', detail: 'profile unreadable; skipped' }]
  }
  // Same precedence resolveSession uses, minus the --profile-url flag (doctor
  // reports the persistent configuration, not one invocation's override).
  const url =
    env.UCP_AGENT_PROFILE_URL ?? local.meta.profile_url ?? RELEASES[LATEST].defaultAgentProfileUrl
  // Both paths are named in the remedies below, because the two files answer
  // different questions: `profile.json` is what ucp-cli declares,
  // `meta.profile_url` is where the business goes to read it.
  const metaPath = join(profileDir(name, opts), 'meta.json')
  const bodyPath = join(profileDir(name, opts), 'profile.json')

  // What the request path will actually use — the same call `discover` makes,
  // no network. Its failures are the ones every command would hit, so they
  // are reported before anything is fetched.
  let wire: AgentProfile
  try {
    wire = await resolveAgentProfile({ url, name, ...opts })
  } catch (err) {
    return [
      {
        id: 'protocol',
        status: 'fail',
        detail: `${describeError(err)} — ${bodyPath} is the document ucp-cli negotiates from, so every command fails until it is fixed.`,
      },
    ]
  }

  let live: Awaited<ReturnType<typeof fetchAgentProfileLive>>
  try {
    live = await fetchAgentProfileLive({ url, name, fetch: fetchImpl })
  } catch (err) {
    // `fail`, not `warn`: the business GETs this URL to negotiate with us. If
    // it cannot be read, the business cannot read it either.
    //
    // The detail must separate the sub-causes, because they have different
    // remedies. `fetchAgentProfileLive` already names them:
    // AGENT_PROFILE_UNREACHABLE carries `(network: …)` (DNS/TLS/connect/
    // timeout), `(http_status: HTTP …)`, or `(not_json: …)` in its message,
    // and a document that parsed but is not a usable identity arrives under a
    // distinct code (AGENT_PROFILE_SCHEMA_INVALID / _VERSION_UNSUPPORTED /
    // _VERSION_MISMATCH). So `code: message` is the full discrimination;
    // re-deriving it here would be a second copy that can drift.
    return [{ id: 'protocol', status: 'fail', detail: describeError(err) }]
  }

  // THE check. Both sides read a document; they must agree on its version or
  // we are negotiating as somebody the business does not see.
  if (live.agent.version !== wire.version) {
    return [
      {
        id: 'protocol',
        status: 'fail',
        detail: `${url} serves UCP ${live.agent.version}, but ucp-cli negotiates as UCP ${wire.version} — the version in ${bodyPath}, the document it declares. The business fetches the URL, so it reads ${live.agent.version} while ucp-cli speaks ${wire.version}. Make them agree: \`ucp profile init --name ${name} --version ${live.agent.version} --force\` REWRITES ${bodyPath} as the published UCP ${live.agent.version} document (discarding local edits); or upload ${bodyPath} to ${url} when that URL is yours; or point meta.profile_url (${metaPath}) at a URL serving UCP ${wire.version}.`,
      },
    ]
  }

  const latest = wire.version === LATEST
  const checks: Check[] = [
    {
      id: 'protocol',
      status: 'ok',
      detail: [
        `profile "${name}" uses UCP ${wire.version}`,
        `from ${bodyPath}, sent as ${url},`,
        `which serves the same version (checked live);`,
        `ucp-cli supports ${SUPPORTED_VERSIONS.join(', ')} —`,
        // An older supported release is VALID, not a problem: ucp-cli supports
        // a set of releases, not a floor. So this is a note with a command,
        // never a warn — a red doctor for a deliberately pinned profile would
        // train users to ignore the output.
        latest
          ? 'this is the latest.'
          : `NOT the latest (${LATEST}). Still fully supported; to move, \`ucp profile init --name ${name} --version ${LATEST} --force\` REWRITES ${bodyPath} as the published UCP ${LATEST} document (discarding local edits) and points meta.profile_url (${metaPath}) at ${RELEASES[LATEST].defaultAgentProfileUrl}.`,
      ].join(' '),
    },
  ]

  checks.push(checkCacheControl(live.cacheControl, url))

  // Deep equality on parsed JSON, not bytes: `profile init` re-serializes the
  // published document with its own indentation, so a byte compare would flag
  // every clean install. Key ORDER differences are likewise not drift — the
  // documents are JSON objects, and no UCP reader depends on member order.
  // `wire.body` rather than the store's copy: it is the exact object
  // negotiation runs against, parsed by the same release schema as the fetched
  // one, so neither side of the comparison can pick up a stray default.
  if (deepEqual(wire.body as unknown, live.agent.body as unknown)) {
    checks.push({
      id: 'profile-drift',
      status: 'ok',
      detail: `local profile.json matches ${url}`,
    })
  } else {
    checks.push({
      id: 'profile-drift',
      status: 'warn',
      detail: `${url} serves a document that differs from ${bodyPath} beyond ucp.version (the versions agree). The business acts on what that URL serves; ucp-cli plans against the local file — so a capability you added locally is not one the business will grant, and one it grants is not one ucp-cli will use. Upload ${bodyPath} to ${url} when that URL is yours — ucp-cli has no command that writes to a URL. Otherwise copy what that URL serves into ${bodyPath} (\`ucp profile init --name ${name} --version ${wire.version} --force\` does it for a published release document).`,
    })
  }
  return checks
}

/** `code: message` for a UcpError, plain message otherwise. */
function describeError(err: unknown): string {
  return isUcpError(err) ? `${err.code}: ${err.message}` : (err as Error).message
}

// Hosting advisory on the profile URL.
//
// UCP overview §"Profile Requirements / Hosting": published artifacts MUST
// carry `Cache-Control: public` with `max-age` of at least 60 seconds and
// MUST NOT be served `private`/`no-store`/`no-cache`. That rule exists
// because merchants fetch this URL per request; a document served
// uncacheable turns every one of your requests into an extra origin hit on
// that host, and is the first thing to look at when a merchant rate-limits
// discovery.
//
// `warn`, not `fail`: it degrades the merchant's fetch pattern, not this
// install's ability to transact, and doctor's `ok` gates CI. Reported for
// every URL — the header is a fact about the identity this profile presents,
// and reporting it only sometimes would make its absence ambiguous.
function checkCacheControl(cacheControl: string | null, url: string): Check {
  const id = 'profile-cache-control'
  const spec = 'UCP requires `Cache-Control: public, max-age>=60` on published profiles'
  if (cacheControl === null) {
    return { id, status: 'warn', detail: `${url} serves no Cache-Control header — ${spec}.` }
  }
  const cc = cacheControl.toLowerCase()
  const forbidden = ['no-store', 'no-cache', 'private'].filter((d) => cc.includes(d))
  if (forbidden.length > 0) {
    return {
      id,
      status: 'warn',
      detail: `${url} serves \`Cache-Control: ${cacheControl}\` — ${forbidden.join(', ')} forbids shared caching, so every merchant refetches your profile on every request. ${spec}.`,
    }
  }
  const maxAge = /max-age\s*=\s*(\d+)/.exec(cc)
  if (maxAge === null) {
    return {
      id,
      status: 'warn',
      detail: `${url} serves \`Cache-Control: ${cacheControl}\` with no max-age — ${spec}.`,
    }
  }
  const seconds = Number(maxAge[1])
  if (seconds < MIN_CACHE_SECONDS) {
    return {
      id,
      status: 'warn',
      detail: `${url} serves max-age=${seconds}, below the ${MIN_CACHE_SECONDS}s floor — ${spec}.`,
    }
  }
  if (!cc.includes('public')) {
    return {
      id,
      status: 'warn',
      detail: `${url} serves \`Cache-Control: ${cacheControl}\` — max-age is fine but the directive is not marked \`public\`. ${spec}.`,
    }
  }
  return { id, status: 'ok', detail: `${url} serves \`Cache-Control: ${cacheControl}\`` }
}

// Structural equality for parsed JSON. `JSON.stringify` comparison would make
// key order significant, which it is not for these documents.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (typeof a !== 'object') return false
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const aKeys = Object.keys(ao)
  if (aKeys.length !== Object.keys(bo).length) return false
  return aKeys.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]))
}
