// `ucp doctor` — local install health check.
//
// Verifies what can be answered locally, plus one GET per rendering of the
// resolved Profile — the same documents a Business reads when it dereferences
// the identity we advertise. Each check that doesn't yet have a feature
// behind it is deliberately omitted: an always-green check for a feature that
// doesn't ship trains users to ignore the output.
//
// Doctor resolves the SAME Profile commerce runs on, through the same
// {@link resolveSession}: `UCP_PROFILE`, `UCP_AGENT_PROFILE_URL`,
// `active.yaml`, and the managed/DIY classification of a local profile
// directory are decided in exactly one place, so doctor cannot report an
// identity no command would send. Doctor has no per-invocation `--profile` or
// `--profile-url` options; it diagnoses the environment and persisted session.
//
// A managed Profile publishes one rendering per installed release and the
// Business selects one of them at negotiation time — any of them. So the
// network pass audits EVERY installed rendering URL (once each, deduplicated)
// and still reports one Check per id: the worst severity wins and every line
// is labelled with the release it came from. A DIY Profile (including one
// whose URL is explicitly overridden) or URL-only ad-hoc Profile is a
// singleton, so its one URL is the whole audit.
//
// Returns a structured envelope so machine consumers (CI, agents) can
// pattern-match on individual checks. `ok` is the AND of all `fail` checks,
// which makes `fail` the ONLY machine-actionable severity: a consumer writing
// `if (result.ok)` never enumerates `checks` and never sees a warn. So
// anything that makes our requests wrong is a `fail`, and `warn` is reserved
// for state a human should know about but a build should not stop for.
// `ok: false` exits nonzero — see the `doctor` command in src/cli.ts.

import { access, constants, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  type AgentProfile,
  agentProfileRedirect,
  fetchAgentProfileLive,
  type LiveAgentProfile,
  type Profile,
} from '../core/agent.js'
import { MIN_CACHE_SECONDS } from '../core/cache.js'
import { type RefusedRedirect, usableRedirectTarget } from '../core/http-client.js'
import { isSupportedNodeVersion } from '../core/node-version.js'

import {
  activeSessionSchema,
  activeYamlPath,
  listProfiles,
  type ProfileStoreOptions,
  profileDir,
  profileStoreHome,
  profilesRoot,
  readActive,
  readUserProfile,
} from '../core/profile-store.js'
import { describeProxyState, proxyState } from '../core/proxy.js'
import { LATEST, RELEASES, SUPPORTED_VERSIONS, type Version } from '../core/releases.js'
import { ErrorCodes, isUcpError } from '../lib/errors.js'
import type { CtaBlock } from '../lib/types.js'
import { type ResolvedSession, resolveSession } from './session.js'

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
  // collapsing the session to the managed default.
  checks.push(await checkActive(storeOpts))

  // 4. The Profile every command runs on. Resolved, not reconstructed: a
  // fresh install has no local profile and runs on the Shopify-managed
  // Profile, while a NAMED profile that is missing or corrupt is a `fail`
  // that never falls back — selling under a different identity than the one
  // the operator selected is worse than not selling.
  const state = await resolveProfileState(storeOpts, env)
  checks.push(state.check)

  // 5. Outbound network configuration. Reports the proxy decision made at
  // boot, catching the otherwise-invisible state: proxy env present but
  // unusable, which looks exactly like an unreachable merchant. Ordered
  // before the network probe so a proxy misconfiguration reads as the cause
  // of the probe's failure.
  checks.push(checkProxy())

  // 6. The hosted renderings. Last because these are the only checks whose
  // failure is fully explained by the ones above (proxy, hosting, and which
  // Profile resolved at all).
  if (deps.skipNetwork !== true && state.hosted !== undefined) {
    checks.push(
      ...(await checkHostedRenderings(
        state.hosted.profile,
        state.hosted.audit,
        deps.fetch ?? fetch,
      )),
    )
  }

  const ok = checks.every((c) => c.status !== 'fail')
  return { ok, checks }
}

