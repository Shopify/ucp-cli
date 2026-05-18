// Generic MCP operation dispatcher.
//
// Discovery owns profile negotiation and tools/list hydration. This layer owns
// the last mile: tool lookup, UCP agent metadata composition, schema validation
// against the resolved tool inputSchema, and the `tools/call` envelope.
//
// This module is service-agnostic — it knows nothing about `dev.ucp.shopping`
// or any other UCP service. Domain bindings live in `src/services/*` and
// build typed helpers on top of `serviceOp`.

import { randomUUID } from 'node:crypto'
import type { AnySchema, ErrorObject } from 'ajv'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { omitUndefined } from '../lib/omit-undefined.js'
import { type DiscoveredBusiness, type DiscoverOptions, discover } from './discover.js'
import { mcpRpc } from './mcp-client.js'

export type CallOperationCallerOptions = Pick<
  DiscoverOptions,
  'agentRange' | 'cacheDir' | 'fetch' | 'force' | 'profileUrl' | 'signal'
> & {
  /**
   * `--dry-run`: run the full pre-flight (discover → meta inject → schema
   * validate) and return a {@link DryRunPreview} instead of issuing
   * `tools/call`. The preview shows EXACTLY what would have hit the wire,
   * including the `meta.idempotency-key` UUID and `meta.ucp-agent` envelope.
   * Validation still fires — a payload that would fail SCHEMA_VALIDATION_FAILED
   * with a real call also fails here. That's deliberate: dry-run should match
   * a real call's behavior up to (but not including) network I/O.
   */
  dryRun?: boolean
  /**
   * Internal-only side-channel: fired once after `discover()` resolves and
   * before `tools/call`. The CLI uses this to surface the trusted negotiated
   * view in CTAs (extension hints) without forcing a redundant discover() at
   * the call site or breaking the public helper signature (`Promise<unknown>`).
   * Not part of the supported library API — name is underscore-prefixed and
   * documented as internal so external callers don't grow a dependency on it.
   */
  _onDiscover?: (discovered: DiscoveredBusiness) => void
}

// Caller-facing options keep `profileUrl` optional so help/diagnostics paths
// can omit it; dispatch requires it. forwardCallOptions narrows to the
// dispatcher contract and rejects undefined optional keys explicitly so we
// don't transmit `key: undefined` (which exactOptionalPropertyTypes treats as
// distinct from absence and which the dispatcher rejects).
export function forwardCallOptions(
  options: CallOperationCallerOptions,
  opName: string,
): CallOperationOptions {
  if (options.profileUrl === undefined) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `${opName} operation requires a profile URL`,
    })
  }
  return {
    profileUrl: options.profileUrl,
    ...omitUndefined({
      agentRange: options.agentRange,
      cacheDir: options.cacheDir,
      fetch: options.fetch,
      force: options.force,
      signal: options.signal,
      dryRun: options.dryRun,
      _onDiscover: options._onDiscover,
    }),
  }
}

export interface CallOperationInput {
  capability: string
  toolName: string
  input: Record<string, unknown>
}

// Factory for service-domain helpers. Each `src/services/*` module binds
// this to its UCP capability id (`dev.ucp.shopping`, `dev.ucp.payments`, …)
// once and exposes typed per-tool functions. Keeping the helpers as named
// exports — not a Map — preserves IDE auto-import and tree-shaking.
//
// `opName` is purely diagnostic: it's the short label that appears in the
// "missing profile URL" error message and aligns with the body sub-domain
// the helper operates on (e.g. 'cart', 'checkout', 'catalog').
//
// The returned function carries `capability`, `toolName`, and `opName` as own
// properties. `--input-schema` reads capability/toolName to look up the
// operation input schema without dispatching `tools/call`; `--view :alias`
// reads opName to resolve bundled capability-scoped views. Avoids parallel
// registries — introspection/projection stay in sync with dispatch helpers.
export interface ServiceOpHelper {
  (
    businessUrl: string,
    input: Record<string, unknown>,
    options?: CallOperationCallerOptions,
  ): Promise<unknown>
  capability: string
  toolName: string
  opName: string
}

