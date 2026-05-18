// Error code registry + UcpError class.
//
// Exit-code contract: successful commands exit 0, including checkout responses
// with result.status === "requires_escalation". Any error exits 1. We do not
// expose per-error exit-code overrides until there is a deliberate compatibility
// story for differentiated codes.
//
// Three complementary mechanisms:
//
//   1. `ErrorCodes` (this module) — STRING CONSTANTS used as the
//      `error.code` field on outbound envelopes. Keep this registry limited
//      to codes emitted by reachable public paths; future-phase codes should
//      be added with the feature that first emits them.
//
//   2. `UcpError` (this module) — THROWABLE CLASS extending incur's
//      IncurError with a required `layer: ErrorLayer` field. Every internal
//      throw site uses this so PROTOCOL §4.2's "MUST emit one of the four"
//      requirement is enforced at the call site, not via a centralized
//      catch-and-translate that might miss code paths. Dispatcher middleware
//      reads `.layer` off the caught error directly.
//
//   3. Incur's own `Errors` namespace — additional throwable classes
//      (ValidationError, ParseError) for cases that don't yet need a UCP layer
//      (caught by incur's serve() before envelope construction). We do not
//      re-export it from the package root in v0.1 because plugin support is
//      still draft.
//
// Codes grouped by error layer below so misclassification is visible at
// the registry. When a layer is wrong for a code, that's a real bug —
// fix the code or fix the layer.

/**
 * Public registry of CLI-emitted error codes. Pre-v1, this should still be
 * treated carefully: adding a code is cheap, but do not pre-register future
 * codes until a reachable path can emit them.
 */
export const ErrorCodes = {
  // ── transport layer ─────────────────────────────────────────────────
  /** Business profile fetch failed (HTTP 4xx/5xx, network, DNS, etc.). */
  PROFILE_FETCH_FAILED: 'PROFILE_FETCH_FAILED',
  /** Business profile body could not be parsed as JSON. */
  PROFILE_INVALID_JSON: 'PROFILE_INVALID_JSON',
  /** Business profile body parsed as JSON but failed schema validation. */
  PROFILE_SCHEMA_INVALID: 'PROFILE_SCHEMA_INVALID',
  /** Business + CLI protocol ranges don't intersect. */
  PROTOCOL_VERSION_INCOMPATIBLE: 'PROTOCOL_VERSION_INCOMPATIBLE',
  /** Business profile parses cleanly but does not advertise the requested capability. */
  CAPABILITY_NOT_OFFERED: 'CAPABILITY_NOT_OFFERED',
  /** Business negotiated a capability but did not expose the requested operation/tool. */
  OPERATION_NOT_OFFERED: 'OPERATION_NOT_OFFERED',
  /**
   * Business profile passed schema validation but a negotiated mcp/rest service
   * entry is missing its `endpoint` (which dispatch needs). The canonical UCP
   * profile schema requires endpoint for these transports via per-transport
   * anyOf branches; the generated zod type widens that constraint back to
   * `optional()`, so this is the runtime backstop.
   */
  SERVICE_ENDPOINT_MISSING: 'SERVICE_ENDPOINT_MISSING',
  /** Business offers no transport that satisfies our requirements. */
  NO_COMPATIBLE_TRANSPORT: 'NO_COMPATIBLE_TRANSPORT',
  /** Endpoint returned a non-2xx HTTP response (full http_status carried in error.http_status). */
  TRANSPORT_HTTP_ERROR: 'TRANSPORT_HTTP_ERROR',
  /** Underlying fetch failed (DNS, connection refused, TLS, abort, etc.). */
  TRANSPORT_NETWORK_ERROR: 'TRANSPORT_NETWORK_ERROR',
  /** Endpoint returned 2xx but the body was not parseable as JSON. */
  TRANSPORT_INVALID_JSON: 'TRANSPORT_INVALID_JSON',
  /** Body parses as JSON but isn't a JSON-RPC 2.0 envelope (missing jsonrpc/result/error). */
  MCP_INVALID_RESPONSE: 'MCP_INVALID_RESPONSE',
  /**
   * JSON-RPC `error` member returned, with no usable HTTP status hint. Numeric
   * `code` and `data` are carried in `error.context`. Fallback for protocol-
   * level errors that don't fit one of the spec-aligned codes below.
   */
  MCP_RPC_ERROR: 'MCP_RPC_ERROR',
  /**
   * Business requires authentication (HTTP 401). Spec: "Authentication required
   * or credentials invalid" (docs/specification/overview.md, Protocol Errors).
   * Recovery is buyer handoff to the business's flow — this CLI does not yet
   * implement business-specific auth schemes (JWT, OAuth, API key, etc.).
   */
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  /**
   * Authenticated but lacks required scope/permissions (HTTP 403). Spec:
   * "Authenticated but insufficient permissions". Same recovery as AUTH_REQUIRED:
   * hand the buyer off, this CLI cannot escalate scope.
   */
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  /**
   * Idempotency key reused with a different payload (HTTP 409). Spec:
   * "Idempotency key reused with different payload". Recovery: re-issue with
   * a fresh key, or omit and retry.
   */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /**
   * Business rate-limited the request (HTTP 429). Spec: "Too many requests".
   * Retry-After parsing is not yet wired; treat as transient and back off.
   */
  RATE_LIMITED: 'RATE_LIMITED',
  /**
   * Business 5xx — unexpected server error (HTTP 500-599 except 503). Spec:
   * "Unexpected server error". Likely transient.
   */
  BUSINESS_SERVER_ERROR: 'BUSINESS_SERVER_ERROR',
  /**
   * Business temporarily unable to handle requests (HTTP 503). Spec: "Server
   * temporarily unable to handle requests". Distinct from BUSINESS_SERVER_ERROR
   * because the business is signaling intent to recover; retry is preferred.
   */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // ── client layer ────────────────────────────────────────────────────
  /** Caller passed input that fails resolved-schema validation. */
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  /** Caller passed structurally invalid input (bad JSON, missing required flag). */
  INVALID_INPUT: 'INVALID_INPUT',
  /**
   * No target business resolvable from --business / UCP_BUSINESS / active.yaml.
   * Carries a {@link Cta} pointing at `ucp use` or `--business`.
   */
  BUSINESS_NOT_RESOLVED: 'BUSINESS_NOT_RESOLVED',
  /** Caller referenced a profile name that doesn't exist on disk. */
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  /** Non-interactive profile init omitted the required profile name. */
  PROFILE_INIT_REQUIRES_NAME: 'PROFILE_INIT_REQUIRES_NAME',
  /** Profile creation lost an existence race and refused to overwrite. */
  PROFILE_ALREADY_EXISTS: 'PROFILE_ALREADY_EXISTS',
  /** Profile name violates the filesystem-safe naming rule or reserved-name rule. */
  PROFILE_INVALID_NAME: 'PROFILE_INVALID_NAME',
} as const

