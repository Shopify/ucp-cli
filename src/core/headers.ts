// Custom HTTP headers for UCP requests.
//
// Four priority sources merged into a single header bag per dispatch. Higher
// source wins on header-name conflict (case-insensitive). Sources not in
// conflict on a name all contribute. Empty string at any source unsets that
// header for the matching scope.
//
//   0. CLI built-in:  User-Agent: @shopify/ucp-cli/<version>   (lowest)
//   1. headers.json `default`            apply to every request from this profile
//   2. headers.json `businesses[<origin>]` per-origin add/override
//   3. --header 'Name: Value' flag                              (highest)
//
// One generic mechanism, no per-feature aliases. Bearer auth is just
// `--header 'Authorization: Bearer <token>'` like any other header. Persistent
// setup goes in headers.json; CI scripts pass their token via `--header`
// directly. We deliberately do not ship a `--auth-bearer` flag or a
// `UCP_AUTH_BEARER` env var — either would be one-keystroke sugar for the
// universal pattern at the cost of forever maintaining a per-auth-scheme
// surface that grows every time a merchant chooses a different scheme.
//
// The persistent file lives at ~/.ucp/profiles/<name>/headers.json so different
// profiles (= agent identities) can carry different merchant credentials. The
// `default` + `businesses` shape mirrors git's `[http]` and `[http "<URL>"]`
// model — one well-precedented pattern, not a new invention.
//
// Reserved transport headers (Content-Type, Accept, Host, Connection,
// hop-by-hop, MCP-Protocol-Version) are silently dropped from all
// user-controlled sources — those are framing-level concerns owned by the
// dispatcher, and overriding them would only ever break things. User-Agent is
// NOT reserved: the built-in default exists so merchants can identify ucp-cli
// traffic, but users may legitimately want to claim a different identity.
//
// Sensitive header values (`Authorization`, `Cookie`, suffixes `-Token`,
// `-Key`, `-Secret`, `-Password`) are redacted by {@link redactHeadersForLog}
// for verbose-mode tracing. The resolver itself does not log.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { profileStoreHome } from './profile-store.js'

/** Wire-shape header map. Names are emitted as last-set casing; HTTP is case-insensitive. */
export type HeaderMap = Record<string, string>

export interface ResolveHeadersOptions {
  /** Raw "Name: Value" strings from --header (repeatable). Parsed individually. */
  argFlags?: readonly string[] | undefined
  /**
   * Override env (test injection). Defaults to process.env. Only consulted for
   * `${VAR}` interpolation inside config values; no env var directly seeds a
   * header (see header comment for rationale).
   */
  env?: NodeJS.ProcessEnv | undefined
  /** Canonical "scheme://host[:port]" of the dispatch target. Used to select per-origin block. */
  origin: string
  /** Active profile name. If undefined, the headers.json file is not read. */
  profile?: string | undefined
  /** Override `~/.ucp/` (test injection). Defaults to UCP_HOME or homedir. */
  homeDir?: string | undefined
}

/**
 * Walk the four sources in priority order, return the merged header map.
 * Reserved headers are silently dropped; empty values unset. The built-in
 * User-Agent is always seeded as the lowest source so an unconfigured CLI
 * still identifies itself.
 */
export async function resolveHeaders(opts: ResolveHeadersOptions): Promise<HeaderMap> {
  const env = opts.env ?? process.env
  const bag = createBag()

  // Source 0: built-in.
  setHeader(bag, 'User-Agent', defaultUserAgent())

  // Sources 1 + 2: persistent file. Missing file is not an error; corrupt
  // file is — surfacing the parse/shape failure beats silently dispatching
  // without the headers the user thought were configured.
  if (opts.profile !== undefined && opts.profile.length > 0) {
    const file = await loadHeadersFile(opts.homeDir, opts.profile)
    if (file !== undefined) {
      applyHeadersToBag(bag, file.default ?? {}, env)
      const perOrigin = file.businesses?.[opts.origin]
      if (perOrigin !== undefined) {
        applyHeadersToBag(bag, perOrigin, env)
      }
    }
  }

  // Source 3: per-call --header flags.
  for (const raw of opts.argFlags ?? []) {
    const parsed = parseHeaderFlag(raw)
    setHeader(bag, parsed.name, parsed.value)
  }

  return mapFromBag(bag)
}

