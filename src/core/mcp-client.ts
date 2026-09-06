// JSON-RPC 2.0 over HTTP POST for UCP's MCP transport.
//
// This is intentionally a narrow adapter, not a full MCP client. UCP dispatch
// needs single-shot HTTPS POSTs for methods such as `tools/list` and
// `tools/call`; it does not need SSE, stdio, initialization lifecycle, session
// negotiation, or server-initiated messages here.
//
// The module owns transport error mapping and JSON-RPC envelope validation:
// network/abort, HTTP status, invalid JSON, invalid envelope, id mismatch, and
// JSON-RPC `error` all become UcpError instances with transport-layer codes.
// If a non-2xx response still carries a JSON-RPC error envelope, the structured
// RPC error wins and the HTTP status is preserved as diagnostic context.
// Signing and UCP request envelopes are composed by higher layers.

import { ErrorCodes, UcpError } from '../lib/errors.js'
import type { CtaBlock } from '../lib/types.js'
import { refusedRedirect, ucpFetch } from './http-client.js'
import { proxyErrorContext, proxyErrorNote } from './proxy.js'
import { parseHttpsUrl } from './url.js'
import { vlog } from './verbose.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

interface JsonRpcSuccess<T> {
  jsonrpc: '2.0'
  id: string | number | null
  result: T
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: string | number | null
  error: { code: number; message: string; data?: unknown }
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_ERROR_BODY_CHARS = 2_000

// Monotonic id generator. JSON-RPC ids only matter for batched/concurrent
// pipelining; we issue one request per call so collision is impossible.
// Kept monotonic anyway so verbose-mode log lines correlate predictably.
let nextRequestId = 1

export interface McpRpcOptions {
  endpoint: string
  method: string
  params?: unknown
  /** Forwarded to `fetch`; composed with the request timeout. */
  signal?: AbortSignal
  /** Injectable for tests. */
  fetch?: typeof fetch
  /** Override the auto-incrementing request id. */
  id?: string | number
  /**
   * Extra request headers. UCP-over-MCP carries agent identity inside
   * `params.arguments.meta.ucp-agent`, not
   * in headers — `headers` is here for transport-level overrides only
   * (for example, compatibility headers at the transport edge).
   */
  headers?: Record<string, string>
  /** Per-request timeout; default 30 s, matching `core/cache.ts`. */
  timeoutMs?: number
}

export async function mcpRpc<T = unknown>(opts: McpRpcOptions): Promise<T> {
  const endpoint = parseHttpsUrl(opts.endpoint, 'MCP endpoint').toString()
  const id = opts.id ?? nextRequestId++

  const body: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method: opts.method,
    // Serialize `params` only when supplied — JSON-RPC 2.0 spec §4.2:
    // omitted is distinct from `null`, and some servers reject the latter.
    ...(opts.params !== undefined ? { params: opts.params } : {}),
  }

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal =
    opts.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, opts.signal])

  const requestBody = JSON.stringify(body)
  const startedAt = Date.now()
  vlog(`mcp: → POST ${endpoint} ${opts.method} (${requestBody.length}B)`)

  let response: Response
  try {
    response = await ucpFetch(endpoint, {
      method: 'POST',
      body: requestBody,
      ...(opts.headers !== undefined && { headers: opts.headers }),
      framing: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal,
      ...(opts.fetch !== undefined && { fetch: opts.fetch }),
      traceLabel: 'mcp',
    })
  } catch (err) {
    // A refused redirect already names the Location and the remedy, and it is
    // not a network fault: the endpoint answered. Passing it through keeps one
    // code per remedy, which is what an agent grouping by `code` relies on.
    //
    // UCP's no-redirect rule covers the documents an exchange dereferences,
    // not this endpoint — refusing here is ucp-cli's own policy (see the
    // module header of http-client.ts). A Business that wants operations at
    // another URL declares that endpoint in its profile.
    if (refusedRedirect(err) !== undefined) throw err
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.TRANSPORT_NETWORK_ERROR,
      message: `MCP request to ${endpoint} failed: ${(err as Error).message}${proxyErrorNote()}`,
      cause: err as Error,
      // An ignored or broken proxy is indistinguishable from an unreachable
      // merchant at this layer, and an agent reading this envelope would
      // otherwise report "merchant is down". Spreads to nothing when no proxy
      // is configured.
      context: { endpoint, method: opts.method, ...proxyErrorContext() },
    })
  }

  const responseText = await response.text()
  vlog(
    `mcp: ← ${response.status} ${opts.method} (${Date.now() - startedAt}ms, ${responseText.length}B)`,
  )
  let raw: unknown
  try {
    raw = JSON.parse(responseText)
  } catch (err) {
    if (!response.ok) {
      throw httpError({
        endpoint,
        method: opts.method,
        status: response.status,
        body: { raw_body: truncate(responseText) },
      })
    }
    // Annotated for the same reason as the transport failure above, even
    // though bytes came back: a captive or TLS-inspecting proxy answers 200
    // with an HTML sign-in page, so unparseable JSON is one of the *likeliest*
    // proxy symptoms rather than evidence the merchant was reached.
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.TRANSPORT_INVALID_JSON,
      message: `MCP response body is not valid JSON: ${endpoint}${proxyErrorNote()}`,
      cause: err as Error,
      context: { endpoint, method: opts.method, ...proxyErrorContext() },
    })
  }

  if (!isJsonRpcResponse(raw)) {
    if (!response.ok) {
      throw httpError({
        endpoint,
        method: opts.method,
        status: response.status,
        body: raw,
      })
    }
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.MCP_INVALID_RESPONSE,
      message: `MCP response from ${endpoint} is not a valid JSON-RPC 2.0 envelope`,
      context: { endpoint, method: opts.method, body: raw },
    })
  }

  if (raw.id !== id) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.MCP_INVALID_RESPONSE,
      message: `MCP response id mismatch from ${endpoint}: expected ${String(id)}, got ${String(raw.id)}`,
      context: { endpoint, method: opts.method, expectedId: id, responseId: raw.id },
    })
  }

  if ('error' in raw) {
    throw rpcError({
      endpoint,
      method: opts.method,
      raw,
      ...(agentProfileUrlFromParams(opts.params) !== undefined
        ? { agentProfileUrl: agentProfileUrlFromParams(opts.params) as string }
        : {}),
      ...(response.ok ? {} : { http_status: response.status }),
    })
  }

  if (!response.ok) {
    throw httpError({
      endpoint,
      method: opts.method,
      status: response.status,
      body: raw,
    })
  }

  return raw.result as T
}