// Below the engines floor is a `fail`, not a warn: the contract is declared,
// and breakage arrives as cryptic dependency errors (on Node 18 the proxy
// dispatcher dies with "File is not defined"). A CI gate going red on an
// unsupported runtime is the check working as intended.
function checkRuntime(): Check {
  const version = process.versions.node
  const supported = isSupportedNodeVersion(version)
  return {
    id: 'runtime',
    status: supported ? 'ok' : 'fail',
    detail: supported
      ? `Node v${version}`
      : `Node v${version} — ucp requires Node >= ${__MIN_NODE_VERSION__}`,
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
  // readActive intentionally degrades every failure to {} for commerce. Read
  // the diagnostic copy directly so Doctor can distinguish a missing file and
  // an intentionally persisted {} from unreadable, malformed, or wrong-shaped
  // state without changing runtime fallback semantics.
  const path = activeYamlPath(opts)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { id: 'active-yaml', status: 'ok', detail: 'no active.yaml' }
    }
    return {
      id: 'active-yaml',
      status: 'warn',
      detail: `${path} could not be read: ${(err as Error).message}`,
    }
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    return {
      id: 'active-yaml',
      status: 'warn',
      detail: `${path} is malformed YAML: ${(err as Error).message}`,
    }
  }
  if (parsed === null || parsed === undefined) {
    return { id: 'active-yaml', status: 'warn', detail: `${path} is empty or truncated` }
  }
  const active = activeSessionSchema.safeParse(parsed)
  if (!active.success) {
    return {
      id: 'active-yaml',
      status: 'warn',
      detail: `${path} does not contain a valid session object`,
    }
  }
  if (Object.keys(active.data).length === 0) {
    return { id: 'active-yaml', status: 'ok', detail: `${path}: no stored selection` }
  }
  return { id: 'active-yaml', status: 'ok', detail: JSON.stringify(active.data) }
}

// ─── which Profile, and which document backs each rendering ──────────────
//
// Three shapes, and every remedy below turns on which one is in play,
// because they differ in what the reader can actually change:
//
//   managed   the bundled release documents, published by Shopify at their
//             own URLs. No local file declares them, so the remedies are
//             "upgrade ucp-cli" and "report the hosted change" — never
//             "upload your profile.json", which for an upgraded legacy
//             profile would mean uploading a stale document ucp-cli does not
//             even send.
//   authored  a DIY profile: `profiles/<name>/profile.json` IS the
//             declaration. `urlOverride` separately says whether its active
//             URL came from UCP_AGENT_PROFILE_URL rather than stored metadata.
//   adhoc     a scalar `UCP_AGENT_PROFILE_URL` pinning ONE bundled rendering
//             when no authored body applies. There is no local file to repair
//             — only the URL to fix or the override to drop.
type Audit =
  | { readonly mode: 'managed' }
  | {
      readonly mode: 'authored'
      readonly name: string
      readonly bodyPath: string
      readonly metaPath: string
      readonly urlOverride: boolean
    }
  | { readonly mode: 'adhoc' }

interface ProfileState {
  /** The `active-profile` check, whichever way resolution went. */
  check: Check
  /** What the network pass audits. Absent when resolution failed. */
  hosted?: { readonly profile: Profile; readonly audit: Audit }
}

async function resolveProfileState(
  opts: ProfileStoreOptions,
  env: Record<string, string | undefined>,
): Promise<ProfileState> {
  let session: ResolvedSession
  try {
    session = await resolveSession({ ...opts, env })
  } catch (err) {
    const envName = nonEmpty(env.UCP_PROFILE)
    const activeName =
      envName === undefined ? nonEmpty((await readActive(opts)).profile) : undefined
    const selection: FailedProfileSelection | undefined =
      envName !== undefined
        ? { name: envName, source: 'UCP_PROFILE' }
        : activeName !== undefined
          ? { name: activeName, source: 'active.yaml' }
          : undefined
    const alternatives =
      selection?.source === 'active.yaml'
        ? await readableAlternativeProfiles(selection.name, opts)
        : []
    return {
      check: {
        id: 'active-profile',
        status: 'fail',
        detail: profileResolutionFailureDetail(err, selection, env, alternatives),
      },
    }
  }
  const audit = auditFor(session, opts)
  return { check: checkActiveProfile(session, audit), hosted: { profile: session.profile, audit } }
}

type FailedProfileSelection =
  | { readonly name: string; readonly source: 'UCP_PROFILE' }
  | { readonly name: string; readonly source: 'active.yaml' }

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

async function readableAlternativeProfiles(
  selectedName: string,
  opts: ProfileStoreOptions,
): Promise<string[]> {
  const names = await listProfiles(opts)
  const readable = await Promise.all(
    names
      .filter((name) => name !== selectedName)
      .map(async (name) => {
        try {
          await readUserProfile(name, { ...opts, migrate: false })
          return name
        } catch {
          return undefined
        }
      }),
  )
  return readable.filter((name): name is string => name !== undefined)
}

// ─── remedies: reported, not reconstructed ───────────────────────────────
//
// A `UcpError.cta` is recovery POLICY, authored where the failure is
// understood: core/profile-store.ts knows which file it could not read and
// therefore whether a custom `profile_url` can survive a re-init;
// core/agent.ts knows an off-version `dev.ucp.*` entry is repaired by
// EDITING the entry, not by rewriting the document. Doctor is a reporter, so
// it formats the carried block instead of re-deriving one from the error's
// shape. Re-deriving is what silently downgraded the snapshot-rule remedy
// ("align every dev.ucp.* entry") into `profile init --force`, which
// discards the very document the operator authored.
//
// The fallback below therefore stays deliberately small: it covers only a
// failure that carries NO cta, and says nothing a `cta` would have said
// better.
function formattedFailureCta(err: unknown): string | undefined {
  if (!isUcpError(err) || err.cta === undefined) return undefined
  return nonEmpty(formatCta(err.cta))
}

