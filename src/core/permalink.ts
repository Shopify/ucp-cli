// `dev.ucp.shopping.permalink` URL builder.
//
// A permalink is a browser-addressable shopping intent (UCP 2026-08-25,
// specification/permalink): a GET navigation the Business resolves by
// initializing shopping state (cart, checkout, session) and answering `303
// See Other` to a buyer-facing page. It is NOT a REST/MCP operation — nothing
// here touches the network. Discovery supplies `config.endpoint`; this module
// turns a cart-create-shaped body into
//
//   <endpoint>/<item_token>:<qty>[,<item_token>:<qty>…]?<pointer>=<value>&…
//
// Mapping rules (spec §URL grammar):
//   - `line_items[N].item.id` + `line_items[N].quantity` become the compact
//     item path, which is authoritative for ids and quantities. Query fields
//     can never set either, so those two are consumed here and refused as
//     query paths.
//   - Every other body field becomes a query key: its JSON Pointer path with
//     the leading `/` omitted (`discounts/codes/0=SPRING10`). This is the same
//     pointer grammar `--set` already speaks, so `--set /context/postal_code=…`
//     lands as `context/postal_code=…`.
//   - Item ids matching `^[A-Za-z0-9._-]+$` go raw; anything else (Shopify
//     GIDs carry `:` and `/`) goes as `~` + unpadded base64url of the UTF-8
//     id. Percent-encoding is not allowed for item tokens.
//
// Client policy (refusals, all INVALID_INPUT): the spec forbids payment
// credentials, tokens, and secrets in permalinks and says server-owned fields
// cannot be set from the URL. A business would consume-and-drop most of these,
// but a permalink is a shareable string — once a secret is in it, it leaks to
// every hop that sees the URL. So the CLI refuses before the URL exists:
//   - top-level `payment` and any `context/payment/N/*` other than `handler`
//   - server-owned paths: id, status, totals, messages, links, order, …
//   - any path segment that names a credential (token, secret, password, …)
//   - `buyer/*` unless the caller opts in (spec: buyer prefill only for
//     buyer-directed links, never broadly shared ones)
//
// Malformed links are refused too, because a Business answers them with a
// plain fallback redirect and no cart — and when `continue_to` is set the
// buyer lands on that page, so the failure looks like success. Checked
// against Shopify's /buy parser: control characters anywhere, a Shopify GID
// that is not a ProductVariant, a URL over 2048 octets, empty or duplicate
// keys (a body `continue_to` next to --continue-to), and a --continue-to with
// a query string all produce a link that silently loses the cart or a field.

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { findUnknownPlainFields } from './operation.js'

export const PERMALINK_CAPABILITY = 'dev.ucp.shopping.permalink'