// The agent profile URL we put on the wire for THIS request. Both `tools/list`
// and `tools/call` carry it at `params.arguments.meta.ucp-agent.profile`
// (composed by discover.ts / operation.ts), so a server complaint about that
// document can be reported against the exact URL we sent.
function agentProfileUrlFromParams(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const args = (params as { arguments?: unknown }).arguments
  if (typeof args !== 'object' || args === null) return undefined
  const meta = (args as { meta?: unknown }).meta
  if (typeof meta !== 'object' || meta === null) return undefined
  const agent = (meta as Record<string, unknown>)['ucp-agent']
  if (typeof agent !== 'object' || agent === null) return undefined
  const profile = (agent as { profile?: unknown }).profile
  return typeof profile === 'string' ? profile : undefined
}

// The business could not fetch OUR hosted agent profile, so it refused the
// call (verified live: JSON-RPC -32001 `UCP discovery failed` with
// `data.code: 'profile_unreachable'`). This is the ONLY request-time source
// of AGENT_PROFILE_UNREACHABLE: the CLI does not pre-flight its own URL (a
// blip there must not block a call the merchant would have served from
// cache), so the merchant reporting the fetch failure is how we learn — not a
// generic MCP_RPC_ERROR, and not the merchant's fault. Matched on `data.code`
// rather than the numeric -32001: the numeric code sits in JSON-RPC's
// implementation-defined server-error range and is not itself a UCP contract,
// while `profile_unreachable` means exactly one thing.
function isProfileUnreachableRpcError(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  return (data as { code?: unknown }).code === 'profile_unreachable'
}

