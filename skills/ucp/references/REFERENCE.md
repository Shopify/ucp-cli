# UCP CLI — Reference

Lookup tables: error codes with recovery, common flags, response envelope shape, full message-type fields. Read the relevant subsection when the main SKILL.md sends you here (typically on error or when composing a non-trivial flag).

## Response envelope

Successful UCP operation responses have this shape:

```json
{
  "business":  "https://shop.example.com",
  "endpoint":  "https://shop.example.com/api/ucp/mcp",
  "transport": "mcp",
  "ucp":    { "capabilities": {...}, "payment_handlers": {...} },
  "result": { ...operation payload... },
  "cta":    { "description": "...", "commands": [...] }
}
```

- **`business` / `endpoint` / `transport`** — dispatch identity. Compare `business` against the active profile's `meta.defaults.catalog` to tell whether a catalog response came from the global catalog vs a specific merchant.
- **`result`** — the operation payload (products, cart, checkout, order).
- **`ucp`** — protocol metadata: negotiated capabilities and dynamic payment handlers. Read `ucp.payment_handlers` when composing a `payment` object for checkout.
- **`cta`** — what to do next. Always read `cta.description` first — it tells you what's possible and what to weigh, not what to mechanically execute. Pick the command that serves the buyer's goal. If none fit, stop or ask.

Errors: `{ "code": "...", "message": "...", "cta": {...} }` (no dispatch identity — failure may pre-date contact). Successful commands exit `0` (including `requires_escalation`); errors exit `1`.

## Error codes

Branch on `code` first; CTAs (when present) carry recovery suggestions.

| Code | Meaning | Recovery |
|---|---|---|
| `BUSINESS_NOT_RESOLVED` | Operation needs a merchant; none resolved | Pass `--business <url>`, or `ucp use <url>` for the session. Catalog operations fall back to the global catalog automatically. |
| `SCHEMA_VALIDATION_FAILED` | Payload doesn't match merchant's advertised schema, or uses unknown plain keys | Run `ucp <op> --input-schema --business <url>`, correct field names, re-submit. Some canonical UCP fields (e.g. `context.currency` per spec) may be valid but require explicit merchant support. |
| `OPERATION_NOT_OFFERED` | Merchant doesn't expose this operation | `ucp discover --business <url>` to see what's offered |
| `INVALID_INPUT` | CLI-side parse/validation error (bad JSON, missing required positional, malformed URL) | Check the message; usually self-explanatory |
| `PROFILE_FETCH_FAILED` | Merchant doesn't speak UCP (or `.well-known/ucp` is unreachable) | Surface to buyer; offer non-UCP fallback (other tools, navigation, alternate merchants with consent) |
| `PROFILE_NOT_FOUND` | No active agent profile | `ucp profile init --name <name>` (see `references/SETUP.md`) |
| `AUTH_REQUIRED` | Merchant requires authentication (HTTP 401) | This CLI doesn't implement merchant-specific auth (JWT, OAuth, API key). Handoff using the best prior URL: checkout/cart `continue_url`, then `variant.checkout_url`, then variant/product `url`, then `seller.url`, then `--business` URL or `https://<seller.domain>`. |
| `INSUFFICIENT_PERMISSIONS` | Authenticated but lacks required scope (HTTP 403) | Same recovery as `AUTH_REQUIRED` — handoff using the same URL priority. |
| `IDEMPOTENCY_CONFLICT` | Idempotency key reused with different payload (HTTP 409) | Re-issue with a fresh key, or omit and retry |
| `RATE_LIMITED` | Merchant rate-limited (HTTP 429) | Back off and retry; transient |
| `BUSINESS_SERVER_ERROR` | Merchant 5xx (HTTP 500-599 except 503) | Likely transient; retry |
| `SERVICE_UNAVAILABLE` | Merchant temporarily unable to handle requests (HTTP 503) | Wait and retry; transient |
| `MCP_RPC_ERROR` | JSON-RPC error envelope from merchant (no spec-aligned HTTP status) | Read `message` and `context.rpcCode` for merchant detail |
| `TRANSPORT_HTTP_ERROR` | Non-2xx HTTP without spec-aligned mapping | Read `http_status` from error context |
| `TRANSPORT_NETWORK_ERROR` | DNS, connection refused, TLS, timeout, abort | Network-level — agent should report and retry |