// `ucp doctor` is a legitimate cta command elsewhere — it is how a caller
// compares a local document against the URL it is served from. Inside a
// Doctor check it is the command already running, so it is dropped from the
// rendered remedy; the cta's description and its other commands carry the
// repair. Dropping it unconditionally is what keeps doctor from ever
// offering itself as the only next step.
function isRecursiveDoctorCommand(command: string): boolean {
  const trimmed = command.trim()
  return trimmed === 'ucp doctor' || trimmed.startsWith('ucp doctor ')
}

// A cta command is either a bare command string or `{command, description}`
// (incur also allows `args`/`options`, which no CTA in this CLI uses — every
// command string here is already fully spelled out).
function ctaCommandText(entry: CtaBlock['commands'][number]): string | undefined {
  const command = typeof entry === 'string' ? entry : entry.command
  if (isRecursiveDoctorCommand(command)) return undefined
  const description = typeof entry === 'string' ? undefined : entry.description
  return description === undefined ? `\`${command}\`` : `\`${command}\` (${description})`
}

function formatCta(cta: CtaBlock): string {
  const commands = cta.commands
    .map((entry) => ctaCommandText(entry))
    .filter((text): text is string => text !== undefined)
  const description = nonEmpty(cta.description?.trim())
  return [
    description === undefined ? undefined : endsSentence(description),
    commands.length === 0 ? undefined : `Run ${commands.join(', or ')}.`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ')
}

function endsSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** The carried remedy, or the one thing that is true when none was carried. */
function repairGuidance(err: unknown, name: string): string {
  return (
    formattedFailureCta(err) ??
    `Fix the local files for "${name}", or re-create it with \`ucp profile init --name ${name} --force\` (this rewrites its local DIY document and metadata).`
  )
}

function profileResolutionFailureDetail(
  err: unknown,
  selection: FailedProfileSelection | undefined,
  env: Record<string, string | undefined>,
  alternativeProfiles: readonly string[],
): string {
  const failure = describeError(err)
  const profileUrlOverride = nonEmpty(env.UCP_AGENT_PROFILE_URL)

  // Within resolveSession, INVALID_INPUT after a readable selected Profile (or
  // with no selected name) can only come from parsing the env URL override.
  // Profile name/store/body failures retain their distinct stable codes and
  // therefore continue into the source-specific branches below.
  if (
    profileUrlOverride !== undefined &&
    isUcpError(err) &&
    err.code === ErrorCodes.INVALID_INPUT
  ) {
    return `${failure} — UCP_AGENT_PROFILE_URL is set to ${JSON.stringify(profileUrlOverride)}, and that override prevents Profile resolution. Remove it with \`unset UCP_AGENT_PROFILE_URL\`, or fix it to name a valid HTTPS Profile document URL.`
  }

  // An invalid NAME is not a repairable local Profile: no file is wrong, the
  // selection is. That remedy belongs to the source that supplied the name,
  // which is why it stays here rather than being read off the error.
  const invalidName = isUcpError(err) && err.code === ErrorCodes.PROFILE_INVALID_NAME

  if (selection?.source === 'UCP_PROFILE') {
    const repair = invalidName
      ? 'Fix UCP_PROFILE so it names a valid local Profile.'
      : repairGuidance(err, selection.name)
    return `${failure} — UCP_PROFILE selects local Profile "${selection.name}"; a named Profile is never silently replaced by the managed one. ${repair} Alternatively, remove the env selection with \`unset UCP_PROFILE\`. \`ucp profile use\` cannot override UCP_PROFILE while that environment variable remains set.`
  }

  if (selection?.source === 'active.yaml') {
    const repair = invalidName
      ? 'The selected name is invalid; edit active.yaml or clear it with `ucp profile use --managed`.'
      : repairGuidance(err, selection.name)
    const alternative =
      alternativeProfiles.length === 0
        ? 'inspect other local choices with `ucp profile list`'
        : `select another readable local Profile (${alternativeProfiles.map((name) => `\`ucp profile use ${name}\``).join(' or ')})`
    return `${failure} — active.yaml selects local Profile "${selection.name}"; a named Profile is never silently replaced by the managed one. ${repair} Otherwise ${alternative}, or return to the Shopify-managed Profile with \`ucp profile use --managed\`.`
  }

  const carried = formattedFailureCta(err)
  return `${failure} — the Shopify-managed Profile could not be resolved.${carried === undefined ? '' : ` ${carried}`} No profile initialization is required for managed use; upgrade ucp-cli or report this installation failure.`
}