/**
 * STABLE — registered codes give autocomplete; arbitrary strings remain valid
 * so plugins, future codes, and business-emitted application errors flow
 * through without a registry update.
 */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes] | (string & {})

import { Errors } from 'incur'

import type { CtaBlock, ErrorLayer } from './types.js'

export interface UcpErrorOptions {
  /** STABLE — one of the four PROTOCOL §4.2 layers. Required at every throw site. */
  layer: ErrorLayer
  /** Code from {@link ErrorCodes}, or any string for forward-compat. */
  code: ErrorCode
  /** Human-readable error message. */
  message: string
  /** Actionable hint surfaced in TTY mode. */
  hint?: string
  /** Whether the operation can be retried as-is. */
  retryable?: boolean
  /** Underlying cause for the cause chain. */
  cause?: Error
  /**
   * HTTP status when the error originated from an HTTP response.
   * Surfaces in `error.http_status` on the wire envelope (PROTOCOL §4.3
   * transport layer). Only meaningful for `layer: 'transport'`.
   */
  http_status?: number
  /**
   * Diagnostic context — response body, validation field-paths, anything
   * that helps the caller act on the error. Surfaces unchanged as
   * `error.context` on the wire envelope (PROTOCOL §4.3, transport
   * layer). Distinct from incur `BaseError.details: string`, which is
   * the cause-chain message extraction; ours is structured payload.
   */
  context?: unknown
  /**
   * Recovery hint — what the agent should do next. First-class field
   * (not nested in `context`) so agents can reliably destructure
   * `error.cta` without spelunking diagnostic blobs. Wire shape matches
   * {@link CtaBlock} on error envelopes (PROTOCOL §4.3): `description`
   * plus an ordered `commands[]`, each with `command` + optional
   * `description`.
   */
  cta?: CtaBlock
}

/**
 * Throwable error carrying a {@link ErrorLayer}. Extends incur's IncurError
 * so it flows through `cli.serve()`'s existing catch path; dispatcher
 * dispatcher middleware reads `.layer`, `.http_status`, and `.context`
 * to populate the outbound error envelope.
 *
 * Throw at the call site that knows the layer, not at a centralized
 * wrapper. A required field at construction can't be skipped.
 */
export class UcpError extends Errors.IncurError {
  override name = 'Ucp.UcpError'
  readonly layer: ErrorLayer
  readonly http_status?: number
  readonly context?: unknown
  readonly cta?: CtaBlock

  constructor(options: UcpErrorOptions) {
    const { layer, http_status, context, cta, ...incurOptions } = options
    super(incurOptions)
    this.layer = layer
    // exactOptionalPropertyTypes: explicit `if` avoids assigning undefined
    // to fields that are typed as truly optional rather than `T | undefined`.
    if (http_status !== undefined) this.http_status = http_status
    if (context !== undefined) this.context = context
    if (cta !== undefined) this.cta = cta
  }
}

export function isUcpError(err: unknown): err is UcpError {
  return err instanceof UcpError
}
