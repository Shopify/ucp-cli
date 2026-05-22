// Generic fetch + on-disk cache primitive.
//
// Used by modules that fetch UCP artifacts, such as business profiles and
// tools/list responses. This module owns cache-entry envelope shape,
// URL-origin cache naming, Cache-Control TTL parsing, and the shared fetch
// timeout/error-mapping behavior.
//
// Callers own three things this primitive should not know: which cache
// subdirectory to use, which schema (if any) validates the body, and which
// UCP error codes should be surfaced for that artifact type. Callers also
// validate protocol-specific URL rules before passing externally supplied URLs
// here; the cache layer only canonicalizes already-accepted origins.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { z } from 'incur'

import { type ErrorCode, UcpError } from '../lib/errors.js'
import type { ErrorLayer } from '../lib/types.js'
import { formatZodIssues } from '../lib/zod-format.js'
import { ucpFetch } from './http-client.js'
import { vlog } from './verbose.js'

/**
 * STABLE — UCP minimum cache TTL per spec. Servers advertising a smaller
 * `Cache-Control: max-age` are silently clamped to this floor.
 */
export const MIN_CACHE_SECONDS = 60

/** Default per-request fetch timeout when caller doesn't override. */
const DEFAULT_TIMEOUT_MS = 30_000

// ─── Path helpers ────────────────────────────────────────────────────────

/** Resolve `$UCP_HOME` (or `~/.ucp` if unset). Cache callers compose subdirs. */
export function ucpHomeDir(): string {
  return process.env.UCP_HOME ?? join(homedir(), '.ucp')
}

/**
 * Derive a filesystem-safe cache filename from a URL's origin.
 *
 * IPv6 hosts (`https://[::1]:8443`) and any other origin containing
 * characters outside `[a-z0-9._-]` deliberately fall through to the
 * `sha256(origin)` branch: brackets are filesystem-questionable on
 * Windows, and a stable hex digest is uniformly safe across platforms.
 *
 * @param input  URL string or parsed URL.
 * @returns      Filename WITHOUT the `.json` extension.
 */