export function serviceOp(capability: string, toolName: string, opName: string): ServiceOpHelper {
  const helper: ServiceOpHelper = Object.assign(
    (
      businessUrl: string,
      input: Record<string, unknown>,
      options: CallOperationCallerOptions = {},
    ): Promise<unknown> =>
      callOperation(
        businessUrl,
        { capability, toolName, input },
        forwardCallOptions(options, opName),
      ),
    { capability, toolName, opName },
  )
  return helper
}

export interface CallOperationOptions
  extends Pick<DiscoverOptions, 'agentRange' | 'cacheDir' | 'fetch' | 'force' | 'signal'> {
  profileUrl: string
  dryRun?: boolean
  /** See {@link CallOperationCallerOptions._onDiscover}. */
  _onDiscover?: (discovered: DiscoveredBusiness) => void
}

/**
 * What `--dry-run` returns instead of the upstream MCP response. The shape
 * is JSON-serializable and self-documenting so agents (or humans) can paste
 * it into a bug report and reconstruct the request without any CLI replay.
 *
 * `dry_run: true` is the discriminator that callers (cli.ts opRun) check to
 * branch off the normal envelope path. The marker is on the result, not in
 * an out-of-band channel, because callers that wrap helpers (test harnesses,
 * future RPC client) need a structural signal that travels with the value.
 *
 * Dispatch identity (business / endpoint / transport) is NOT stamped here —
 * it lives at envelope root for every UCP op response, dry-run or live, so
 * agents read it from one canonical place. Re-emitting it inside the preview
 * would invite divergence (different values for `business` between root and
 * preview already bit us once).
 */
export interface DryRunPreview {
  dry_run: true
  /**
   * Human/agent-facing explanation. Lives on the value (not in a CTA) because
   * incur strips CTA blocks with empty `commands`, and the only honest "next
   * command" here is the same one minus `--dry-run` — not a new step worth
   * suggesting. The note instead names the surprising bit: that `arguments`
   * is wire-faithful, post meta injection.
   */
  note: string
  capability: string
  tool: { name: string }
  /** Exact `arguments` the dispatcher would send (post meta-injection + validation). */
  arguments: Record<string, unknown>
}

/** Type guard for the {@link DryRunPreview} discriminator. */
export function isDryRunPreview(value: unknown): value is DryRunPreview {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).dry_run === true
  )
}

export async function callOperation<T = unknown>(
  businessUrl: string,
  input: CallOperationInput,
  options: CallOperationOptions,
): Promise<T> {
  const resolved = await discover(businessUrl, {
    capabilities: [input.capability],
    profileUrl: options.profileUrl,
    ...omitUndefined({
      agentRange: options.agentRange,
      cacheDir: options.cacheDir,
      fetch: options.fetch,
      force: options.force,
      signal: options.signal,
    }),
  })
  // Fire the internal side-channel as soon as discover succeeds — before any
  // possible OPERATION_NOT_OFFERED throw — so the CLI has the trusted view
  // even on the error path (CTAs on transport-layer failures can still
  // benefit from advertised-capability context).
  options._onDiscover?.(resolved)

  const negotiated = resolved.negotiated[input.capability]
  const tool = negotiated?.tools[input.toolName]
  if (negotiated === undefined || tool === undefined) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.OPERATION_NOT_OFFERED,
      message: `business does not expose "${input.toolName}"`,
      context: {
        business: resolved.business,
        capability: input.capability,
        offered: negotiated === undefined ? [] : Object.keys(negotiated.tools).sort(),
      },
    })
  }

  const args = withProfileMetadata(input.input, options.profileUrl)
  validateOperationInput({
    business: resolved.business,
    capability: input.capability,
    toolName: input.toolName,
    schema: tool.inputSchema,
    args,
  })

  if (options.dryRun === true) {
    // Short-circuit AFTER validation/meta injection so the preview matches
    // the bytes a real call would emit. Returning DryRunPreview as T is
    // intentional — every caller already accepts unknown and branches via
    // isDryRunPreview at the cli.ts boundary. Avoids forking the type
    // surface for what is fundamentally a debug detour.
    const preview: DryRunPreview = {
      dry_run: true,
      note: 'No network call issued. `arguments` is exactly what would hit the wire, including the auto-injected meta.idempotency-key and meta.ucp-agent. Re-run without --dry-run to dispatch. Envelope root carries `business`/`endpoint`/`transport` — the canonical dispatch target.',
      capability: input.capability,
      tool: { name: tool.name },
      arguments: args,
    }
    return preview as T
  }

  const raw = await mcpRpc<unknown>({
    endpoint: negotiated.endpoint,
    method: 'tools/call',
    params: {
      name: tool.name,
      arguments: args,
    },
    ...omitUndefined({ fetch: options.fetch, signal: options.signal }),
  })
  // MCP tools/call wraps results in { content:[{type:'text',text:'<json>'}], isError? }.
  // Unwrap to the inner UCP envelope so callers never see the transport wrapper.
  // isError:true is not special-cased here — callers (e.g. opRun's isEscalationEnvelope
  // check) inspect the parsed inner value and handle it semantically.
  return unwrapMcpCallResult(raw) as T
}