// Body provenance and URL-override provenance are assigned independently at
// the acquisition seam. Doctor branches on both directly instead of
// re-deriving either from storage kind, URL equality, name, or body.
function auditFor(session: ResolvedSession, opts: ProfileStoreOptions): Audit {
  const { profile } = session
  if (profile.source === 'managed') return { mode: 'managed' }
  if (profile.source === 'url') return { mode: 'adhoc' }
  const name = profile.name
  if (name === undefined) return { mode: 'adhoc' }
  return {
    mode: 'authored',
    name,
    bodyPath: join(profileDir(name, opts), 'profile.json'),
    metaPath: join(profileDir(name, opts), 'meta.json'),
    urlOverride: profile.urlOverride,
  }
}

/**
 * The Profile's renderings in release order. A managed Profile has one per
 * installed release; a DIY or ad-hoc Profile has exactly one.
 */
function installedRenderings(profile: Profile): AgentProfile[] {
  return SUPPORTED_VERSIONS.map((version) => profile.renderings[version]).filter(
    (agent): agent is AgentProfile => agent !== undefined,
  )
}

function checkActiveProfile(session: ResolvedSession, audit: Audit): Check {
  const { profile } = session
  const renderings = installedRenderings(profile)

  if (audit.mode === 'managed') {
    // Named or not, a managed Profile sends the bundled documents. The name
    // only selects `headers.json` and how messages address this identity.
    const who =
      profile.name === undefined
        ? 'no local profile selected, so ucp-cli runs on the Shopify-managed Profile'
        : `profile "${profile.name}" is a Shopify-managed Profile`
    const local =
      profile.name === undefined
        ? 'No profile init is required. `ucp profile init` instead creates a release-pinned DIY Profile.'
        : 'Its historical local profile.json, when present, is retained for downgrade compatibility but is not what ucp-cli declares.'
    return {
      id: 'active-profile',
      status: 'ok',
      detail: `${who}: bundled renderings ${renderings.map((agent) => `UCP ${agent.version}: ${agent.url}`).join('; ')}. A Business selects one of them at negotiation, so all of them are ucp-cli's identity. ${local}`,
    }
  }

  // A singleton Profile with no rendering cannot happen (both factories
  // populate exactly one key) — reported rather than asserted so a future
  // regression surfaces as a check instead of a stack trace.
  const sole = renderings[0]
  if (sole === undefined) {
    return {
      id: 'active-profile',
      status: 'fail',
      detail: 'the resolved Profile has no installed rendering — this is a bug in ucp-cli',
    }
  }
  if (audit.mode === 'authored') {
    const detail = audit.urlOverride
      ? `profile "${audit.name}" is locally authored (DIY): UCP_AGENT_PROFILE_URL overrides its stored rendering URL, so ucp-cli advertises the exact UCP ${sole.version} body from ${audit.bodyPath} at ${sole.url}. Doctor audits that local authored body against the override URL. A DIY Profile remains a singleton. Upload local profile.json to the override URL after edits, or unset UCP_AGENT_PROFILE_URL to use the stored URL.`
      : `profile "${audit.name}" is locally authored (DIY): the UCP ${sole.version} document at ${audit.bodyPath}, advertised at ${sole.url}. A DIY Profile is a singleton — ucp-cli offers that one rendering and no other.`
    return { id: 'active-profile', status: 'ok', detail }
  }
  return {
    id: 'active-profile',
    status: 'ok',
    detail: `UCP_AGENT_PROFILE_URL pins one rendering${profile.name === undefined ? '' : ` (under local profile "${profile.name}")`}: ucp-cli declares the bundled UCP ${sole.version} document at ${sole.url}. Run \`unset UCP_AGENT_PROFILE_URL\` to use the Profile selected by normal session precedence.`,
  }
}

// ─── hosted-rendering checks ─────────────────────────────────────────────
//
// Four ids, one GET per distinct URL, one boundary between them:
//
//   `protocol`             can this URL be used as an identity, and does it
//                          serve the release ucp-cli renders there?
//   `profile-redirect`     is the document served without a hop?
//   `profile-cache-control` is it cacheable the way UCP requires?
//   `profile-drift`        does the rest of the document match ours?
//
// `protocol` is the one that carries correctness, and its severities follow
// consequence, not who owns the URL. The request path never reads the wire
// (core/agent.ts): ucp-cli declares a local document and advertises a URL.
// The Business is the side that dereferences that URL — it may cache the
// result, so a broken URL is not always an immediate hard failure, but a URL
// that cannot be read or serves a different `ucp.version` means the two sides
// disagree about who we are and nothing else in the CLI will ever notice.
// Both are `fail`, and the message names both versions.
//
// `profile-drift` is what remains once the versions agree: a declaration the
// Business will act on that differs from the one ucp-cli plans against.
// `warn`, because the requests we send are still well-formed and only `fail`
// gates the verdict.
//
// Aggregation: one Check per id no matter how many renderings were audited.
// Worst severity wins and each line is labelled `UCP <version>:`, so a
// managed Profile reports "which release is broken" instead of forcing
// consumers to learn new per-release check ids.
const HOSTED_CHECK_IDS = [
  'protocol',
  'profile-redirect',
  'profile-cache-control',
  'profile-drift',
] as const