/** Build-time CLI version is the only legitimate moving part of the UA. */
export function defaultUserAgent(): string {
  return `@shopify/ucp-cli/${__CLI_VERSION__}`
}

/**
 * Parse one `-H` / `--header` argument. Split on the FIRST colon so values
 * containing colons (URLs, timestamps, base64 with padding) survive intact.
 * Whitespace around the name and value is trimmed; embedded whitespace in
 * the value is preserved.
 */
export function parseHeaderFlag(raw: string): { name: string; value: string } {
  const idx = raw.indexOf(':')
  if (idx === -1) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `--header expected "Name: Value", got: ${JSON.stringify(raw)}`,
    })
  }
  const name = raw.slice(0, idx).trim()
  const value = raw.slice(idx + 1).trim()
  validateHeaderName(name, '--header')
  validateHeaderValue(value, '--header')
  return { name, value }
}

/** True if the dispatcher owns this header — user sources can't set it. */
export function isReservedHeader(name: string): boolean {
  return RESERVED_HEADERS.has(name.toLowerCase())
}

/**
 * True if logging this header's value risks leaking a secret. Patterns:
 * exact match on `Authorization`, `Cookie`, `Proxy-Authorization`; suffix
 * match on `-token`, `-key`, `-secret`, `-password` (case-insensitive).
 *
 * Used by {@link redactHeadersForLog} for any future verbose/trace path.
 * Keep the rule case-insensitive on the suffix so `Api-Key`, `API-KEY`,
 * `api-key` all redact consistently.
 */
export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase()
  if (SENSITIVE_EXACT.has(lower)) return true
  return SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

/**
 * Build a logging-safe copy of headers with sensitive VALUES replaced by
 * `<redacted>`. Names are preserved verbatim so a verbose trace still tells
 * you which headers were attached, just not what the secret was.
 */
export function redactHeadersForLog(headers: HeaderMap): HeaderMap {
  const result: HeaderMap = {}
  for (const [name, value] of Object.entries(headers)) {
    result[name] = isSensitiveHeaderName(name) ? '<redacted>' : value
  }
  return result
}

/**
 * Render a one-line header trace suitable for `vlog`. Sensitive values are
 * already redacted by {@link redactHeadersForLog}; names are sorted so the
 * line is stable across runs (helps when grepping vlog output).
 *
 * Returns `"<none>"` for the empty bag rather than an empty string so the
 * trace is grep-able even when no headers were attached.
 */
export function formatHeadersForTrace(headers: HeaderMap): string {
  const entries = Object.entries(redactHeadersForLog(headers))
  if (entries.length === 0) return '<none>'
  entries.sort(([a], [b]) => a.localeCompare(b))
  return entries.map(([name, value]) => `${name}: ${value}`).join(', ')
}

/**
 * Canonicalize a URL string to `scheme://host[:port]`. Returns undefined if
 * the input isn't a parseable absolute URL. The result is the same form used
 * as a key under `businesses[]` in headers.json.
 */
export function canonicalizeOrigin(input: string): string | undefined {
  try {
    return new URL(input).origin
  } catch {
    return undefined
  }
}

// ─── internals ────────────────────────────────────────────────────────────

interface HeadersFile {
  default?: Record<string, string>
  businesses?: Record<string, Record<string, string>>
}

// Internal bag preserves case-insensitive lookup while remembering the
// last-set casing for emission. Map keyed by lower-cased name.
type HeaderBag = Map<string, { name: string; value: string }>

function createBag(): HeaderBag {
  return new Map()
}

function setHeader(bag: HeaderBag, name: string, value: string): void {
  if (isReservedHeader(name)) return
  const lower = name.toLowerCase()
  if (value.length === 0) {
    bag.delete(lower)
    return
  }
  bag.set(lower, { name, value })
}