// Detect and unwrap the MCP tools/call content envelope. Returns the parsed
// inner value when the shape matches; returns the original otherwise so callers
// that receive non-standard responses don't silently lose data.
//
// MCP `tools/call` has two ways to express the result body:
//   - `structuredContent: {...}` — already-parsed JSON (newer; preferred when present)
//   - `content: [{type:'text', text:'<JSON>'}]` — text fallback (legacy / display)
// A server may emit either or both. We prefer `structuredContent` because it's
// cheaper (no re-parse) and lossless (no JSON.stringify round-trip); if it's
// missing we fall back to parsing the text payload. Either path produces the
// same logical UCP envelope `{ucp, ...payload}`.
export function unwrapMcpCallResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result
  const r = result as Record<string, unknown>

  if (typeof r.structuredContent === 'object' && r.structuredContent !== null) {
    return r.structuredContent
  }

  if (!Array.isArray(r.content) || r.content.length === 0) return result
  const first = r.content[0]
  if (typeof first !== 'object' || first === null) return result
  const text = (first as Record<string, unknown>).text
  if (typeof text !== 'string') return result
  try {
    return JSON.parse(text)
  } catch {
    return result
  }
}

// `meta.ucp-agent` is protocol-owned: it carries the agent's identity envelope
// and is composed by this dispatcher, never by user input. Other `meta.*`
// keys remain a forward-compat namespace the caller may populate.
//
// `meta.idempotency-key`: cancel_cart, complete_checkout, and cancel_checkout
// require it per spec; idempotent ops don't, but accepting one is harmless.
// Rather than introspect the inputSchema for the requirement (brittle under
// allOf + $ref composition), unconditionally inject a UUIDv4 unless the
// caller supplied one. Mirrors HTTP idempotency-key conventions.
function withProfileMetadata(
  input: Record<string, unknown>,
  profileUrl: string,
): Record<string, unknown> {
  const userMeta = input.meta
  if (userMeta !== undefined && !isPlainObject(userMeta)) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: 'operation input "meta" must be an object',
      context: { meta: userMeta },
    })
  }
  if (userMeta !== undefined && 'ucp-agent' in userMeta) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: 'operation input cannot set meta.ucp-agent (protocol-owned by the dispatcher)',
    })
  }
  const meta: Record<string, unknown> = {
    ...(userMeta ?? {}),
    'ucp-agent': { profile: profileUrl },
  }
  if (!('idempotency-key' in meta)) {
    meta['idempotency-key'] = randomUUID()
  }
  return { ...input, meta }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ════════════════════════════════════════════════════════════════════════════