type HostedCheckId = (typeof HOSTED_CHECK_IDS)[number]

interface Verdict {
  status: CheckStatus
  detail: string
}

type Probe = { readonly live: LiveAgentProfile } | { readonly error: unknown }

async function checkHostedRenderings(
  profile: Profile,
  audit: Audit,
  fetchImpl: typeof fetch,
): Promise<Check[]> {
  const parts: Record<HostedCheckId, Verdict[]> = {
    protocol: [],
    'profile-redirect': [],
    'profile-cache-control': [],
    'profile-drift': [],
  }
  const record = (id: HostedCheckId, version: Version, verdict: Verdict): void => {
    parts[id].push({ status: verdict.status, detail: `UCP ${version}: ${verdict.detail}` })
  }

  // Start one GET per distinct URL before awaiting any of them. The installed
  // rendering count bounds this fan-out; retaining release order here keeps
  // aggregation deterministic even when the probes settle out of order.
  const probesByUrl = new Map<string, Promise<Probe>>()
  const renderings = installedRenderings(profile).map((agent) => {
    let probe = probesByUrl.get(agent.url)
    if (probe === undefined) {
      probe = probeRendering(agent, fetchImpl)
      probesByUrl.set(agent.url, probe)
    }
    return { agent, probe }
  })

  for (const { agent, probe: pendingProbe } of renderings) {
    const probe = await pendingProbe
    if ('error' in probe) {
      // A refused redirect reports as `profile-redirect` and nothing else. It
      // is one fault with one remedy, and a `protocol` line beside it would
      // be a second, vaguer voice on the same GET. The verdict is identical
      // either way: both are `fail`.
      const redirect = agentProfileRedirect(probe.error)
      if (redirect !== undefined) {
        record('profile-redirect', agent.version, redirectVerdict(redirect, agent, audit))
        continue
      }
      // `fail`, not `warn`: the Business dereferences this URL to negotiate
      // with us. If it cannot be read, the Business cannot read it either.
      //
      // The detail must separate the sub-causes, because they have different
      // remedies. `fetchAgentProfileLive` already names them:
      // AGENT_PROFILE_UNREACHABLE carries `(network: …)` (DNS/TLS/connect/
      // timeout), `(http_status: HTTP …)`, or `(not_json: …)` in its message,
      // and a document that parsed but is not a usable identity arrives under
      // a distinct code (AGENT_PROFILE_SCHEMA_INVALID / _VERSION_UNSUPPORTED /
      // _VERSION_MISMATCH). So `code: message` is the full discrimination;
      // re-deriving it here would be a second copy that can drift.
      record('protocol', agent.version, { status: 'fail', detail: describeError(probe.error) })
      continue
    }

    const { live } = probe
    record('profile-redirect', agent.version, {
      status: 'ok',
      detail: `${agent.url} serves the document itself, with no redirect`,
    })
    record(
      'profile-cache-control',
      agent.version,
      cacheControlVerdict(live.cacheControl, agent.url),
    )

    // THE check. Both sides read a document; they must agree on its version
    // or we are negotiating as somebody the Business does not see. One voice
    // per fault: when the versions disagree, drift stays quiet.
    if (live.agent.version !== agent.version) {
      record('protocol', agent.version, versionMismatchVerdict(agent, live, audit))
      continue
    }
    record('protocol', agent.version, agreementVerdict(agent, audit))
    record('profile-drift', agent.version, driftVerdict(agent, live, audit))
  }

  return HOSTED_CHECK_IDS.map((id) => aggregate(id, parts[id])).filter(
    (check): check is Check => check !== undefined,
  )
}

async function probeRendering(agent: AgentProfile, fetchImpl: typeof fetch): Promise<Probe> {
  try {
    return {
      live: await fetchAgentProfileLive({
        url: agent.url,
        source: agent.source,
        urlOverride: agent.urlOverride,
        ...(agent.name !== undefined ? { name: agent.name } : {}),
        fetch: fetchImpl,
      }),
    }
  } catch (error) {
    return { error }
  }
}

