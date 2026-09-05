// Proxy support for outbound HTTP on corporate/sandboxed networks.
//
// Node's built-in `fetch` ignores `https_proxy` / `http_proxy` / `no_proxy`
// unless the process was started with `--use-env-proxy` (Node >= 22.21 /
// >= 24.5); the switch cannot be enabled from inside the process, and global
// http(s) agents do not affect `fetch()`. Installing an undici dispatcher
// that reads the same env contract is the one in-process fix. Without it, a
// proxied box stalls for the request timeout and reports a bare `fetch
// failed` — indistinguishable from a dead merchant.
//
// The dispatcher is installed only when a proxy var is set:
//   - a routine undici bump must not silently change the transport under
//     checkout for the majority who have no proxy;
//   - the undici import is ~1/3 of CLI cold start, and agents invoke the
//     CLI several times per session.
//
// Env-var precedence and the no_proxy grammar are undici's, not ours; this
// module answers only "is a proxy configured?" and reports what it saw. The
// resulting divergences from curl (no ALL_PROXY, no CIDR in no_proxy,
// scheme-less values rejected, socks5 untested) are documented in README
// "Proxies and TLS inspection".
//
// State is module-scoped like verbose.ts: a process-lifetime property
// decided once at boot. `bin.ts` installs; doctor and transport error paths
// read.

import { isSupportedNodeVersion } from './node-version.js'

/**
 * Logical variable names, matched case-insensitively against the actual env
 * keys — never probed as fixed-name properties. Windows env vars are
 * case-insensitive on property access, so checking `https_proxy` and
 * `HTTPS_PROXY` separately reports one OS variable twice; enumerating real
 * keys reports each variable exactly once with the casing the user set, on
 * every platform. Precedence between variants is undici's job.
 *
 * `no_proxy` is reported for context but never a trigger on its own — with
 * no proxy configured it has nothing to exclude.
 */
const TRIGGER_NAMES = ['https_proxy', 'http_proxy'] as const
const PROXY_NAMES = [...TRIGGER_NAMES, 'no_proxy'] as const

export type ProxyStatus = 'inactive' | 'active' | 'error'

export interface ProxyState {
  /**
   * `inactive` — no usable proxy env; direct connections (the common path).
   * `active` — dispatcher installed; requests are subject to the proxy env.
   * `error` — proxy env present but unusable, so requests went direct. Must
   * never be silent: it looks exactly like a broken merchant.
   */
  status: ProxyStatus
  /** Redacted `name=value` for every proxy-related var present in the env. */
  vars: string[]
  /** Failure reason. Present only when `status === 'error'`. */
  error?: string
}

/**
 * The undici surface we use, typed structurally so tests can inject a plain
 * object double without constructing a real agent.
 */
interface UndiciProxySupport {
  EnvHttpProxyAgent: new () => unknown
  setGlobalDispatcher: (dispatcher: unknown) => void
}

export interface ProxyInstallOptions {
  /**
   * Injectable undici loader; defaults to a dynamic import so the no-proxy
   * path never loads undici. Tests use it to assert exactly that, and to
   * simulate undici missing from a broken install.
   */
  load?: () => Promise<UndiciProxySupport>
}

// null until the installer runs. "Not initialized" must stay distinguishable
// from "initialized, found nothing": rendering the latter for the former
// would claim a clean environment on a proxied box.
let state: ProxyState | null = null

const loadUndici = (): Promise<UndiciProxySupport> =>
  import('undici') as unknown as Promise<UndiciProxySupport>

/**
 * Proxy state decided at boot. Before the installer runs, reports the env
 * as it actually is with nothing installed.
 */
export function proxyState(): ProxyState {
  return state ?? { status: 'inactive', vars: describeProxyVars() }
}

/**
 * Detect proxy env and, when present, install undici's `EnvHttpProxyAgent`
 * as the process-global fetch dispatcher.
 *
 * Must be called from `bin.ts` only: `index.ts` declares `"sideEffects":
 * false`, so importing the library must never mutate the global dispatcher.
 *
 * Never throws — a malformed `https_proxy` must not stop `ucp --version`.
 * Failures land in `status: 'error'` and surface through `ucp doctor` and
 * transport-error messages.
 */
export async function installProxyDispatcher(opts: ProxyInstallOptions = {}): Promise<ProxyState> {
  const vars = describeProxyVars()
  if (!hasProxyConfigured()) {
    state = { status: 'inactive', vars }
    return state
  }
  try {
    const undici = await (opts.load ?? loadUndici)()
    // No-arg construction: the agent reads process.env itself, keeping a
    // single implementation of the env contract in play.
    undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent())
    state = { status: 'active', vars }
  } catch (err) {
    // Redact the failure text too: it reaches doctor output and error
    // envelopes, and undici embedding the proxy URI someday must not leak.
    //
    // Below the engines floor the failure can be the import itself when a
    // dependency references globals older Node lacks, and the raw error
    // ("File is not defined") does not name the actual problem. Annotate with
    // the version rather than pre-checking globals, which would couple us to
    // dependency internals.
    const nodeVersion = process.versions.node
    const versionHint = !isSupportedNodeVersion(nodeVersion)
      ? ` (Node v${nodeVersion}; ucp requires Node >= ${__MIN_NODE_VERSION__})`
      : ''
    state = { status: 'error', vars, error: redactProxyValue((err as Error).message) + versionHint }
  }
  return state
}

