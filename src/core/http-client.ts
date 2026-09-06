// Single outbound HTTP entry point. Every fetch the CLI makes at runtime
// flows through here so the header bag is built in exactly one place.
//
// What this owns:
//
//   - Built-in User-Agent at the lowest priority on every request. Merchants
//     identifying our traffic in their access logs / WAFs should see
//     `@shopify/ucp-cli/<version>` regardless of which call site reached out.
//   - Merging caller-supplied resolved headers (from --header,
//     headers.json, env, etc — see resolveHeaders) over the built-in.
//   - Applying framing headers (Content-Type, Accept) the dispatcher owns,
//     spread LAST so no user source can clobber them.
//   - Verbose trace of the outgoing header bag with sensitive values
//     redacted (via formatHeadersForTrace).
//   - Refusing redirect responses (`301`, `302`, `303`, `307`, `308`). UCP
//     requires the documents an exchange dereferences — the profile,
//     identity (`jwks_uri` / CIMD), and `schema` URLs — to be served
//     without redirects, and requires an implementation not to follow one
//     while dereferencing such a URL. This is the single outbound seam, so
//     `redirect: 'manual'` states that requirement once, for every UCP
//     document fetch this CLI makes today or gains later.
//
//     ucp-cli applies the same rule to a negotiated service endpoint, which
//     UCP's requirement does not cover: the profile is where that endpoint's
//     identity comes from, so a Business that wants operations at another
//     URL declares that endpoint instead of pointing at it with a
//     `Location`. Refusing keeps the URL called equal to the URL declared.
//
//     `redirect: 'manual'` rather than `'error'`: `manual` keeps the status
//     and the `Location`, which are what the diagnostic names and what the
//     operator fixes. `'error'` throws a bare `TypeError` carrying neither.
//
// What this DOES NOT own (intentional — each caller has different needs):
//
//   - Timeout / AbortSignal composition. Callers compose their own (cache:
//     30 s, mcp: 30 s, doctor: 5 s).
//   - Response parsing, error mapping, caching, schema validation, and every
//     status check except the redirect refusal above. Those stay in the
//     call-site modules (mcp-client.ts, cache.ts, etc.) because their
//     semantics differ; the redirect refusal lives here because it is a rule
//     about which requests may be issued, not an interpretation of an answer.
//   - Response-side verbose trace (status, latency, body length). That
//     requires call-site knowledge of how to interpret the body.
//
// Adding a NEW outbound fetch site: import and call `ucpFetch`. Bypassing it
// means losing User-Agent identification, header merging, and verbose
// tracing all at once — which is the trap that motivated this module.

import { ErrorCodes, isUcpError, UcpError } from '../lib/errors.js'
import { defaultUserAgent, formatHeadersForTrace } from './headers.js'
import { vlog } from './verbose.js'

/**
 * The Fetch Standard's redirect statuses — exactly what `redirect: 'manual'`
 * stops us at. `304` is a 3xx but not one of them: it answers a conditional
 * request instead of pointing somewhere else, and treating it as a hop would
 * break revalidation the day a caller sends `If-None-Match`.
 */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** A redirect response `ucpFetch` declined to follow. */
export interface RefusedRedirect {
  /** The redirect status the origin answered (`301`/`302`/`303`/`307`/`308`). */
  status: number
  /** Where it pointed, or `null` when the response carried no `Location`. */
  location: string | null
}

/**
 * The absolute https URL a remedy may point at, resolved against the request
 * URL because a relative `Location` is legal (RFC 9110 §10.2.2). `null` when
 * the target is not one UCP may be pointed at — an `http` target above all:
 * UCP URLs are https, so an `http` `Location` can never be the fix.
 */
export function usableRedirectTarget(requestUrl: string, location: string | null): string | null {
  if (location === null) return null
  try {
    const resolved = new URL(location, requestUrl)
    return resolved.protocol === 'https:' ? resolved.toString() : null
  } catch {
    return null
  }
}

/**
 * Reads {@link ucpFetch}'s redirect refusal off an error, or `undefined` for
 * anything else. Callers branch on this rather than on message text: the
 * status and the target are what a remedy has to name, and prose is not a
 * contract.
 */
export function refusedRedirect(err: unknown): RefusedRedirect | undefined {
  if (!isUcpError(err) || err.code !== ErrorCodes.TRANSPORT_REDIRECT_REFUSED) return undefined
  // `context` is typed `unknown`, so the shape is re-checked rather than cast:
  // a decoder that invented a status would print "HTTP 0" at a remedy.
  const context = err.context as { status?: unknown; location?: unknown } | undefined
  if (typeof context?.status !== 'number') return undefined
  return {
    status: context.status,
    location: typeof context.location === 'string' ? context.location : null,
  }
}