/**
 * Collapse per-rendering verdicts into the single Check that id owns. An id
 * nobody had anything to say about is OMITTED rather than reported green: a
 * redirecting URL produces no `protocol` line, and inventing an `ok` for a
 * document we never read would be the false green this whole module exists
 * to avoid.
 */
function aggregate(id: HostedCheckId, verdicts: Verdict[]): Check | undefined {
  if (verdicts.length === 0) return undefined
  const status: CheckStatus = verdicts.some((v) => v.status === 'fail')
    ? 'fail'
    : verdicts.some((v) => v.status === 'warn')
      ? 'warn'
      : 'ok'
  return { id, status, detail: verdicts.map((v) => v.detail).join('\n') }
}

/** `protocol` ok: the URL is readable and serves the release we render there. */
function agreementVerdict(agent: AgentProfile, audit: Audit): Verdict {
  if (audit.mode === 'managed') {
    return {
      status: 'ok',
      detail: `${agent.url} serves the bundled UCP ${agent.version} document ucp-cli offers (checked live)`,
    }
  }
  if (audit.mode === 'adhoc') {
    return {
      status: 'ok',
      detail: `${agent.url} serves UCP ${agent.version}, the bundled document ucp-cli declares there (checked live); UCP_AGENT_PROFILE_URL pins this one rendering`,
    }
  }
  if (audit.urlOverride) {
    return {
      status: 'ok',
      detail: `profile "${audit.name}" uses the locally authored UCP ${agent.version} body at ${audit.bodyPath}; UCP_AGENT_PROFILE_URL advertises it at ${agent.url}, which serves the same version (checked live). Upload local profile.json to the override URL after edits, or unset UCP_AGENT_PROFILE_URL to use the stored URL.`,
    }
  }
  const latest = agent.version === LATEST
  return {
    status: 'ok',
    detail: [
      `profile "${audit.name}" uses UCP ${agent.version}`,
      `from ${audit.bodyPath}, sent as ${agent.url},`,
      `which serves the same version (checked live);`,
      `ucp-cli supports ${SUPPORTED_VERSIONS.join(', ')} —`,
      // An older supported release is VALID, not a problem: ucp-cli supports
      // a set of releases, not a floor. So this is a note with a command,
      // never a warn — a red doctor for a deliberately pinned profile would
      // train users to ignore the output.
      latest
        ? 'this is the latest.'
        : `NOT the latest (${LATEST}). Still fully supported; to move, \`ucp profile init --name ${audit.name} --version ${LATEST} --force\` REWRITES ${audit.bodyPath} as the published UCP ${LATEST} document (discarding local edits). A custom meta.profile_url (${audit.metaPath}) is preserved and must serve the rewritten document; an existing Shopify release-default URL rotates to ${RELEASES[LATEST].defaultAgentProfileUrl}.`,
    ].join(' '),
  }
}

/** `protocol` fail: the URL is readable but serves another release. */
function versionMismatchVerdict(
  agent: AgentProfile,
  live: LiveAgentProfile,
  audit: Audit,
): Verdict {
  const served = live.agent.version
  if (audit.mode === 'managed') {
    // No local document declares a managed rendering, so nothing the reader
    // can upload fixes this — and the stale profile.json an upgraded legacy
    // profile still has on disk is exactly the wrong thing to suggest.
    return {
      status: 'fail',
      detail: `${agent.url} serves UCP ${served}, but that URL is where ucp-cli's bundled UCP ${agent.version} rendering is published — a Business that selects UCP ${agent.version} reads UCP ${served} instead, so that rendering can never negotiate. ucp-cli sends the bundled document, so there is nothing local to change: upgrade ucp-cli (\`npm install -g @shopify/ucp-cli@latest\`) to pick up a build whose snapshot matches, and report the change if that URL is meant to be frozen at UCP ${agent.version}.`,
    }
  }
  if (audit.mode === 'adhoc') {
    return {
      status: 'fail',
      detail: `${agent.url} serves UCP ${served}, but UCP_AGENT_PROFILE_URL pins ucp-cli to the bundled UCP ${agent.version} document — the Business reads UCP ${served} while ucp-cli negotiates as UCP ${agent.version}. Serve the UCP ${agent.version} document at that URL, or unset UCP_AGENT_PROFILE_URL to use the published rendering at ${RELEASES[agent.version].defaultAgentProfileUrl}.`,
    }
  }
  if (audit.urlOverride) {
    return {
      status: 'fail',
      detail: `${agent.url} serves UCP ${served}, but the locally authored profile.json at ${audit.bodyPath} declares UCP ${agent.version}; UCP_AGENT_PROFILE_URL makes that override URL active, so the Business and ucp-cli see different versions. Upload local profile.json to the override URL ${agent.url} (from ${audit.bodyPath}), or unset UCP_AGENT_PROFILE_URL to use the stored rendering URL.`,
    }
  }
  return {
    status: 'fail',
    detail: `${agent.url} serves UCP ${served}, but ucp-cli negotiates as UCP ${agent.version} — the version in ${audit.bodyPath}, the document it declares. The Business reads the URL, so it sees UCP ${served} while ucp-cli speaks UCP ${agent.version}. Make them agree: \`ucp profile init --name ${audit.name} --version ${served} --force\` REWRITES ${audit.bodyPath} as the published UCP ${served} document (discarding local edits); or upload ${audit.bodyPath} to ${agent.url} when that URL is yours; or point meta.profile_url (${audit.metaPath}) at a URL serving UCP ${agent.version}.`,
  }
}