/**
 * Proxy annotation for transport-error `context`; `undefined` when no proxy
 * is configured, so the common path adds nothing to error envelopes.
 *
 * `context` does not reach the CLI envelope today — incur emits only
 * `{code, message, retryable}` (see core/operation.ts). Set for parity with
 * other transport errors and for when passthrough lands;
 * {@link proxyErrorNote} is what a user or agent actually sees.
 */
export function proxyErrorContext(): { proxy: ProxyState } | undefined {
  const current = proxyState()
  return current.status === 'inactive' ? undefined : { proxy: current }
}

/**
 * Message suffix for transport failures; empty when no proxy is configured.
 * Lives in the message because incur drops `context` (see
 * {@link proxyErrorContext}) — and without it a proxy failure and an
 * unreachable merchant render identically.
 */
export function proxyErrorNote(): string {
  return proxyState().status === 'inactive' ? '' : ` [proxy: ${describeProxyState()}]`
}

/**
 * One-line human summary. Rendered by the verbose trace, `ucp doctor`, and
 * transport-error messages. Names the variables, not the implementation:
 * "which env var did the CLI pick up, and is my traffic subject to it" is
 * the actionable information; the library doing the routing is not.
 */
export function describeProxyState(): string {
  // Reachable only if the bin.ts install call is bypassed. Say so rather
  // than render an environment claim nothing verified.
  if (state === null) return 'state unknown (proxy setup did not run)'
  const { status, vars, error } = state
  const seen = vars.length === 0 ? '' : ` (${vars.join(', ')})`
  switch (status) {
    case 'active':
      // "enabled", not "routing": nothing here has exercised the proxy. A
      // dead or 407-ing proxy still reaches this branch.
      return `enabled${seen}`
    case 'error':
      return `set but unusable: ${error} — connecting directly${seen}`
    default:
      return vars.length === 0
        ? 'none configured; connecting directly'
        : `none usable; connecting directly${seen}`
  }
}

/**
 * True when at least one trigger var holds a non-blank value. Blank counts
 * as unset: `export https_proxy=` is the common disable idiom, and a
 * whitespace-only value makes `new EnvHttpProxyAgent()` throw — a typo must
 * not become a total outage.
 */
function hasProxyConfigured(): boolean {
  return proxyEnvEntries().some(
    ([key, value]) =>
      (TRIGGER_NAMES as readonly string[]).includes(key.toLowerCase()) && value.trim() !== '',
  )
}

/**
 * Actual proxy-related env entries, each underlying variable exactly once
 * (see {@link PROXY_NAMES}). Sorted by logical name then lowercase-first so
 * rendered output is deterministic regardless of env-block order.
 */
function proxyEnvEntries(): Array<[string, string]> {
  const rank = (key: string): number => PROXY_NAMES.indexOf(key.toLowerCase() as never)
  // Within one logical name, exact-lowercase sorts first — that is the
  // variant undici actually prefers, so display order mirrors precedence.
  const caseRank = (key: string): number => (key === key.toLowerCase() ? 0 : 1)
  return Object.entries(process.env)
    .filter(
      (entry): entry is [string, string] => rank(entry[0]) !== -1 && typeof entry[1] === 'string',
    )
    .sort(([a], [b]) => rank(a) - rank(b) || caseRank(a) - caseRank(b))
}

/** Reset for tests. Restores the pre-install state; installs nothing. */
export function resetProxyStateForTests(): void {
  state = null
}

/** Redacted `name=value` for each proxy-related var present in the env. */
function describeProxyVars(): string[] {
  return proxyEnvEntries().map(([key, value]) => `${key}=${redactProxyValue(value)}`)
}

/**
 * Strip the password from a proxy value before it reaches doctor output, the
 * verbose trace, or an error message: `http://user:pw@proxy:8080` →
 * `http://user:***@proxy:8080`. The username is kept — useful for debugging
 * and not the secret.
 *
 * Never parse this with `new URL()`. The parser *succeeds* on the
 * scheme-less `user:pw@host:port` form curl accepts — reading `user:` as the
 * scheme and leaving `url.password` empty while the password sits in plain
 * sight — and a parse failure on a malformed value (the values most in need
 * of printing) must never cause a verbatim echo. Hence the index scan over
 * the raw string; the shapes that leaked past earlier versions are pinned in
 * proxy.test.ts.
 */
function redactProxyValue(value: string): string {
  // Trim first: leading whitespace must not slide a password past the scan.
  const trimmed = value.trim()
  const schemeEnd = trimmed.indexOf('://')
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3
  const pathStart = trimmed.indexOf('/', authorityStart)
  const authorityEnd = pathStart === -1 ? trimmed.length : pathStart
  // LAST '@' in the authority: a doubled userinfo is malformed but still
  // printed, and stopping at the first '@' would expose what follows.
  const at = trimmed.lastIndexOf('@', authorityEnd)
  if (at === -1) return trimmed
  const userinfo = trimmed.slice(authorityStart, at)
  // `%3A` is username content per WHATWG URL, not a separator — but whoever
  // wrote it meant a separator, and over-redacting a username is cheaper
  // than printing a password.
  const separator = userinfo.search(/:|%3a/i)
  // No separator means username-only; the username is not the secret.
  if (separator === -1) return trimmed
  return `${trimmed.slice(0, authorityStart)}${userinfo.slice(0, separator)}:***@${trimmed.slice(at + 1)}`
}