export function originToFilename(input: string | URL): string {
  const url = typeof input === 'string' ? new URL(input) : input
  const noScheme = url.origin.replace(/^https?:\/\//, '')
  const safe = noScheme.replace(/:/g, '_')
  if (!/^[a-z0-9._-]+$/.test(safe)) {
    return createHash('sha256').update(url.origin).digest('hex')
  }
  return safe
}

/**
 * Parse `max-age` from a `Cache-Control` header, applying the UCP
 * 60-second floor. Returns `null` for `no-store` (must not cache).
 */
export function parseMaxAge(
  cacheControl: string | null | undefined,
  minSeconds = MIN_CACHE_SECONDS,
): number | null {
  if (cacheControl === null || cacheControl === undefined) return minSeconds
  const cc = cacheControl.toLowerCase()
  if (/(^|,)\s*no-store\s*(,|$)/.test(cc)) return null
  const m = /max-age\s*=\s*(\d+)/.exec(cc)
  const maxAge = m === null ? minSeconds : Number(m[1])
  return Math.max(maxAge, minSeconds)
}

// ─── Cache envelope ──────────────────────────────────────────────────────

/**
 * The on-disk cache file shape. Generic over the body type — the body
 * is stored as `unknown` and re-validated against the caller's schema
 * (if any) at read time.
 */
export const cacheEntrySchema = z.object({
  url: z.string(),
  fetched_at: z.number(),
  expires_at: z.number(),
  body: z.unknown(),
})

export type CacheEntry<T = unknown> = {
  url: string
  fetched_at: number
  expires_at: number
  body: T
}

// ─── fetchCached primitive ───────────────────────────────────────────────

export interface FetchCachedErrorCodes {
  /** Code for non-2xx HTTP responses. */
  fetchFailed: ErrorCode
  /** Code when the response body isn't valid JSON. */
  invalidJson: ErrorCode
  /** Code when the body parses as JSON but fails the supplied schema. Required when `schema` is set. */
  schemaInvalid?: ErrorCode
}

export interface FetchCachedOptions<T = unknown> {
  /**
   * Directory where the cache file lives. Caller composes (e.g.
   * `join(ucpHomeDir(), 'cache', 'businesses')`).
   */
  cacheDir: string
  /**
   * Optional Zod schema applied to the parsed body. When provided, the
   * primitive validates and returns `T`. When omitted, returns `unknown`.
   */
  schema?: z.ZodType<T>
  /** Error codes to use for fetch / JSON / schema failures. */
  errorCodes: FetchCachedErrorCodes
  /** Layer to stamp on thrown UcpErrors. Default `'transport'`. */
  errorLayer?: ErrorLayer
  /** Skip the cache read; cache is still written on a successful fetch. */
  force?: boolean
  /** Injectable fetch (tests). */
  fetch?: typeof fetch
  /** AbortSignal forwarded to fetch (composed with `timeoutMs`). */
  signal?: AbortSignal
  /** Per-request timeout in milliseconds. Default 30 s. */
  timeoutMs?: number
  /**
   * Additional outbound headers (auth, tenancy, etc). Spread between the
   * built-in User-Agent default and the framing `Accept` header, so a
   * caller-supplied User-Agent overrides the built-in but no source can
   * clobber the dispatcher's `Accept`. Reserved-header filtering is the
   * caller's responsibility (see {@link resolveHeaders}).
   */
  headers?: Record<string, string>
}

/**
 * Fetch a URL with an on-disk cache. Reads cache first when fresh, fetches
 * + writes on miss/expiry. Filename is derived from `URL.origin`; cache
 * envelope is the {@link cacheEntrySchema} shape.
 *
 * Throws `UcpError(layer, code, ...)` on every failure mode using the
 * caller-supplied codes.
 */
export async function fetchCached<T = unknown>(
  url: string,
  options: FetchCachedOptions<T>,
): Promise<T> {
  const layer: ErrorLayer = options.errorLayer ?? 'transport'
  const cachePath = join(options.cacheDir, `${originToFilename(url)}.json`)

  if (options.force !== true) {
    const cached = await readCachedBody<T>(cachePath, options.schema)
    if (cached !== null && cached.expires_at > Date.now()) {
      vlog(
        `cache: HIT ${cachePath} (expires in ${Math.max(0, Math.round((cached.expires_at - Date.now()) / 1000))}s)`,
      )
      return cached.body
    }
  }
  vlog(`cache: MISS ${cachePath}${options.force === true ? ' (force)' : ''} → fetch ${url}`)

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, options.signal])

  let response: Response
  try {
    response = await ucpFetch(url, {
      ...(options.headers !== undefined && { headers: options.headers }),
      framing: { Accept: 'application/json' },
      signal,
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      traceLabel: 'cache',
    })
  } catch (err) {
    throw new UcpError({
      layer,
      code: options.errorCodes.fetchFailed,
      message: `fetch failed: request to ${url} could not be completed`,
      cause: err as Error,
      retryable: true,
    })
  }

  if (!response.ok) {
    throw new UcpError({
      layer,
      code: options.errorCodes.fetchFailed,
      message: `fetch failed: HTTP ${response.status} from ${url}`,
      http_status: response.status,
      retryable: response.status >= 500,
    })
  }

  let raw: unknown
  try {
    raw = await response.json()
  } catch (err) {
    throw new UcpError({
      layer,
      code: options.errorCodes.invalidJson,
      message: `response body is not valid JSON: ${url}`,
      cause: err as Error,
    })
  }

  let body: T
  if (options.schema !== undefined) {
    if (options.errorCodes.schemaInvalid === undefined) {
      throw new Error('fetchCached: errorCodes.schemaInvalid is required when schema is provided')
    }
    const parsed = options.schema.safeParse(raw)
    if (!parsed.success) {
      throw new UcpError({
        layer,
        code: options.errorCodes.schemaInvalid,
        message: `response failed schema validation at ${url}: ${formatZodIssues(parsed.error.issues)}`,
      })
    }
    body = parsed.data
  } else {
    body = raw as T
  }

  const maxAge = parseMaxAge(response.headers.get('cache-control'))
  if (maxAge !== null) {
    const now = Date.now()
    await writeCachedBody(cachePath, {
      url,
      fetched_at: now,
      expires_at: now + maxAge * 1000,
      body,
    })
  }

  return body
}