// Deep equality on parsed JSON, not bytes: `profile init` re-serializes the
// published document with its own indentation, so a byte compare would flag
// every clean install. Key ORDER differences are likewise not drift — the
// documents are JSON objects, and no UCP reader depends on member order.
// `agent.body` rather than a re-read of the store: it is the exact object
// negotiation runs against (bundled for managed/ad-hoc, the local file for
// DIY), parsed by the same release schema as the fetched one, so neither
// side of the comparison can pick up a stray default.
function driftVerdict(agent: AgentProfile, live: LiveAgentProfile, audit: Audit): Verdict {
  const matches = deepEqual(agent.body as unknown, live.agent.body as unknown)
  if (audit.mode === 'managed') {
    return matches
      ? { status: 'ok', detail: `${agent.url} matches the bundled UCP ${agent.version} document` }
      : {
          status: 'warn',
          detail: `${agent.url} serves a document that differs from the bundled UCP ${agent.version} rendering ucp-cli declares (the versions agree). A Business acts on what that URL serves while ucp-cli plans against the bundled copy, so a capability one side has is not one the other will use. No local file declares this document — upgrade ucp-cli to pick up a refreshed snapshot, and report the drift if that URL is meant to be frozen at UCP ${agent.version}.`,
        }
  }
  if (audit.mode === 'adhoc') {
    return matches
      ? {
          status: 'ok',
          detail: `${agent.url} matches the bundled UCP ${agent.version} document ucp-cli declares there`,
        }
      : {
          status: 'warn',
          detail: `${agent.url} serves a document that differs from the bundled UCP ${agent.version} document ucp-cli declares there (the versions agree). Serve the bundled document published at ${RELEASES[agent.version].defaultAgentProfileUrl} at the URL you pinned, or unset UCP_AGENT_PROFILE_URL to use that published rendering directly.`,
        }
  }
  if (audit.urlOverride) {
    return matches
      ? {
          status: 'ok',
          detail: `local profile.json at ${audit.bodyPath} matches the active UCP_AGENT_PROFILE_URL override ${agent.url}`,
        }
      : {
          status: 'warn',
          detail: `${agent.url} serves a document that differs from the locally authored profile.json at ${audit.bodyPath} beyond ucp.version (the versions agree). The Business acts on the override URL while ucp-cli plans against the editable local body. Upload local profile.json to the override URL ${agent.url} (from ${audit.bodyPath}), or unset UCP_AGENT_PROFILE_URL to use the stored rendering URL.`,
        }
  }
  return matches
    ? { status: 'ok', detail: `local profile.json matches ${agent.url}` }
    : {
        status: 'warn',
        detail: `${agent.url} serves a document that differs from ${audit.bodyPath} beyond ucp.version (the versions agree). The business acts on what that URL serves; ucp-cli plans against the local file — so a capability you added locally is not one the business will grant, and one it grants is not one ucp-cli will use. Choose which document is authoritative: upload ${audit.bodyPath} to ${agent.url} when that URL is yours; edit ${audit.bodyPath} to match what the URL serves; or point meta.profile_url (${audit.metaPath}) at a URL that serves the local document.`,
      }
}

/** `code: message` for a UcpError, plain message otherwise. */
function describeError(err: unknown): string {
  return isUcpError(err) ? `${err.code}: ${err.message}` : (err as Error).message
}