function rpcError(opts: {
  endpoint: string
  method: string
  raw: JsonRpcErrorResponse
  http_status?: number
  /** Agent profile URL advertised on this request, when the params carried one. */
  agentProfileUrl?: string
}): UcpError {
  const { code: rpcCode, message: rpcMessage, data: rpcData } = opts.raw.error
  const httpDetail = opts.http_status === undefined ? '' : ` [HTTP ${opts.http_status}]`
  const dataDetail = summarizeRpcData(rpcData)

  if (isProfileUnreachableRpcError(rpcData)) {
    const where =
      opts.agentProfileUrl === undefined
        ? 'the agent profile URL sent with this request'
        : opts.agentProfileUrl
    return new UcpError({
      // `client`, not `transport`: the broken document is ours. Same layer the
      // local detection path uses, which is what keeps `code → layer` a
      // function (see ERROR_LAYERS in lib/errors.ts).
      layer: 'client',
      code: ErrorCodes.AGENT_PROFILE_UNREACHABLE,
      message: `${opts.endpoint} could not fetch our hosted agent profile at ${where} (business reported profile_unreachable); every call fails until that URL serves the profile. Run \`ucp doctor\`.`,
      context: {
        endpoint: opts.endpoint,
        method: opts.method,
        reason: 'business_reported',
        ...(opts.agentProfileUrl !== undefined ? { url: opts.agentProfileUrl } : {}),
        rpcCode,
        rpcData,
      },
      cta: {
        description:
          'The business fetches the agent profile URL on every call. Fix hosting (or point at a reachable profile URL with --profile-url), then retry.',
        commands: [
          {
            command: 'ucp doctor',
            description: 'probe the active profile URL and report what it serves',
          },
        ],
      },
    })
  }
  // When HTTP status is present AND matches a spec-aligned code (auth, rate-
  // limit, server-error), prefer that over the generic MCP_RPC_ERROR fallback
  // so agents can branch precisely. For unmapped statuses (e.g. 422
  // Unprocessable Entity) we keep MCP_RPC_ERROR — it's more specific than
  // TRANSPORT_HTTP_ERROR for the case where a JSON-RPC envelope IS present.
  // The verbose RPC message survives in `.message` regardless.
  const mappedCode =
    opts.http_status !== undefined ? maybeMapHttpStatusToCode(opts.http_status) : undefined
  const code = mappedCode ?? ErrorCodes.MCP_RPC_ERROR
  const cta = ctaForCode(code)
  return new UcpError({
    layer: 'transport',
    code,
    message: `MCP RPC error from ${opts.endpoint}${httpDetail} (${rpcCode}): ${rpcMessage}${dataDetail === undefined ? '' : ` (${dataDetail})`}`,
    ...(opts.http_status !== undefined ? { http_status: opts.http_status } : {}),
    ...(cta !== undefined ? { cta } : {}),
    retryable: isRetryableCode(code),
    context: {
      endpoint: opts.endpoint,
      method: opts.method,
      ...(opts.http_status !== undefined ? { http_status: opts.http_status } : {}),
      rpcCode,
      rpcData,
    },
  })
}

function httpError(opts: {
  endpoint: string
  method: string
  status: number
  body: unknown
}): UcpError {
  // No JSON-RPC envelope present (or body wasn't parseable) — the only
  // structured signal we have is the HTTP status. Fall back to the generic
  // TRANSPORT_HTTP_ERROR when status isn't in the spec-aligned table.
  const code = maybeMapHttpStatusToCode(opts.status) ?? ErrorCodes.TRANSPORT_HTTP_ERROR
  const cta = ctaForCode(code)
  return new UcpError({
    layer: 'transport',
    code,
    message: `MCP request returned HTTP ${opts.status} from ${opts.endpoint}`,
    http_status: opts.status,
    retryable: isRetryableCode(code),
    ...(cta !== undefined ? { cta } : {}),
    context: { endpoint: opts.endpoint, method: opts.method, body: opts.body },
  })
}