export interface UcpFetchOptions {
  /** HTTP method. Defaults to GET to match `fetch()`. */
  method?: string
  /** Request body (string or bytes). Pass undefined for GET/HEAD. */
  body?: string | Uint8Array
  /**
   * Caller-supplied resolved outbound headers. Already filtered through
   * {@link resolveHeaders} for reserved-header rejection, ${VAR} expansion,
   * and source merging. Spread between the built-in User-Agent and the
   * dispatcher-owned framing block, so a caller-supplied User-Agent (e.g.
   * from a user --header override) wins over the built-in but no source
   * can replace framing.
   */
  headers?: Record<string, string>
  /**
   * Dispatcher-owned framing headers (Content-Type, Accept). Spread LAST so
   * user sources can never replace them. Optional because some call sites
   * (HEAD probes) intentionally send no body and want no Content-Type.
   */
  framing?: Record<string, string>
  /** AbortSignal forwarded to fetch. Callers compose their own timeouts. */
  signal?: AbortSignal
  /** Injectable fetch for tests. */
  fetch?: typeof fetch
  /**
   * Short label included in the verbose-mode header trace line so a single
   * `UCP_VERBOSE=1` run can be grepped by call site (e.g. `mcp:`, `cache:`,
   * `doctor:`). Required because the trace line is the main observability
   * benefit of routing through one client.
   */
  traceLabel: string
}

/**
 * Outbound fetch with built-in User-Agent, merged caller headers, framing,
 * and a redacted verbose trace. See module header for layering rules.
 */
export async function ucpFetch(url: string, opts: UcpFetchOptions): Promise<Response> {
  const fetchImpl = opts.fetch ?? fetch
  // Construct the final header bag locally so the verbose trace and the wire
  // request are guaranteed to be identical. Order: User-Agent first (so any
  // caller-supplied UA overrides), caller headers next, framing last (so the
  // dispatcher always wins on framing).
  const requestHeaders: Record<string, string> = {
    'User-Agent': defaultUserAgent(),
    ...opts.headers,
    ...opts.framing,
  }
  vlog(`${opts.traceLabel}: headers: ${formatHeadersForTrace(requestHeaders)}`)
  const response = await fetchImpl(url, {
    ...(opts.method !== undefined && { method: opts.method }),
    headers: requestHeaders,
    ...(opts.body !== undefined && { body: opts.body }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
    redirect: 'manual',
  })
  if (REDIRECT_STATUSES.has(response.status)) {
    const refusal = redirectRefused(url, response)
    // Undici holds the connection until the body is consumed or cancelled, so
    // a 3xx body we will never read must be released explicitly or it occupies
    // a pooled socket until it completes or is collected. Awaited so the
    // release finishes before unwinding; its own failure is swallowed, because
    // a cleanup error must never replace the refusal the caller is waiting for.
    if (response.body !== null) await response.body.cancel().catch(() => {})
    throw refusal
  }
  return response
}

function redirectRefused(url: string, response: Response): UcpError {
  const location = response.headers.get('location')
  const target = location === null ? 'no `Location` header' : `\`Location: ${location}\``
  const destination = usableRedirectTarget(url, location)
  const remedy =
    destination !== null
      ? `Serve the requested resource at ${url} itself, or point the declaration that supplied ${url} at ${destination} once that URL serves it.`
      : location === null
        ? `Serve the requested resource at ${url} itself; the response named no target to point at instead.`
        : `Serve the requested resource at ${url} itself, over https. UCP URLs are https, so the target named here cannot replace ${url} in the declaration that supplied it either.`
  return new UcpError({
    layer: 'transport',
    code: ErrorCodes.TRANSPORT_REDIRECT_REFUSED,
    message: `${url} answered HTTP ${response.status} with ${target}, and ucp-cli did not follow it. UCP forbids redirects on the documents an exchange dereferences — the profile, any \`jwks_uri\` or CIMD document, and \`schema\` URLs. ucp-cli additionally refuses them on a negotiated service endpoint, whose identity comes from the profile: a target neither declared nor validated would replace that value out of band. ${remedy}`,
    http_status: response.status,
    // `http_status` is the wire-envelope field; this is the structured copy
    // callers decode through `refusedRedirect` (context is never serialized).
    context: { url, status: response.status, location },
  })
}