// ─── cacheCompute primitive ──────────────────────────────────────────────
//
// `fetchCached` handles the GET-and-cache shape (business profiles).
// `cacheCompute` is the more general form for callers that produce a
// value through any I/O (e.g. JSON-RPC POST for `tools/list`). The cache
// envelope is identical — same on-disk format, same TTL semantics — but
// TTL is caller-supplied because non-HTTP-GET fetchers don't naturally
// surface a `Cache-Control` header at this seam.

export interface CacheComputeOptions<T> {
  /** Directory the cache file lives in. Caller composes. */
  cacheDir: string
  /** Filename without extension. Caller is responsible for filesystem-safety. */
  cacheKey: string
  /** Cache lifetime in seconds. Subject to {@link MIN_CACHE_SECONDS} floor. */
  ttlSeconds: number
  /** Optional schema applied on cache read AND after compute. */
  schema?: z.ZodType<T>
  /** Skip the cache read; cache is still written on a successful compute. */
  force?: boolean
  /** Identity-style fetcher; only invoked on cache miss/expiry. */
  compute: () => Promise<T>
}

/**
 * On-disk cache around an arbitrary async computation. Reads the cache
 * first (when fresh), invokes `compute()` on miss/expiry, and writes the
 * result back. The schema is applied on both read and write so a stale
 * cache file that no longer matches the caller's expectations is treated
 * as a miss instead of silently returning bad data.
 */
export async function cacheCompute<T>(options: CacheComputeOptions<T>): Promise<T> {
  const cachePath = join(options.cacheDir, `${options.cacheKey}.json`)

  if (options.force !== true) {
    const cached = await readCachedBody<T>(cachePath, options.schema)
    if (cached !== null && cached.expires_at > Date.now()) {
      vlog(
        `cache: HIT ${cachePath} (expires in ${Math.max(0, Math.round((cached.expires_at - Date.now()) / 1000))}s)`,
      )
      return cached.body
    }
  }
  vlog(`cache: MISS ${cachePath}${options.force === true ? ' (force)' : ''} → compute`)

  const value = await options.compute()
  // Asymmetric schema handling on purpose:
  //   - cache READ failure (stale envelope after a schema bump) → silent
  //     miss; falls through to compute() which is the recovery path.
  //   - compute RESULT failure (caller's fetcher returned wrong shape)
  //     → loud throw; programmer/contract bug, never write bad data
  //     through to disk.
  let body: T
  if (options.schema !== undefined) {
    const parsed = options.schema.safeParse(value)
    if (!parsed.success) {
      throw new Error(
        `cacheCompute: computed value failed schema: ${formatZodIssues(parsed.error.issues)}`,
      )
    }
    body = parsed.data
  } else {
    body = value
  }

  const ttl = Math.max(options.ttlSeconds, MIN_CACHE_SECONDS)
  const now = Date.now()
  await writeCachedBody(cachePath, {
    url: options.cacheKey,
    fetched_at: now,
    expires_at: now + ttl * 1000,
    body,
  })
  return body
}

// ─── Cache I/O (internal) ────────────────────────────────────────────────

async function readCachedBody<T>(
  path: string,
  schema: z.ZodType<T> | undefined,
): Promise<CacheEntry<T> | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const envelope = cacheEntrySchema.safeParse(parsed)
  if (!envelope.success) return null
  if (schema !== undefined) {
    const body = schema.safeParse(envelope.data.body)
    if (!body.success) return null
    return { ...envelope.data, body: body.data }
  }
  return { ...envelope.data, body: envelope.data.body as T }
}

async function writeCachedBody<T>(path: string, entry: CacheEntry<T>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(entry, null, 2), 'utf-8')
}