// Map business-returned HTTP status to a spec-aligned UCP error code
// (docs/specification/overview.md § Protocol Errors). Strict mapping by status
// only — no body inspection — so behavior is predictable and not locale- or
// business-phrasing-sensitive. 401 vs 403 carry different spec semantics even
// though both currently share the same handoff CTA; keeping them distinct
// lets agents branch precisely as the surface evolves.
//
// Returns `undefined` for unmapped statuses so callers preserve their own
// fallback semantics (rpcError keeps MCP_RPC_ERROR when a JSON-RPC envelope
// is present; httpError keeps TRANSPORT_HTTP_ERROR otherwise).
function maybeMapHttpStatusToCode(status: number): UcpErrorCode | undefined {
  if (status === 401) return ErrorCodes.AUTH_REQUIRED
  if (status === 403) return ErrorCodes.INSUFFICIENT_PERMISSIONS
  if (status === 409) return ErrorCodes.IDEMPOTENCY_CONFLICT
  if (status === 429) return ErrorCodes.RATE_LIMITED
  if (status === 503) return ErrorCodes.SERVICE_UNAVAILABLE
  if (status >= 500) return ErrorCodes.BUSINESS_SERVER_ERROR
  return undefined
}

// Auth-class errors share a recovery framing: this CLI doesn't implement
// business-specific credential schemes, so the buyer must hand off to the
// best URL the agent already has. SKILL.md teaches the precedence order; the
// CTA here keeps that guidance reachable from the error envelope directly.
//
// `commands[]` carries one placeholder entry (a comment-shaped "command")
// because incur strips CTA blocks with empty `commands` arrays. The
// description is where the actual recovery guidance lives — the placeholder
// just keeps the CTA alive on the wire. Buyer handoff is intentionally not
// a CLI subcommand; it's an out-of-band action the agent takes with the
// best URL it already has from prior responses.
function ctaForCode(code: UcpErrorCode): CtaBlock | undefined {
  if (code === ErrorCodes.AUTH_REQUIRED || code === ErrorCodes.INSUFFICIENT_PERMISSIONS) {
    return {
      description:
        'This business requires authentication that this CLI does not implement (e.g. JWT, OAuth, API key). Do not keep retrying the same operation. Hand the buyer off using the best URL you already have, in order: current/prior cart or checkout continue_url; selected variant.checkout_url; selected variant/product url; seller.url/homepage; otherwise the business URL or https://<seller.domain>.',
      commands: [
        {
          command:
            '# open <continue_url> | <variant.checkout_url> | <variant.url> | <seller.url> from a prior response',
          description:
            'Hand the buyer the best URL you already have; this CLI cannot complete business-authenticated flows.',
        },
      ],
    }
  }
  return undefined
}

// 5xx and 429 are transient by spec; 4xx (auth, idempotency) is not.
function isRetryableCode(code: UcpErrorCode): boolean {
  return (
    code === ErrorCodes.RATE_LIMITED ||
    code === ErrorCodes.BUSINESS_SERVER_ERROR ||
    code === ErrorCodes.SERVICE_UNAVAILABLE
  )
}

type UcpErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

function truncate(value: string): string {
  return value.length <= MAX_ERROR_BODY_CHARS ? value : `${value.slice(0, MAX_ERROR_BODY_CHARS)}...`
}

function summarizeRpcData(data: unknown): string | undefined {
  if (typeof data === 'string') return truncate(data)
  if (typeof data !== 'object' || data === null) return undefined

  const record = data as Record<string, unknown>
  const code = stringField(record, 'code')
  const content =
    stringField(record, 'content') ??
    stringField(record, 'message') ??
    stringField(record, 'detail') ??
    summarizeContent(record.content)

  if (code !== undefined && content !== undefined) return `${code}: ${truncate(content)}`
  if (code !== undefined) return code
  if (content !== undefined) return truncate(content)
  return undefined
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function summarizeContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const text = stringField(item as Record<string, unknown>, 'text')
    if (text !== undefined) return text
  }
  return undefined
}

function isJsonRpcResponse(
  value: unknown,
): value is JsonRpcSuccess<unknown> | JsonRpcErrorResponse {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown }
  if (v.jsonrpc !== '2.0') return false
  if (!('id' in v)) return false
  if (v.id !== null && typeof v.id !== 'string' && typeof v.id !== 'number') return false
  const hasResult = 'result' in v
  const hasError = 'error' in v
  return hasResult !== hasError
}