/** Spec `$defs/endpoint` pattern (permalink.json, 2026-08-25), verbatim. */
const ENDPOINT_PATTERN = /^https:\/\/[^/?#\s\\@]+(?:\/[^?#\s\\]*[^/?#\s\\])?$/

const RAW_ITEM_TOKEN = /^[A-Za-z0-9._-]+$/

// Spec: a Business rejects item ids, field names, and values containing
// control characters. Shopify's /buy matches `[[:cntrl:]]` (Unicode Cc).
const CONTROL_CHARACTER = /\p{Cc}/u

// Shopify resolves only ProductVariant GIDs (or bare numeric variant ids);
// a Product GID — the easy one to copy from catalog results — yields no cart.
const SHOPIFY_GID_TYPE = /^gid:\/\/shopify\/([^/]+)\//

/**
 * Spec URL budgets (recommended maximums, UTF-8 octets). Ordered smallest
 * first so `fits` reads tightest-channel-first.
 */
export const PERMALINK_BUDGETS = [
  { channel: 'qr', octets: 512 },
  { channel: 'sms', octets: 1024 },
  { channel: 'email', octets: 2048 },
] as const

// The spec's largest budget is also a hard limit in practice: Shopify's /buy
// answers a longer URL with its fallback redirect and builds no cart.
const MAX_URL_OCTETS = 2048

export type PermalinkChannel = (typeof PERMALINK_BUDGETS)[number]['channel']

// Top-level request paths the Business owns. Refused rather than sent so a
// caller who pastes a cart RESPONSE (ids, totals, status) as the body gets an
// actionable error instead of a link the business silently trims.
const SERVER_OWNED_TOP_LEVEL = new Set([
  'id',
  'status',
  'totals',
  'messages',
  'links',
  'order',
  'continue_url',
  'expires_at',
  'ucp',
  'meta',
])
const SERVER_OWNED_LINE_ITEM = new Set(['id', 'totals'])

// Matched against each path segment, case-insensitively. Deliberately broad:
// a false positive costs one rename; a false negative ships a credential in a
// URL that gets pasted into chats, logs, and analytics.
const CREDENTIAL_SEGMENT =
  /token|secret|password|passwd|credential|api[_-]?key|authorization|mandate|cookie/i

export interface PermalinkItem {
  /** The id as supplied (`line_items[N].item.id`). */
  id: string
  quantity: number
  /** The compact-path token actually emitted (raw or `~base64url`). */
  token: string
}

export interface BuiltPermalink {
  url: string
  /** The Business's advertised `config.endpoint` the URL was built on. */
  endpoint: string
  items: PermalinkItem[]
  /** Query keys emitted, as unescaped pointer paths (no leading `/`), in URL order. */
  fields: string[]
  /** UTF-8 octet length of `url`. */
  octets: number
  /** Spec budgets the URL fits within, tightest first. Never empty: longer URLs are refused. */
  fits: PermalinkChannel[]
  /** True when `buyer/*` fields are present — only for buyer-directed channels. */
  buyer_prefill: boolean
}

export interface BuildPermalinkOptions {
  endpoint: string
  /** Cart-create-shaped body: `{ line_items: [{ item: { id }, quantity }], …fields }`. */
  body: Record<string, unknown>
  /** Same-origin path the Business should land the buyer on (`continue_to`). */
  continueTo?: string
  /** Permit `buyer/*` prefill fields. Off by default. */
  allowBuyerPrefill?: boolean
}

/** Validated items and query fields, before an endpoint is known. */
export interface PreparedPermalink {
  items: PermalinkItem[]
  query: Array<[path: string[], value: string]>
  buyerPrefill: boolean
}

export function buildPermalink(options: BuildPermalinkOptions): BuiltPermalink {
  return assemblePermalink(options.endpoint, preparePermalink(options))
}

/**
 * Apply every input refusal without an endpoint, so a caller can reject a bad
 * body before discovery makes a network round-trip.
 */
export function preparePermalink(
  options: Omit<BuildPermalinkOptions, 'endpoint'>,
): PreparedPermalink {
  const { line_items: lineItems, ...rest } = options.body
  const items = compactItems(lineItems)

  const query: Array<[path: string[], value: string]> = []
  if (options.continueTo !== undefined) {
    query.push([['continue_to'], validateContinueTo(options.continueTo)])
  }
  // Non-id line-item fields (e.g. a profile-defined `selling_plan`) ride as
  // `line_items/N/<field>` query paths; ids and quantities stay in the path.
  if (Array.isArray(lineItems)) {
    lineItems.forEach((line, index) => {
      const { item, quantity: _quantity, ...lineRest } = line as Record<string, unknown>
      const { id: _id, ...itemRest } = isPlainObject(item) ? item : {}
      flatten(lineRest, ['line_items', String(index)], query)
      flatten(itemRest, ['line_items', String(index), 'item'], query)
    })
  }
  // Top-level keys are policy-checked on their own, not only via the leaves
  // `flatten` emits: `"payment": {"instruments": []}` flattens to nothing,
  // but a caller that sends a payment (or totals, or a token) block at all has
  // pasted the wrong document and should hear about it.
  for (const key of Object.keys(rest)) {
    if (key === 'continue_to') {
      // Not a cart field, and a second `continue_to` next to --continue-to is
      // a duplicate key the spec forbids (Shopify then drops both).
      throw invalid('continue_to is not a body field; pass the landing path with --continue-to')
    }
    assertAllowedPath([key], options.allowBuyerPrefill === true)
  }
  flatten(rest, [], query)

  let buyerPrefill = false
  for (const [path] of query) {
    if (path[0] === 'buyer') buyerPrefill = true
    assertAllowedPath(path, options.allowBuyerPrefill === true)
  }
  return { items, query, buyerPrefill }
}

export function assemblePermalink(endpoint: string, prepared: PreparedPermalink): BuiltPermalink {
  if (!isPermalinkEndpoint(endpoint)) {
    // Callers pass the business-advertised value; a bad one is a merchant
    // document defect, and `resolvePermalinkEndpoint` reports it as such.
    // Reaching here means a library caller passed its own string.
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `permalink endpoint must be an absolute https URL without query, fragment, userinfo, or trailing slash (got ${JSON.stringify(endpoint)})`,
    })
  }

  const { items, query } = prepared
  const itemPath = items.map((i) => `${i.token}:${i.quantity}`).join(',')
  const search = query
    .map(([path, value]) => `${path.map(encodeKeySegment).join('/')}=${encodeQueryValue(value)}`)
    .join('&')
  const url = `${endpoint}/${itemPath}${search.length > 0 ? `?${search}` : ''}`
  const octets = Buffer.byteLength(url, 'utf8')
  if (octets > MAX_URL_OCTETS) {
    throw invalid(
      `the link is ${octets} octets, over the ${MAX_URL_OCTETS}-octet maximum; businesses such as Shopify open longer links without a cart. Drop optional fields or split the items across links`,
    )
  }

  return {
    url,
    endpoint,
    items,
    fields: query.map(([path]) => path.join('/')),
    octets,
    fits: PERMALINK_BUDGETS.filter((b) => octets <= b.octets).map((b) => b.channel),
    buyer_prefill: prepared.buyerPrefill,
  }
}