function applyHeadersToBag(
  bag: HeaderBag,
  source: Record<string, string>,
  env: NodeJS.ProcessEnv,
): void {
  for (const [name, rawValue] of Object.entries(source)) {
    setHeader(bag, name, interpolate(rawValue, env))
  }
}

function mapFromBag(bag: HeaderBag): HeaderMap {
  const result: HeaderMap = {}
  for (const { name, value } of bag.values()) {
    result[name] = value
  }
  return result
}

// ${VAR_NAME} only — the same simple shell-style form used everywhere config
// values reference secrets. Unset variables become empty strings (which then
// trip the empty-unsets rule). Curly braces are required to keep the grammar
// unambiguous next to surrounding text.
const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function interpolate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_VAR_RE, (_, varName: string) => env[varName] ?? '')
}

// RFC 7230 token grammar. Matches every char allowed in a header field-name.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function validateHeaderName(name: string, source: string): void {
  if (name.length === 0) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `${source}: header name cannot be empty`,
    })
  }
  if (!HEADER_NAME_RE.test(name)) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `${source}: invalid header name ${JSON.stringify(name)} (RFC 7230 token chars only)`,
    })
  }
}

function validateHeaderValue(value: string, source: string): void {
  // CR/LF in a header value is the textbook HTTP request-splitting vector.
  if (/[\r\n]/.test(value)) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `${source}: header value cannot contain CR or LF`,
    })
  }
}

const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'accept',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'upgrade',
  'proxy-connection',
  'mcp-protocol-version',
])

const SENSITIVE_EXACT: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
])

const SENSITIVE_SUFFIXES = ['-token', '-key', '-secret', '-password']

// ─── headers.json loading ─────────────────────────────────────────────────

async function loadHeadersFile(
  homeDir: string | undefined,
  profile: string,
): Promise<HeadersFile | undefined> {
  const home = profileStoreHome({ ...(homeDir !== undefined && { homeDir }) })
  const path = join(home, 'profiles', profile, 'headers.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    // Missing file is the no-config path — not an error.
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `headers.json is not valid JSON: ${path}`,
      cause: err as Error,
    })
  }
  return validateHeadersFile(parsed, path)
}

function validateHeadersFile(parsed: unknown, path: string): HeadersFile {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `headers.json must be a JSON object: ${path}`,
    })
  }
  const obj = parsed as Record<string, unknown>

  // Reject unknown top-level keys so a typo in `default` doesn't silently
  // do nothing. Two known keys is a small surface; expanding it is a
  // deliberate code change.
  for (const key of Object.keys(obj)) {
    if (key !== 'default' && key !== 'businesses') {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message: `headers.json: unknown top-level key ${JSON.stringify(key)} (allowed: "default", "businesses"): ${path}`,
      })
    }
  }

  const result: HeadersFile = {}
  if ('default' in obj) {
    result.default = validateHeaderRecord(obj.default, `${path}: "default"`)
  }
  if ('businesses' in obj) {
    result.businesses = validateBusinessesMap(obj.businesses, path)
  }
  return result
}

function validateHeaderRecord(input: unknown, label: string): Record<string, string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `${label} must be a JSON object`,
    })
  }
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string') {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message: `${label}: header value for ${JSON.stringify(name)} must be a string`,
      })
    }
    validateHeaderName(name, label)
    validateHeaderValue(value, label)
    result[name] = value
  }
  return result
}

function validateBusinessesMap(
  input: unknown,
  path: string,
): Record<string, Record<string, string>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `headers.json: "businesses" must be a JSON object: ${path}`,
    })
  }
  const result: Record<string, Record<string, string>> = {}
  for (const [origin, headers] of Object.entries(input)) {
    if (!isBareOrigin(origin)) {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message: `headers.json: business key must be a bare origin (scheme://host[:port], no path/query/hash): ${JSON.stringify(origin)} in ${path}`,
      })
    }
    result[origin] = validateHeaderRecord(headers, `${path}: businesses[${JSON.stringify(origin)}]`)
  }
  return result
}

function isBareOrigin(input: string): boolean {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return false
  }
  // url.origin canonicalizes to "scheme://host[:port]" — anything past that
  // (path, query, hash, trailing slash) makes the input not bare.
  return url.origin === input
}