## `--set` and `--set-string` (overlay flags)

Primary payload composition is `--input '<json>'` against the schema returned by `ucp <op> --input-schema --business <url>`. `--set <path>=<value>` is a secondary mechanism that overlays a single value at a [JSON Pointer (RFC 6901)](https://datatracker.ietf.org/doc/html/rfc6901) path on top of `--input` — useful for one-off scalar overrides (e.g. flipping `/context/address_country=US` on top of an existing payload).

`--set-string <path>=<value>` is the same but forces string interpretation. Use it for numeric-looking strings (ZIP codes like `94105`, IDs like `12345`) when reaching for `--set`; without it, the value is JSON-parsed as a number and the merchant's schema rejects it as the wrong type. The same caveat applies to `--input` — keep numeric-looking strings quoted in JSON (`"postal_code":"94105"`, not `"postal_code":94105`).

For the full `--set` field-by-field composition syntax (array indices, the `-` append token, escape rules), see the [README's 60-second tour](../../../README.md#60-second-tour-for-carbon-life-forms) — that syntax is primarily a human-CLI shell ergonomic.

## Positional `<id>`

Ops that act on an **existing resource** take the id as the first positional argument; the id is **not** a body field — don't pass it via `--input` or `--set`.

| Op family | Positional |
|---|---|
| `cart get/update/cancel` | `<cart_id>` |
| `checkout get/update/complete/cancel` | `<checkout_id>` |
| `order get` | `<order_id>` |
| `catalog get_product` | `<product_id>` |

Operations that create or query (`cart create`, `checkout create`, `catalog search`, `catalog lookup`, `discover`) take no positional argument; the full payload goes in `--input`/`--set`. Cart-to-checkout conversion accepts `cart_id` in the `checkout create` body and requires `line_items`, which can be empty for conversion: `--input '{"cart_id":"<cart_id>","line_items":[]}'`. The merchant uses cart contents when `cart_id` is present. Forgetting the positional on a resource-addressing operation fails dispatch with `INVALID_INPUT` ("requires a positional id"); `--input-schema` works without it (it skips dispatch).

## Common flags (every operation)

| Flag | Effect |
|---|---|
| `--input '<json>'` | Operation payload as JSON; CLI wraps it for the wire. Unknown plain keys rejected client-side. |
| `--set <ptr>=<val>` | Field overlay onto `--input` (repeatable). RFC 6901 JSON Pointer paths. |
| `--set-string <ptr>=<val>` | Same, value treated as string. Use for ZIPs, IDs that look numeric, etc. |
| `--business <url>` | Override session merchant for this call. Bare hostnames (`shop.example.com`) are canonicalized to `https://`. |
| `--input-schema` | Print operation input schema; skip dispatch. Combine with `--business <url>` to introspect a specific merchant. |
| `--dry-run` | Build + validate request; print exactly what would be sent (including `meta.idempotency-key` and `meta.ucp-agent`). No network. Useful for debugging payloads before issuing them. |
| `--refresh` | Bypass discovery cache (force re-fetch of `.well-known/ucp` and `tools/list`) |
| `--format <fmt>` | Output format: `json` (default), `toon`, `yaml`, `md`, `jsonl` |
| `--view <expr\|@file\|:alias>` | JMESPath projection. Expression runs over the whole response envelope; output **replaces** the envelope (drop dispatch identity, slim `ucp`, reshape `result`, etc). Inline expression, `@<path>` to load from a file (`~` expanded), or `:<alias>` for a package-local view in the current operation capability. Composes with `--format` (project first, render second). `cta` survives the projection. No-op on `--dry-run`, `--input-schema`, and `--mcp` mode. See JMESPath patterns below. |
| `--on-escalation '<cmd>'` | Shell command for checkout `result.status === "requires_escalation"` only (compact JSON payload on stdin). Auth errors use CTA handoff guidance; they do not fire this hook. |

## JMESPath patterns for `--view`

The expression runs over the whole response envelope — root keys are `business`, `endpoint`, `transport`, `ucp`, `result`. The operation payload lives at `result.<...>`; reach into it explicitly. The view's output replaces the envelope; `cta` survives the projection separately. Package-local aliases resolve from the CLI package's `skills/ucp/views` directory under the current operation capability: `catalog search --view :compact` loads `catalog.compact.jmespath`, while `catalog search --view :cart.summary` looks for `catalog.cart.summary.jmespath` and errors if absent. Use `@<path>` for custom or edited files, including files from a synced agent skill directory. The files in `views/` next to this reference are shape references; compose your own for what THIS call needs.

| Pattern | Effect |
|---|---|
| `field` / `a.b.c` | Pluck a field / nested path (`result.id`, `ucp.version`) |
| `[*]` / `a[*].b` | Project over every element of an array (`result.products[*].title`) |
| `` [?expr] `` | Filter; numeric literals need backticks (`` result.products[?price_range.min.amount<`5000`] ``, `` result.totals[?type==`"total"`] ``) |
| `[N]` / `[N:M]` | Index / slice (`variants[0]`, `result.products[:5]`) |
| `sort_by(@, &expr)` | Sort by an expression (`sort_by(result.products, &price_range.min.amount)`) |
| `length(@)` | Count elements (`length(result.products)`) |
| `min(...)` / `max(...)` | Reduce (`min(result.products[*].price_range.min.amount)`) |
| `{a: x, b: y}` | Build a multi-key object (the projection shape used by `views/*.jmespath`) |
| `expr \| [0]` | Pipe — take the first match of a filter (`` result.totals[?type==`"total"`] \| [0].amount ``) |

String literals: use backticks with a JSON value (`` `"total"` ``) OR JMESPath single-quoted raw strings (`'total'`); both work in filter predicates. `--view` rejects malformed expressions before any network call (`INVALID_INPUT`), so a typo surfaces immediately instead of after a paid round-trip.

## Schema-first payload diagnostics

Use `--input-schema` before any non-trivial payload (fulfillment, discounts, buyer identity, payment, merchant extensions). Missing response data usually means missing trigger input, not proof the surface cannot produce it.

For fulfillment, use this model. In update payloads, `line_items[].id` is the line item id for targeting an existing cart/checkout line; `line_items[].item.id` is the underlying item/variant id. Do not swap them. Full payload examples are in `FULFILLMENT.md`.

| Surface | Meaning |
|---|---|
| `context` | Soft localization/ranking/currency hints. Do not rely on `context.postal_code` for shipping calculation. |
| cart + `fulfillment.methods[].destinations[]` | Merchant-provided shipping/fulfillment estimates when the cart schema accepts those fields. Useful before checkout/auth. |
| checkout + fulfillment update | Full-fidelity shipping/pickup option map, selected option ids/handles, and final pre-completion fulfillment totals. |

A checkout `AUTH_REQUIRED` / `INSUFFICIENT_PERMISSIONS` gate does not invalidate earlier cart-stage data. Preserve cart ids, selected variants, estimates, discounts, messages, and totals before handing the buyer off.

## Messages — full per-type reference

`result.messages[]` carries info, warnings, and errors. The display contract is in the main SKILL.md (`Display contract for messages`); this is the field-level reference.

### `info` (`type: "info"`)

Required: `type`, `content`.
Optional: `code` (free-form), `path` (RFC 9535 JSONPath to the related field), `content_type` (`plain` default, or `markdown`).

### `warning` (`type: "warning"`)

Required: `type`, `code`, `content`.
Optional: `path`, `content_type`, `presentation` (`notice` default, or `disclosure`), `image_url` (URL to a required visual element), `url` (reference link for more info).

`presentation` controls the display obligation; see the SKILL.md table.

### `error` (`type: "error"`) — error processing priority

Required: `type`, `code`, `content`, `severity`.
Optional: `path`, `content_type`.

When the response status is `incomplete` or `requires_escalation`, process errors in this priority order (spec-required):

| Priority | Severity | Action |
|---|---|---|
| 1 | `unrecoverable` | No valid resource to act on. Start a new checkout. |
| 2 | `recoverable` | Platform can fix via API (e.g., reformat phone, drop OOS item). Fix via `checkout update`, then re-evaluate — **do this before any buyer handoff.** |
| 3 | `requires_buyer_input` | Checkout is incomplete; merchant needs info their API doesn't collect programmatically. Hand off to `result.continue_url`. |
| 4 | `requires_buyer_review` | Checkout is complete; buyer authorizes order placement (e.g., high-value approval). Hand off to `result.continue_url`. |