/**
 * Compact-path token for one item id: raw when it already fits the token
 * grammar, otherwise `~` + unpadded base64url of its UTF-8 bytes.
 */
export function encodeItemToken(id: string): string {
  if (RAW_ITEM_TOKEN.test(id)) return id
  return `~${Buffer.from(id, 'utf8').toString('base64url')}`
}

export function isPermalinkEndpoint(value: unknown): value is string {
  return typeof value === 'string' && ENDPOINT_PATTERN.test(value) && URL.canParse(value)
}

/**
 * Body fields the business's create_cart schema does not list, as permalink
 * query paths in the same spelling as `BuiltPermalink.fields`. The permalink
 * spec applies "only fields its Cart or Checkout schema accepts" and consumes
 * the rest silently — live on rothys.com, `discount_codes/0=…` and
 * `discounts/codes/0=…` both 303 to a cart, only one of them with the
 * discount — so this is the only place a typo can surface. create_cart (not
 * create_checkout) is the reference because checkout adds only `payment` and
 * `cart_id`, neither of which belongs in a permalink.
 *
 * Two differences from operation dispatch: reverse-DNS extension keys are not
 * waved through, since the business drops any field its schema does not list
 * (Shopify: FieldPathParser#ucp_root?); and `context/payment/<n>/handler` is
 * skipped, since the permalink capability defines it, not the cart schema.
 *
 * Returns `undefined` when the schema has no inspectable `cart.properties`.
 */
export function unrecognizedPermalinkFields(opts: {
  createCartInputSchema: unknown
  body: Record<string, unknown>
}): string[] | undefined {
  const root = opts.createCartInputSchema
  const cart =
    isPlainObject(root) && isPlainObject(root.properties) ? root.properties.cart : undefined
  if (!isPlainObject(cart) || !isPlainObject(cart.properties)) return undefined
  return findUnknownPlainFields(cart, withoutPaymentHandler(opts.body), '', NO_EXTENSION_KEYS).map(
    (pointer) =>
      pointer
        .slice(1)
        .split('/')
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
        .join('/'),
  )
}

const NO_EXTENSION_KEYS = /(?!)/