// TODO(upstream-fix): REMOVE THIS PATCHER AND ITS CALL SITE.
//
// Stopgap: rewrites leading `\A` start-of-string anchors to `^` in JSON Schema
// `pattern` fields before AJV compilation.
//
// Why this exists:
//   `\A` is Ruby/PCRE syntax. JSON Schema (Draft 2020-12 §6.3.3) mandates
//   ECMA-262 regex semantics, where `\A` is an invalid escape under the `u`
//   flag (AJV's default). `catalog.shopify.com` ships `search_catalog.inputSchema`
//   with `"pattern": "\\Agid://shopify/p/"`, so every JS/TS agent that
//   AJV-compiles before dispatch errors out at the validation gate and never
//   reaches the wire. We rewrite it client-side so global-catalog ops work
//   during internal testing.
//
// Removal trigger:
//   Upstream ships `^gid://shopify/p/` in search_catalog.inputSchema. Once fixed:
//     1. Delete `patchKnownUpstreamSchemaDefects` + `walkPatternFields`.
//     2. Drop the call in `validateOperationInput`.
//     3. Drop the matching test in `operation.test.ts`.
//     4. Flip `test/integration/catalog-live.integration.test.ts` to
//        require `status:'ok'` (remove `MCP_INVALID_RESPONSE` from
//        `KNOWN_UPSTREAM_ERRORS`).
// ════════════════════════════════════════════════════════════════════════════
export function patchKnownUpstreamSchemaDefects(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return schema
  const cloned: unknown = structuredClone(schema)
  walkPatternFields(cloned)
  return cloned
}

function walkPatternFields(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) walkPatternFields(item)
    return
  }
  if (!isPlainObject(node)) return
  if (typeof node.pattern === 'string' && node.pattern.startsWith('\\A')) {
    node.pattern = `^${node.pattern.slice(2)}`
  }
  for (const value of Object.values(node)) walkPatternFields(value)
}

function validateOperationInput(opts: {
  business: string
  capability: string
  toolName: string
  schema: unknown
  args: Record<string, unknown>
}): void {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)

  // TODO(upstream-fix): drop this patcher call once catalog.shopify.com
  // fixes `\A` → `^`. See banner above `patchKnownUpstreamSchemaDefects`.
  const schema = patchKnownUpstreamSchemaDefects(opts.schema)
  rejectUnknownPlainFields({
    business: opts.business,
    capability: opts.capability,
    toolName: opts.toolName,
    schema,
    args: opts.args,
  })
  let validate: ReturnType<typeof ajv.compile>
  try {
    validate = ajv.compile(schema as AnySchema)
  } catch (err) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.MCP_INVALID_RESPONSE,
      message: `business returned an invalid input schema for "${opts.toolName}"`,
      cause: err as Error,
      context: {
        business: opts.business,
        capability: opts.capability,
        tool: opts.toolName,
        schema: opts.schema,
      },
    })
  }

  if (validate(opts.args)) return

  const errors = validate.errors ?? []
  throw new UcpError({
    layer: 'client',
    code: ErrorCodes.SCHEMA_VALIDATION_FAILED,
    message: `operation input failed schema validation for "${opts.toolName}": ${formatAjvErrors(errors)}`,
    // `schema` is here so library callers (who get the raw UcpError) can
    // recover without a second `--input-schema` round-trip. The CLI surfaces a
    // recovery cta to agents on the wire envelope; the schema itself only
    // reaches the wire once incur supports passthrough of `error.context`
    // (today's incur strips it from the thrown-error catch path).
    context: {
      business: opts.business,
      capability: opts.capability,
      tool: opts.toolName,
      errors,
      input: opts.args,
      schema: opts.schema,
    },
  })
}

