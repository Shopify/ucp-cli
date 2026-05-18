// Protocol-surface types shared across the CLI.
//
// Scope is intentionally narrow: only the types that ride on the success/error
// envelope at the wire are owned here. Nothing in this file is plugin-protocol
// scaffolding — earlier drafts speculated a plugin envelope with `ok: true/false`
// at this layer, but the actual wire envelope is owned by incur (`c.ok` /
// `c.error`) and what we control is the `data`-slot payload that incur wraps.
//
// Cta + CtaBlock alignment with incur:
//   - `Cta` is re-exported from incur's `Cli` namespace. It's generic over
//     registered commands so `cta.command` is type-checked against actual
//     commands. Redefining would silently lose that.
//   - `CtaBlock` is the structural shape `c.ok({ cta: ... })` and
//     `c.error({ cta: ... })` emit on the wire — `commands[]` of cta's plus
//     an optional human-readable `description`. incur marks its internal type
//     `@internal`; we declare it here so the protocol surface has a stable name.
//
// ErrorLayer is the four-layer error taxonomy (application/escalation/
// transport/client). It travels on thrown `UcpError`s and is surfaced by the
// error envelope; the runtime tuple `ERROR_LAYERS` mirrors the enum for
// membership checks.

import type { Cli } from 'incur'

/**
 * Error-layer enum. Per PROTOCOL §4.2 consumers MUST treat unknown values
 * as `transport` (forward-compat). The runtime tuple {@link ERROR_LAYERS}
 * mirrors this and is the source of truth for membership checks.
 */
export type ErrorLayer = 'application' | 'escalation' | 'transport' | 'client'

/** Runtime tuple mirroring {@link ErrorLayer}. */
export const ERROR_LAYERS = [
  'application',
  'escalation',
  'transport',
  'client',
] as const satisfies readonly ErrorLayer[]

/** Wire-format transport names. */
export type Transport = 'rest' | 'mcp'

/**
 * Call-to-action. Mirrors incur's command-aware Cta so registered command
 * names are validated at the type level when CTAs are constructed.
 */
export type Cta = Cli.Cta

/**
 * Wire-format shape of `cta` on success and error envelopes. Mirrors what
 * incur's `c.ok` / `c.error` emit at the wire.
 */
export type CtaBlock = {
  /** One or more suggested follow-up commands. */
  commands: Cta[]
  /** Human-readable label. Defaults to "Suggested command(s):" if omitted. */
  description?: string
}

/**
 * Inner payload of a UCP success envelope. incur wraps this as
 * `{ ok: true, data: <this>, meta: { command, duration, cta? } }` on stdout.
 * Under `--mcp`, only this payload is emitted (stringified inside a content
 * block) — so its shape is what agents actually read in both transports.
 *
 * Field roles:
 *  - `business` / `endpoint` / `transport` — dispatch identity. Tells the
 *    agent which business URL, which endpoint, and which transport produced
 *    `result`. Value-comparable: the global-catalog detector decides handoff
 *    semantics by comparing `business` against the active profile's
 *    `meta.defaults.catalog`, without inventing a separate "source" tag.
 *  - `ucp` — protocol envelope hoisted out of the server response
 *    (capabilities, payment_handlers, negotiated version). Present only when
 *    the underlying response carried it.
 *  - `result` — operation payload. Named for JSON-RPC alignment (and to
 *    avoid the `data.data` nesting that incur's outer envelope would produce
 *    otherwise).
 *
 * `discover` is the only op that emits a payload without dispatch identity:
 * it negotiates many capabilities at once, so no single endpoint/transport
 * applies. Its payload type is the narrower {@link DiscoverPayload}.
 */
export type DispatchPayload<TData = unknown> = {
  business: string
  endpoint: string
  transport: Transport
  ucp?: Record<string, unknown>
  result: TData
}

/**
 * Payload shape for the bare `ucp discover` command. Unlike dispatch ops,
 * discover negotiates the full advertised capability set, so there is no
 * single endpoint/transport tuple to stamp at the envelope level — the
 * per-capability tuples live inside `result.negotiated`.
 */
export type DiscoverPayload<TData = unknown> = {
  result: TData
}
