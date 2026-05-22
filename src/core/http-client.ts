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
//
// What this DOES NOT own (intentional — each caller has different needs):
//
//   - Timeout / AbortSignal composition. Callers compose their own (cache:
//     30 s, mcp: 30 s, doctor: 5 s).
//   - Response parsing, error mapping, status checks, caching, schema
//     validation. Those stay in the call-site modules (mcp-client.ts,
//     cache.ts, etc.) because their semantics differ.
//   - Response-side verbose trace (status, latency, body length). That
//     requires call-site knowledge of how to interpret the body.
//
// Adding a NEW outbound fetch site: import and call `ucpFetch`. Bypassing it
// means losing User-Agent identification, header merging, and verbose
// tracing all at once — which is the trap that motivated this module.

import { defaultUserAgent, formatHeadersForTrace } from './headers.js'
import { vlog } from './verbose.js'

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
  return fetchImpl(url, {
    ...(opts.method !== undefined && { method: opts.method }),
    headers: requestHeaders,
    ...(opts.body !== undefined && { body: opts.body }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  })
}