function rejectUnknownPlainFields(opts: {
  business: string
  capability: string
  toolName: string
  schema: unknown
  args: Record<string, unknown>
}): void {
  const unknown = findUnknownPlainFields(opts.schema, opts.args, '')
  if (unknown.length === 0) return

  throw new UcpError({
    layer: 'client',
    code: ErrorCodes.SCHEMA_VALIDATION_FAILED,
    message: `operation input contains unknown field${unknown.length === 1 ? '' : 's'} for "${opts.toolName}": ${formatUnknownFields(unknown)}. The business's advertised input schema does not list this field, and per client policy only listed fields plus reverse-DNS extension keys are sent (some canonical UCP fields are still spec-valid but require explicit business support). Run \`<op> --input-schema\` to see what this business actually accepts.`,
    context: {
      business: opts.business,
      capability: opts.capability,
      tool: opts.toolName,
      unknown_fields: unknown,
      input: opts.args,
      schema: opts.schema,
    },
  })
}

function formatUnknownFields(fields: string[]): string {
  const shown = fields.slice(0, 5).join(', ')
  if (fields.length <= 5) return shown
  return `${shown}, +${fields.length - 5} more`
}

function findUnknownPlainFields(schema: unknown, value: unknown, path: string): string[] {
  if (typeof schema === 'boolean') return []
  if (!isPlainObject(schema)) return []

  if (Array.isArray(value)) {
    const itemSchema = schema.items
    if (itemSchema === undefined) return []
    return value.flatMap((item, index) =>
      findUnknownPlainFields(itemSchema, item, joinJsonPath(path, index)),
    )
  }

  if (!isPlainObject(value)) return []

  // Intentionally conservative v0 pass: enforce closed plain-key policy on
  // object schemas that expose a direct `properties` map. Composed schemas
  // (`oneOf`/`anyOf`/`allOf`/`$ref`) still fall through to AJV. Extending this
  // walker to resolve composition is future work; do not silently mutate input.
  const properties = isPlainObject(schema.properties) ? schema.properties : undefined
  if (properties === undefined) return []

  const unknown: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const propertySchema = properties[key]
    if (propertySchema === undefined) {
      if (path === '' && key === 'meta') {
        unknown.push(...findUnknownPlainFields(protocolMetaExtensionSchema(), child, '/meta'))
        continue
      }
      if (isAllowedUnknownExtensionKey(path, key)) continue
      unknown.push(joinJsonPath(path, key))
      continue
    }
    unknown.push(...findUnknownPlainFields(propertySchema, child, joinJsonPath(path, key)))
  }
  return unknown
}

function protocolMetaExtensionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      'idempotency-key': { type: 'string' },
      'ucp-agent': { type: 'object' },
    },
  }
}

function isAllowedUnknownExtensionKey(path: string, key: string): boolean {
  // `meta.idempotency-key` is protocol-owned and injected by this dispatcher;
  // many business schemas omit it even when the protocol accepts it. All
  // caller-defined extension keys should be reverse-DNS names so typo-like
  // plain English aliases (`address_subdivision`, `zip_code`) fail fast.
  if (path === '/meta' && key === 'idempotency-key') return true
  return isReverseDnsKey(key)
}

function isReverseDnsKey(key: string): boolean {
  // Mirrors UCP spec `reverse_domain_name` exactly
  // (https://ucp.dev/2026-04-08/schemas/shopping/types/reverse_domain_name.json):
  // first segment [a-z][a-z0-9]*, one or more `.segment` where later segments
  // also allow `_`. Hyphens are not permitted by the spec; allowing them here
  // would let invalid keys pass our pre-flight guard only to be rejected by
  // the business's `propertyNames` validator at submission time.
  return /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/.test(key)
}

function joinJsonPath(base: string, segment: string | number): string {
  const escaped = String(segment).replaceAll('~', '~0').replaceAll('/', '~1')
  return `${base}/${escaped}`
}

function formatAjvErrors(errors: ErrorObject[]): string {
  if (errors.length === 0) return 'unknown validation error'
  return errors
    .slice(0, 3)
    .map((error) => `${error.instancePath || '<root>'}: ${error.message ?? error.keyword}`)
    .join('; ')
}