function withoutPaymentHandler(body: Record<string, unknown>): Record<string, unknown> {
  const { context } = body
  if (!isPlainObject(context) || !Object.hasOwn(context, 'payment')) return body
  const { payment: _payment, ...contextRest } = context
  return { ...body, context: contextRest }
}

/**
 * Read `config.endpoint` for the permalink capability from a negotiated
 * business rendering. Exact-version only (the repo-wide rule: compatibility is
 * never inferred from date order): the entry must repeat the rendering's own
 * `ucp.version`.
 */
export function resolvePermalinkEndpoint(opts: {
  capabilities: unknown
  version: string
  business: string
}): { endpoint: string; version: string } {
  const entries =
    isPlainObject(opts.capabilities) && Object.hasOwn(opts.capabilities, PERMALINK_CAPABILITY)
      ? opts.capabilities[PERMALINK_CAPABILITY]
      : undefined
  const atVersion = Array.isArray(entries)
    ? entries.filter((e) => isPlainObject(e) && e.version === opts.version)
    : []
  if (atVersion.length === 0) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.CAPABILITY_NOT_OFFERED,
      message: `business does not advertise capability "${PERMALINK_CAPABILITY}" at UCP ${opts.version}; hand the buyer a product url or cart/checkout continue_url instead`,
      context: { business: opts.business, capability: PERMALINK_CAPABILITY },
    })
  }
  const entry = atVersion[0] as Record<string, unknown>
  const endpoint = isPlainObject(entry.config) ? entry.config.endpoint : undefined
  if (!isPermalinkEndpoint(endpoint)) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.PROFILE_SCHEMA_INVALID,
      message: `business advertises "${PERMALINK_CAPABILITY}" without a valid config.endpoint (must be an absolute https URL without query, fragment, userinfo, or trailing slash): ${JSON.stringify(endpoint)}`,
      context: { business: opts.business, capability: PERMALINK_CAPABILITY, entry },
    })
  }
  return { endpoint, version: opts.version }
}

// ─── internals ───────────────────────────────────────────────────────────────

function compactItems(lineItems: unknown): PermalinkItem[] {
  // v0: at least one item. The spec also defines a bare `GET <endpoint>`
  // (continue_to / context only), but live Shopify storefronts answer it with
  // 404, and an item-less link is easy to add later and hard to take back.
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw invalid(
      'permalink needs at least one line item: --input \'{"line_items":[{"item":{"id":"<variant_id>"},"quantity":1}]}\'',
    )
  }
  return lineItems.map((line, index) => {
    const item = isPlainObject(line) ? line.item : undefined
    const id = isPlainObject(item) ? item.id : undefined
    if (typeof id === 'number') {
      // `--set /line_items/0/item/id=42103178002526` JSON-parses to a number.
      throw invalid(
        `line_items/${index}/item/id must be a string; pass numeric ids with --set-string (e.g. --set-string /line_items/${index}/item/id=${id})`,
      )
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw invalid(`line_items/${index}/item/id must be a non-empty item (variant) id`)
    }
    if (CONTROL_CHARACTER.test(id)) {
      throw invalid(`line_items/${index}/item/id contains a control character`)
    }
    const gidType = SHOPIFY_GID_TYPE.exec(id)?.[1]
    if (gidType !== undefined && gidType !== 'ProductVariant') {
      throw invalid(
        `line_items/${index}/item/id is a Shopify ${gidType} id; permalinks take variant ids (variants[M].id from catalog results), and any other id opens without a cart`,
      )
    }
    const quantity = (line as Record<string, unknown>).quantity
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw invalid(
        `line_items/${index}/quantity must be a positive integer (got ${JSON.stringify(quantity)})`,
      )
    }
    return { id, quantity, token: encodeItemToken(id) }
  })
}