// Hosting rule 2 on the profile URL — the pair to cacheControlVerdict's rule
// 3 below, reported from the same single GET.
//
// UCP overview §"Profile Requirements / Hosting": profile endpoints MUST NOT
// use redirects (3xx), repeated in the fetching rules for every URL an
// exchange dereferences.
//
// Who hits it, precisely: doctor is the only part of ucp-cli that fetches
// this URL (fetchAgentProfileLive), and it refused the hop itself via
// `ucpFetch`. Commerce requests do not fetch it — they advertise it in
// `meta.ucp-agent.profile`, and a conforming business dereferencing it is
// independently bound by the same MUST NOT, so it cannot resolve the agent
// identity and the request cannot negotiate. Local commands (`profile list`,
// `profile show`) are untouched.
//
// `fail`, unlike the cache-control advisory: a redirecting profile URL is
// unreadable to the business the URL exists for, and only `fail` gates
// doctor's verdict.
function redirectVerdict(redirect: RefusedRedirect, agent: AgentProfile, audit: Audit): Verdict {
  const spec = 'UCP forbids redirects (3xx) on published profiles'
  const target =
    redirect.location === null ? 'no `Location` header' : `\`Location: ${redirect.location}\``
  return {
    status: 'fail',
    detail: `${agent.url} answers HTTP ${redirect.status} with ${target} — ${spec}. Doctor is the only part of ucp-cli that fetches this URL, and it refused the hop rather than following it; commerce requests only advertise the URL, and a conforming business dereferencing it is bound by the same rule, so it cannot resolve your identity and those requests cannot negotiate. Local profile commands (\`ucp profile list\`, \`ucp profile show\`) are unaffected. ${redirectRemedy(redirect, agent, audit)}`,
  }
}

function redirectRemedy(redirect: RefusedRedirect, agent: AgentProfile, audit: Audit): string {
  const destination = usableRedirectTarget(agent.url, redirect.location)
  if (audit.mode === 'managed') {
    // That URL is Shopify's published rendering, so "serve it yourself" is
    // not a remedy the reader has. Naming the hop still matters: it is what
    // gets reported.
    return `That URL publishes ucp-cli's bundled UCP ${agent.version} rendering, so it is not yours to serve: upgrade ucp-cli in case a newer build renders that release elsewhere, and report the redirect.`
  }
  // Profile URLs are https, so an http `Location` can never be the URL to
  // advertise — the remedy must not offer it.
  const advertise =
    audit.mode === 'authored' && !audit.urlOverride
      ? (url: string) => `point meta.profile_url (${audit.metaPath}) at ${url}`
      : (url: string) => `point UCP_AGENT_PROFILE_URL at ${url}`
  if (destination !== null) {
    return `Serve the document at ${agent.url} itself, or ${advertise(destination)} once that URL serves the document.`
  }
  if (redirect.location === null) {
    return `Serve the document at ${agent.url} itself, or ${advertise('a URL that does')}.`
  }
  return `Serve the document at ${agent.url} itself, over https. Profile URLs are https, so the target named here cannot be advertised either.`
}

// Hosting advisory on the profile URL.
//
// UCP overview §"Profile Requirements / Hosting": published artifacts MUST
// carry `Cache-Control: public` with `max-age` of at least 60 seconds and
// MUST NOT be served `private`/`no-store`/`no-cache`. That rule exists
// because a Business dereferences this URL to negotiate and caches what it
// gets; a document served uncacheable turns that into an origin hit per
// exchange, and is the first thing to look at when a merchant rate-limits
// discovery.
//
// `warn`, not `fail`: it degrades the merchant's fetch pattern, not this
// install's ability to transact, and doctor's `ok` gates CI. Reported for
// every URL — the header is a fact about the identity this profile presents,
// and reporting it only sometimes would make its absence ambiguous.
function cacheControlVerdict(cacheControl: string | null, url: string): Verdict {
  const spec = 'UCP requires `Cache-Control: public, max-age>=60` on published profiles'
  if (cacheControl === null) {
    return { status: 'warn', detail: `${url} serves no Cache-Control header — ${spec}.` }
  }
  const cc = cacheControl.toLowerCase()
  const forbidden = ['no-store', 'no-cache', 'private'].filter((d) => cc.includes(d))
  if (forbidden.length > 0) {
    return {
      status: 'warn',
      detail: `${url} serves \`Cache-Control: ${cacheControl}\` — ${forbidden.join(', ')} forbids shared caching, so a merchant cannot reuse a cached copy and refetches your profile every time it needs your identity. ${spec}.`,
    }
  }
  const maxAge = /max-age\s*=\s*(\d+)/.exec(cc)
  if (maxAge === null) {
    return {
      status: 'warn',
      detail: `${url} serves \`Cache-Control: ${cacheControl}\` with no max-age — ${spec}.`,
    }
  }
  const seconds = Number(maxAge[1])
  if (seconds < MIN_CACHE_SECONDS) {
    return {
      status: 'warn',
      detail: `${url} serves max-age=${seconds}, below the ${MIN_CACHE_SECONDS}s floor — ${spec}.`,
    }
  }
  if (!cc.includes('public')) {
    return {
      status: 'warn',
      detail: `${url} serves \`Cache-Control: ${cacheControl}\` — max-age is fine but the directive is not marked \`public\`. ${spec}.`,
    }
  }
  return { status: 'ok', detail: `${url} serves \`Cache-Control: ${cacheControl}\`` }
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