function flatten(value: unknown, path: string[], out: Array<[string[], string]>): void {
  if (value === null || value === undefined) {
    if (path.length > 0) throw invalid(`${path.join('/')} is null; omit the field instead`)
    return
  }
  if (Array.isArray(value)) {
    for (const [i, child] of value.entries()) flatten(child, [...path, String(i)], out)
    return
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key]
      if (key.length === 0) throw invalid(`${childPath.join('/')} has an empty field name`)
      if (CONTROL_CHARACTER.test(key)) {
        throw invalid(`${JSON.stringify(childPath.join('/'))} contains a control character`)
      }
      flatten(child, childPath, out)
    }
    return
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    // `--set` JSON-parses its value, so `=1.50` arrives as 1.5 and a long
    // numeric code loses digits; the link would carry the changed value.
    throw invalid(
      `${path.join('/')} is the JSON number ${value}, which may not be what was typed; pass it as a string (--set-string /${path.join('/')}=…)`,
    )
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value)
    if (text.length === 0) throw invalid(`${path.join('/')} is empty; omit the field instead`)
    if (CONTROL_CHARACTER.test(text)) {
      // A newline or tab makes the whole link malformed, not just this field.
      throw invalid(
        `${path.join('/')} contains a control character (newline, tab, …); businesses reject the whole link`,
      )
    }
    out.push([path, text])
    return
  }
  throw invalid(`${path.join('/')} has an unsupported value type (${typeof value})`)
}

function assertAllowedPath(path: string[], allowBuyerPrefill: boolean): void {
  const display = path.join('/')
  const [head] = path
  if (head === 'payment') {
    throw invalid(
      `${display}: payment instruments and credentials must never appear in a permalink; at most a handler preference via context/payment/<n>/handler`,
    )
  }
  if (
    head === 'context' &&
    path[1] === 'payment' &&
    !(path.length === 4 && path[3] === 'handler')
  ) {
    throw invalid(`${display}: only context/payment/<n>/handler (a handler preference) is allowed`)
  }
  if (head !== undefined && SERVER_OWNED_TOP_LEVEL.has(head)) {
    throw invalid(
      `${display}: server-owned fields cannot be set from a permalink — pass a request-shaped body (line_items, context, discounts, …), not a cart/checkout response`,
    )
  }
  if (head === 'line_items' && path[2] !== undefined && SERVER_OWNED_LINE_ITEM.has(path[2])) {
    throw invalid(`${display}: server-owned line item fields cannot be set from a permalink`)
  }
  const credential = path.find((segment) => CREDENTIAL_SEGMENT.test(segment))
  if (credential !== undefined) {
    throw invalid(
      `${display}: "${credential}" looks like a credential; tokens, secrets, and API keys must never appear in a permalink`,
    )
  }
  if (head === 'buyer' && !allowBuyerPrefill) {
    throw invalid(
      `${display}: buyer prefill is off by default because permalinks get shared, logged, and forwarded; pass --allow-buyer-prefill only for a link sent directly to that buyer`,
    )
  }
}

function validateContinueTo(value: string): string {
  // Same-origin path only (spec): `/collections/spring`, never a scheme,
  // protocol-relative `//host`, or backslash tricks. The Business validates
  // again server-side; this just fails fast on the obvious cases. Queries are
  // refused too: Shopify keeps continue_to path-only and drops them silently.
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\s#?]/.test(value) ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw invalid(
      `--continue-to must be a same-origin path with no query string or fragment, such as /collections/flats (got ${JSON.stringify(value)})`,
    )
  }
  return value
}

// JSON Pointer escape (RFC 6901: `~` → `~0`, `/` → `~1`) so a key containing
// `/` stays one segment, then percent-encode for the query component.
function encodeKeySegment(segment: string): string {
  return encodeURIComponent(segment.replaceAll('~', '~0').replaceAll('/', '~1'))
}

// `/` is legal unescaped in a query component (RFC 3986 §3.4) and the spec's
// own examples write `continue_to=/collections/spring`; keeping it readable
// also saves octets against the QR/SMS budgets. Everything else follows
// encodeURIComponent (`@` → `%40`, as in the spec's buyer/email example).
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replaceAll('%2F', '/')
}

function invalid(message: string): UcpError {
  return new UcpError({ layer: 'client', code: ErrorCodes.INVALID_INPUT, message })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
